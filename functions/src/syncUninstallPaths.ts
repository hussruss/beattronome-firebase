import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { BigQuery } from "@google-cloud/bigquery";
import { median, tally, utcYmd } from "./parsing";

// "What did users do right before uninstalling?" — read from the GA4
// BigQuery export (one row per event, per user), which the GA4 Data API
// can't answer. Android only: iOS never reports `app_remove`.
//
// Needs GA4 Admin → BigQuery links set up (daily export) for property
// 353313516 into this project. The export has no history before the link
// date, so this can't backfill past it.
const GA4_PROPERTY_ID = "353313516";
const DATASET = `analytics_${GA4_PROPERTY_ID}`;
const COLLECTION = "ga4_uninstall_paths_daily";

// Daily export tables keep receiving late events for ~72h.
const DAILY_LOOKBACK_DAYS = 3;
// How far back from the uninstall to look for the user's events.
const HISTORY_DAYS = 30;
// Last N events kept per user for the "last actions" breakdown.
const LAST_EVENTS = 10;

// Automatic GA4 events that fire on every screen/session and would drown
// out the app's own signal in a "last actions" list.
const NOISE_EVENTS = [
  "app_remove", "user_engagement", "screen_view", "session_start",
  "firebase_campaign", "os_update", "app_update",
];
const AD_EVENTS = ["ad_trigger_shown", "ad_impression"];
const MODE_EVENTS: Record<string, string> = {
  basic_mode: "basic",
  advance_mode: "advance",
  rudiments_mode: "rudiments",
  patterns_mode: "patterns",
  two_pizzas_mode: "twoPizzas",
  groove_mode: "groove",
};

let bigQueryClient: BigQuery | null = null;
function bq(): BigQuery {
  bigQueryClient ??= new BigQuery();
  return bigQueryClient;
}

