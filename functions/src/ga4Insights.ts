import "./admin";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { BigQuery } from "@google-cloud/bigquery";
import {
  addDays,
  compactDateToYmd,
  RETENTION_OFFSETS,
  retentionFieldFor,
} from "./parsing";

// Per-day aggregates the dashboard reads from the GA4 BigQuery export: ad
// trigger outcomes, retention and the new-user funnel. They need user-level
// rows, or event params GA4 has no registered dimension for, so the GA4
// Data API can't give them. syncUninstallPaths runs them for every day it
// syncs, so they share its schedule, its sync button and the export link.
const GA4_PROPERTY_ID = "353313516";
const DATASET = `analytics_${GA4_PROPERTY_ID}`;
const TRIGGERS_COLLECTION = "ga4_ad_triggers_daily";
const RETENTION_COLLECTION = "ga4_retention_daily";
const FUNNEL_COLLECTION = "ga4_funnel_daily";

// A user counts as back on a day when the app opened or was in use.
const ACTIVE_EVENTS = ["session_start", "user_engagement"];
// Funnel steps after `first_open`, as the app logs them.
const AHA_EVENT = "aha_moment_reached";
const PAYWALL_EVENT = "paywall_shown";
const PURCHASE_EVENT = "purchase_completed";
// How many days after install the funnel steps count.
const FUNNEL_DAYS = 7;

let bigQueryClient: BigQuery | null = null;
function bq(): BigQuery {
  bigQueryClient ??= new BigQuery();
  return bigQueryClient;
}

const suffix = (dayYmd: string): string => dayYmd.replace(/-/g, "");
const n = (v: unknown): number => Number(v ?? 0);

function eventsTable(): string {
  // GCLOUD_PROJECT, not bq().projectId: see syncUninstallPaths.
  const project = process.env.GCLOUD_PROJECT ?? "beattronome-ea8b2";
  return `\`${project}.${DATASET}.events_*\``;
}

interface TriggerRow {
  event_name: string;
  format: string | null;
  reason: string | null;
  source: string | null;
  n: number;
}

/** Shown and denied ad triggers on [dayYmd], by format, deny reason and
 * placement. */
async function syncAdTriggers(dayYmd: string): Promise<void> {
  const [rows] = await bq().query({
    query: `
      SELECT
        event_name,
        (SELECT value.string_value FROM UNNEST(event_params)
         WHERE key = 'ad_format') AS format,
        (SELECT value.string_value FROM UNNEST(event_params)
         WHERE key = 'deny_reason') AS reason,
        (SELECT value.string_value FROM UNNEST(event_params)
         WHERE key = 'ad_source') AS source,
        COUNT(*) AS n
      FROM ${eventsTable()}
      WHERE _TABLE_SUFFIX = @day
        AND event_name IN ('ad_trigger_shown', 'ad_trigger_denied')
      GROUP BY event_name, format, reason, source
    `,
    params: { day: suffix(dayYmd) },
  });
  await getFirestore()
    .collection(TRIGGERS_COLLECTION)
    .doc(dayYmd)
    .set({
      date: dayYmd,
      rows: (rows as TriggerRow[]).map((r) => ({
        event: r.event_name === "ad_trigger_shown" ? "shown" : "denied",
        format: r.format ?? "unknown",
        reason: r.reason ?? null,
        source: r.source ?? "unknown",
        count: n(r.n),
      })),
      fetched_at: FieldValue.serverTimestamp(),
    });
}

interface RetentionRow {
  cohort_day: string;
  cohort_size: number;
  retained: number;
}

/** Retention seen on [dayYmd]: the size of the cohort that installed that
 * day, and how many of the cohorts from 1, 7 and 30 days earlier came back
 * on it. Each figure depends only on its two days, so syncs can run in any
 * order. */
