import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

// Production GA4 property "beattronome-ea8b2".
const GA4_PROPERTY_ID = "353313516";
const UNINSTALLS_COLLECTION = "ga4_uninstalls";
const EVENTS_DAILY_COLLECTION = "ga4_events_daily";
const USERS_DAILY_COLLECTION = "ga4_users_daily";

// GA4 finalises data over ~24-48h, so we re-fetch the last few days each run.
const DAILY_LOOKBACK_DAYS = 3;

// GA4 automatically-collected / enhanced-measurement / ads / messaging events.
// Excluded so the "top events" list shows only the app's own custom events.
const AUTOMATIC_EVENTS = new Set<string>([
  "first_open", "first_visit", "session_start", "user_engagement",
  "screen_view", "app_remove", "app_update", "app_clear_data", "os_update",
  "app_exception", "page_view", "scroll", "click", "view_search_results",
  "video_start", "video_progress", "video_complete", "file_download",
  "form_start", "form_submit", "in_app_purchase",
  "app_store_subscription_convert", "app_store_subscription_renew",
  "app_store_subscription_cancel", "app_store_refund",
  "ad_impression", "ad_click", "ad_query", "ad_exposure", "ad_activeview",
  "ad_reward", "ad_no_fill", "notification_receive", "notification_open",
  "notification_dismiss", "notification_foreground", "notification_send",
  "dynamic_link_app_open", "dynamic_link_first_open",
  "dynamic_link_app_update", "firebase_campaign",
  "firebase_in_app_message_action", "firebase_in_app_message_dismiss",
  "firebase_in_app_message_impression",
]);

// Reused across warm invocations. Uses Application Default Credentials — grant
// the function's runtime service account "Viewer" on the GA4 property.
let analyticsClient: BetaAnalyticsDataClient | null = null;
function client(): BetaAnalyticsDataClient {
  analyticsClient ??= new BetaAnalyticsDataClient();
  return analyticsClient;
}

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// GA4 `date` dimension comes back as "YYYYMMDD".
function ga4DateToYmd(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** Uninstalls (`app_remove`) per day. Android only — iOS does not report it. */
async function fetchUninstallsByDate(
  startYmd: string,
  endYmd: string,
): Promise<Map<string, number>> {
  const [resp] = await client().runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    dateRanges: [{ startDate: startYmd, endDate: endYmd }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        stringFilter: { matchType: "EXACT", value: "app_remove" },
      },
    },
  });
  const byDate = new Map<string, number>();
  for (const row of resp.rows ?? []) {
    const rawDate = row.dimensionValues?.[0]?.value;
    const count = Number(row.metricValues?.[0]?.value ?? "0");
    if (!rawDate) continue;
    byDate.set(ga4DateToYmd(rawDate), count);
  }
  return byDate;
}

/** Per-day counts for each custom event (automatic events excluded). */
async function fetchCustomEventsByDate(
  startYmd: string,
  endYmd: string,
): Promise<Map<string, Record<string, number>>> {
  const [resp] = await client().runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    dateRanges: [{ startDate: startYmd, endDate: endYmd }],
    dimensions: [{ name: "date" }, { name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    limit: 100000,
  });
  const byDate = new Map<string, Record<string, number>>();
  for (const row of resp.rows ?? []) {
    const rawDate = row.dimensionValues?.[0]?.value;
    const eventName = row.dimensionValues?.[1]?.value;
    const count = Number(row.metricValues?.[0]?.value ?? "0");
    if (!rawDate || !eventName) continue;
    if (AUTOMATIC_EVENTS.has(eventName)) continue;
    const date = ga4DateToYmd(rawDate);
    const day = byDate.get(date) ?? {};
    day[eventName] = (day[eventName] ?? 0) + count;
    byDate.set(date, day);
  }
  return byDate;
}

interface DailyUsers {
  activeUsers: number;
  newUsers: number;
  totalUsers: number;
}

/** Active/new/total users per day — GA4's own rolling definitions, not a
 * custom derivation. `totalUsers` counts anyone active in the requested
 * range at all, so it isn't `activeUsers` summed across days. */
async function fetchUsersByDate(
  startYmd: string,
  endYmd: string,
): Promise<Map<string, DailyUsers>> {
  const [resp] = await client().runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    dateRanges: [{ startDate: startYmd, endDate: endYmd }],
    dimensions: [{ name: "date" }],
    metrics: [
      { name: "activeUsers" },
      { name: "newUsers" },
      { name: "totalUsers" },
    ],
  });
  const byDate = new Map<string, DailyUsers>();
  for (const row of resp.rows ?? []) {
    const rawDate = row.dimensionValues?.[0]?.value;
    if (!rawDate) continue;
    byDate.set(ga4DateToYmd(rawDate), {
      activeUsers: Number(row.metricValues?.[0]?.value ?? "0"),
      newUsers: Number(row.metricValues?.[1]?.value ?? "0"),
      totalUsers: Number(row.metricValues?.[2]?.value ?? "0"),
    });
  }
  return byDate;
}