function addDays(dayYmd: string, days: number): string {
  const d = new Date(`${dayYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcYmd(d);
}

const suffix = (dayYmd: string): string => dayYmd.replace(/-/g, "");

interface UninstallRow {
  removed_at: number;
  first_touch: number | null;
  sessions: number;
  ads_24h: number;
  crashes_24h: number;
  paywall_24h: number;
  last_events: string[];
  last_mode: string | null;
  app_version: string | null;
}

/** One row per user who uninstalled on [dayYmd], summarising what they did
 * in the [HISTORY_DAYS] before it. */
async function fetchUninstallers(dayYmd: string): Promise<UninstallRow[]> {
  // GCLOUD_PROJECT, not bq().projectId: the client only resolves its
  // project lazily and reports a placeholder until its first request.
  const project = process.env.GCLOUD_PROJECT ?? "beattronome-ea8b2";
  const table = `\`${project}.${DATASET}.events_*\``;
  const query = `
    WITH removals AS (
      SELECT user_pseudo_id, MIN(event_timestamp) AS removed_at
      FROM ${table}
      WHERE _TABLE_SUFFIX = @day AND event_name = 'app_remove'
      GROUP BY user_pseudo_id
    ),
    prior AS (
      SELECT e.user_pseudo_id, e.event_name, e.event_timestamp,
             e.user_first_touch_timestamp, e.app_info.version AS app_version,
             r.removed_at
      FROM ${table} e
      JOIN removals r USING (user_pseudo_id)
      WHERE e._TABLE_SUFFIX BETWEEN @from AND @day
        AND e.event_timestamp < r.removed_at
    )
    SELECT
      removed_at,
      MIN(user_first_touch_timestamp) AS first_touch,
      COUNTIF(event_name = 'session_start') AS sessions,
      COUNTIF(event_name IN UNNEST(@adEvents)
              AND event_timestamp >= removed_at - 86400000000) AS ads_24h,
      COUNTIF(event_name = 'app_exception'
              AND event_timestamp >= removed_at - 86400000000) AS crashes_24h,
      COUNTIF(event_name = 'paywall_shown'
              AND event_timestamp >= removed_at - 86400000000) AS paywall_24h,
      ARRAY_AGG(IF(event_name IN UNNEST(@noise), NULL, event_name)
                IGNORE NULLS ORDER BY event_timestamp DESC
                LIMIT ${LAST_EVENTS}) AS last_events,
      ARRAY_AGG(IF(event_name IN UNNEST(@modeEvents), event_name, NULL)
                IGNORE NULLS ORDER BY event_timestamp DESC LIMIT 1)[
                SAFE_OFFSET(0)] AS last_mode,
      ARRAY_AGG(app_version IGNORE NULLS ORDER BY event_timestamp DESC
                LIMIT 1)[SAFE_OFFSET(0)] AS app_version
    FROM prior
    GROUP BY user_pseudo_id, removed_at
  `;
  const [rows] = await bq().query({
    query,
    params: {
      day: suffix(dayYmd),
      from: suffix(addDays(dayYmd, -HISTORY_DAYS)),
      noise: NOISE_EVENTS,
      adEvents: AD_EVENTS,
      modeEvents: Object.keys(MODE_EVENTS),
    },
  });
  return rows as UninstallRow[];
}

/** Aggregates one day's uninstallers into the Firestore day-doc the
 * dashboard reads. Counts are users, not events. */
async function syncDay(dayYmd: string): Promise<number> {
  const rows = await fetchUninstallers(dayYmd);
  const n = (v: unknown): number => Number(v ?? 0);
  const daysInstalled = rows
    .filter((r) => r.first_touch != null)
    .map((r) => (n(r.removed_at) - n(r.first_touch)) / 86_400_000_000);

  await getFirestore().collection(COLLECTION).doc(dayYmd).set({
    date: dayYmd,
    uninstallers: rows.length,
    // Users with at least one of each in the 24h before uninstalling.
    withAd24h: rows.filter((r) => n(r.ads_24h) > 0).length,
    withCrash24h: rows.filter((r) => n(r.crashes_24h) > 0).length,
    withPaywall24h: rows.filter((r) => n(r.paywall_24h) > 0).length,
    // Uninstalled within a day of first open — never got going.
    sameDay: daysInstalled.filter((d) => d < 1).length,
    oneSession: rows.filter((r) => n(r.sessions) <= 1).length,
    medianDaysInstalled: median(daysInstalled),
    // Very last app event per user, and every event seen in each user's
    // last [LAST_EVENTS] (counted once per user).
    lastEvent: tally(rows.map((r) => r.last_events?.[0] ?? null)),
    inLastEvents: tally(rows.flatMap((r) => [...new Set(r.last_events ?? [])])),
    lastMode: tally(rows.map((r) => (r.last_mode ? MODE_EVENTS[r.last_mode] : null))),
    appVersion: tally(rows.map((r) => r.app_version)),
    fetched_at: FieldValue.serverTimestamp(),
  });
  return rows.length;
}

async function syncRange(startYmd: string, endYmd: string): Promise<number> {
  let days = 0;
  for (let d = startYmd; d <= endYmd; d = addDays(d, 1)) {
    try {
      await syncDay(d);
      days++;
    } catch (e) {
      // A day with no export table yet (today, or before the link) throws
      // "not found" — skip it rather than failing the whole range.
      logger.warn("syncUninstallPaths: day skipped", { day: d, error: String(e) });
    }
  }
  return days;
}

function lookbackRange(): { startYmd: string; endYmd: string } {
  const yesterday = addDays(utcYmd(new Date()), -1);
  return { startYmd: addDays(yesterday, -(DAILY_LOOKBACK_DAYS - 1)), endYmd: yesterday };
}

export const syncUninstallPaths = onSchedule(
  {
    // After the GA4 daily export has landed for yesterday.
    schedule: "every day 15:00",
    timeZone: "Etc/UTC",
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    const { startYmd, endYmd } = lookbackRange();
    const days = await syncRange(startYmd, endYmd);
    logger.info("syncUninstallPaths: done", { startYmd, endYmd, days });
  },
);

// Dashboard's GA4 sync button calls this alongside syncGa4Now, with the
// selected range; no args = the lookback window.
export const syncUninstallPathsNow = onCall(
  { region: "us-central1", timeoutSeconds: 540, memory: "256MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
    const adminDoc = await getFirestore().collection("users_bo").doc(uid).get();
    if (!adminDoc.exists) {
      throw new HttpsError("permission-denied", "Backoffice users only.");
    }
    const data = (request.data ?? {}) as { from?: string; to?: string };
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let { startYmd, endYmd } = lookbackRange();
    if (data.from && data.to) {
      if (!dateRe.test(data.from) || !dateRe.test(data.to)) {
        throw new HttpsError("invalid-argument", "from/to must be YYYY-MM-DD");
      }
      startYmd = data.from;
      endYmd = data.to;
    }
    const days = await syncRange(startYmd, endYmd);
    return { days, from: startYmd, to: endYmd };
  },
);