async function syncRetention(dayYmd: string): Promise<void> {
  const cohortDays = [
    dayYmd,
    ...RETENTION_OFFSETS.map((offset) => addDays(dayYmd, -offset)),
  ];
  const [rows] = await bq().query({
    query: `
      WITH active AS (
        SELECT DISTINCT user_pseudo_id
        FROM ${eventsTable()}
        WHERE _TABLE_SUFFIX = @day AND event_name IN UNNEST(@activeEvents)
      ),
      cohorts AS (
        SELECT DISTINCT _TABLE_SUFFIX AS cohort_day, user_pseudo_id
        FROM ${eventsTable()}
        WHERE _TABLE_SUFFIX IN UNNEST(@cohortDays)
          AND event_name = 'first_open'
      )
      SELECT
        c.cohort_day,
        COUNT(*) AS cohort_size,
        COUNTIF(a.user_pseudo_id IS NOT NULL) AS retained
      FROM cohorts c
      LEFT JOIN active a ON a.user_pseudo_id = c.user_pseudo_id
      GROUP BY c.cohort_day
    `,
    params: {
      day: suffix(dayYmd),
      activeEvents: ACTIVE_EVENTS,
      cohortDays: cohortDays.map(suffix),
    },
  });
  const col = getFirestore().collection(RETENTION_COLLECTION);
  await Promise.all(
    (rows as RetentionRow[]).map((r) => {
      const cohort = compactDateToYmd(r.cohort_day);
      const field = retentionFieldFor(cohort, dayYmd);
      return col.doc(cohort).set(
        {
          date: cohort,
          cohort: n(r.cohort_size),
          ...(field ? { [field]: n(r.retained) } : {}),
          fetched_at: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }),
  );
}

interface FunnelRow {
  cohort_day: string;
  new_users: number;
  aha: number;
  paywall: number;
  purchase: number;
}

/** For each install cohort from [FUNNEL_DAYS] days before [dayYmd] up to
 * it: how many reached the aha moment, saw the paywall and bought within
 * their first [FUNNEL_DAYS] days. Each cohort is recomputed whole from
 * every exported day in its window, so a later sync only ever adds data. */
async function syncFunnel(dayYmd: string): Promise<void> {
  const [rows] = await bq().query({
    query: `
      WITH cohorts AS (
        SELECT DISTINCT _TABLE_SUFFIX AS cohort_day, user_pseudo_id
        FROM ${eventsTable()}
        WHERE _TABLE_SUFFIX BETWEEN @from AND @day
          AND event_name = 'first_open'
      ),
      steps AS (
        SELECT DISTINCT user_pseudo_id, event_name, _TABLE_SUFFIX AS step_day
        FROM ${eventsTable()}
        WHERE _TABLE_SUFFIX BETWEEN @from AND @to
          AND event_name IN (@aha, @paywall, @purchase)
      )
      SELECT
        c.cohort_day,
        COUNT(DISTINCT c.user_pseudo_id) AS new_users,
        COUNT(DISTINCT IF(s.event_name = @aha, c.user_pseudo_id, NULL)) AS aha,
        COUNT(DISTINCT IF(s.event_name = @paywall, c.user_pseudo_id, NULL))
          AS paywall,
        COUNT(DISTINCT IF(s.event_name = @purchase, c.user_pseudo_id, NULL))
          AS purchase
      FROM cohorts c
      LEFT JOIN steps s
        ON s.user_pseudo_id = c.user_pseudo_id
        AND s.step_day BETWEEN c.cohort_day AND FORMAT_DATE(
          '%Y%m%d',
          DATE_ADD(PARSE_DATE('%Y%m%d', c.cohort_day),
                   INTERVAL ${FUNNEL_DAYS} DAY))
      GROUP BY c.cohort_day
    `,
    params: {
      from: suffix(addDays(dayYmd, -FUNNEL_DAYS)),
      day: suffix(dayYmd),
      to: suffix(addDays(dayYmd, FUNNEL_DAYS)),
      aha: AHA_EVENT,
      paywall: PAYWALL_EVENT,
      purchase: PURCHASE_EVENT,
    },
  });
  const col = getFirestore().collection(FUNNEL_COLLECTION);
  await Promise.all(
    (rows as FunnelRow[]).map((r) => {
      const cohort = compactDateToYmd(r.cohort_day);
      return col.doc(cohort).set({
        date: cohort,
        newUsers: n(r.new_users),
        aha: n(r.aha),
        paywall: n(r.paywall),
        purchase: n(r.purchase),
        fetched_at: FieldValue.serverTimestamp(),
      });
    }),
  );
}

/** Runs every aggregate for [dayYmd]. Never throws. A day the export hasn't
 * written yet (today, or before the link) is skipped whole: retention would
 * otherwise read "nobody came back". One failing aggregate doesn't stop the
 * others; each failure is logged. */
export async function syncInsightsDay(dayYmd: string): Promise<void> {
  try {
    const [exists] = await bq()
      .dataset(DATASET)
      .table(`events_${suffix(dayYmd)}`)
      .exists();
    if (!exists) {
      logger.info("ga4Insights: no export table yet", { day: dayYmd });
      return;
    }
  } catch (e) {
    logger.warn("ga4Insights: table check failed", {
      day: dayYmd,
      error: String(e),
    });
    return;
  }
  const parts = ["adTriggers", "retention", "funnel"];
  const results = await Promise.allSettled([
    syncAdTriggers(dayYmd),
    syncRetention(dayYmd),
    syncFunnel(dayYmd),
  ]);
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      logger.warn("ga4Insights: part failed", {
        day: dayYmd,
        part: parts[i],
        error: String(result.reason),
      });
    }
  });
}