async function syncRange(startYmd: string, endYmd: string): Promise<{
  uninstallDays: number;
  eventDays: number;
  userDays: number;
}> {
  const [uninstalls, events, users] = await Promise.all([
    fetchUninstallsByDate(startYmd, endYmd),
    fetchCustomEventsByDate(startYmd, endYmd),
    fetchUsersByDate(startYmd, endYmd),
  ]);

  const db = getFirestore();
  const batch = db.batch();

  const uninstallsCol = db.collection(UNINSTALLS_COLLECTION);
  for (const [date, count] of uninstalls.entries()) {
    batch.set(
      uninstallsCol.doc(date),
      { date, count, fetched_at: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  const eventsCol = db.collection(EVENTS_DAILY_COLLECTION);
  for (const [date, eventCounts] of events.entries()) {
    // Overwrite the day's events with the freshly-fetched totals.
    batch.set(eventsCol.doc(date), {
      date,
      events: eventCounts,
      fetched_at: FieldValue.serverTimestamp(),
    });
  }

  const usersCol = db.collection(USERS_DAILY_COLLECTION);
  for (const [date, counts] of users.entries()) {
    batch.set(
      usersCol.doc(date),
      { date, ...counts, fetched_at: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }

  await batch.commit();
  return {
    uninstallDays: uninstalls.size,
    eventDays: events.size,
    userDays: users.size,
  };
}

function lookbackRange(): { startYmd: string; endYmd: string } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - DAILY_LOOKBACK_DAYS);
  return { startYmd: ymd(start), endYmd: ymd(now) };
}

export const syncGa4 = onSchedule(
  {
    schedule: "every day 07:00",
    timeZone: "Etc/UTC",
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const { startYmd, endYmd } = lookbackRange();
    logger.info("syncGa4: fetching", { startYmd, endYmd });
    const result = await syncRange(startYmd, endYmd);
    logger.info("syncGa4: done", result);
  },
);

// Dashboard "sync now" button + optional backfill. Pass {from, to} (YYYY-MM-DD)
// to backfill an arbitrary range; otherwise re-fetches the lookback window.
export const syncGa4Now = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const db = getFirestore();
    const adminDoc = await db.collection("users_bo").doc(uid).get();
    if (!adminDoc.exists) {
      throw new HttpsError("permission-denied", "Backoffice users only.");
    }

    const data = (request.data ?? {}) as { from?: string; to?: string };
    const fromArg = data.from;
    const toArg = data.to;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let startYmd: string;
    let endYmd: string;
    if (fromArg && toArg) {
      if (!dateRe.test(fromArg) || !dateRe.test(toArg)) {
        throw new HttpsError(
          "invalid-argument",
          "from/to must be YYYY-MM-DD",
        );
      }
      startYmd = fromArg;
      endYmd = toArg;
    } else {
      ({ startYmd, endYmd } = lookbackRange());
    }

    logger.info("syncGa4Now: triggered", { uid, startYmd, endYmd });
    const result = await syncRange(startYmd, endYmd);
    return { ...result, from: startYmd, to: endYmd };
  },
);

/** Active users right now (GA4's realtime window — the last ~30 minutes),
 * plus a top-5 breakdown by country. Unlike everything else in this file,
 * this is NOT synced into Firestore on a schedule — realtime numbers going
 * through a once-a-day batch job would defeat the point. The dashboard
 * calls this callable directly, live, whenever the realtime card wants a
 * fresh read. */
export const getGa4Realtime = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Sign in required.");
    }
    const db = getFirestore();
    const adminDoc = await db.collection("users_bo").doc(uid).get();
    if (!adminDoc.exists) {
      throw new HttpsError("permission-denied", "Backoffice users only.");
    }

    const [totalResp, countryResp] = await Promise.all([
      client().runRealtimeReport({
        property: `properties/${GA4_PROPERTY_ID}`,
        metrics: [{ name: "activeUsers" }],
      }),
      client().runRealtimeReport({
        property: `properties/${GA4_PROPERTY_ID}`,
        dimensions: [{ name: "country" }],
        metrics: [{ name: "activeUsers" }],
        orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
        limit: 5,
      }),
    ]);

    const activeUsers = Number(
      totalResp[0].rows?.[0]?.metricValues?.[0]?.value ?? "0",
    );
    const byCountry = (countryResp[0].rows ?? []).map((row) => ({
      country: row.dimensionValues?.[0]?.value ?? "Unknown",
      activeUsers: Number(row.metricValues?.[0]?.value ?? "0"),
    }));

    logger.info("getGa4Realtime: fetched", { uid, activeUsers });
    return { activeUsers, byCountry };
  },
);
