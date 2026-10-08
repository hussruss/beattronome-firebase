import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  AdMobOAuthCreds,
  fetchAdMobEarnings,
} from "./admobClient";
import { aggregateEarningsByDate, DailyTotals, utcYmd } from "./parsing";

const ADMOB_OAUTH_CLIENT_ID = defineSecret("ADMOB_OAUTH_CLIENT_ID");
const ADMOB_OAUTH_CLIENT_SECRET = defineSecret("ADMOB_OAUTH_CLIENT_SECRET");
const ADMOB_REFRESH_TOKEN = defineSecret("ADMOB_REFRESH_TOKEN");

const PUBLISHER_ID = "pub-4008135751850421";
const IOS_APP_ID = "ca-app-pub-4008135751850421~7022994604";
const ANDROID_APP_ID = "ca-app-pub-4008135751850421~8473548475";
const AD_REVENUE_COLLECTION = "ad_revenue";

// AdMob estimates settle over ~72h, so we re-fetch the last 4 days every run.
const DAILY_LOOKBACK_DAYS = 4;

function creds(): AdMobOAuthCreds {
  return {
    clientId: ADMOB_OAUTH_CLIENT_ID.value(),
    clientSecret: ADMOB_OAUTH_CLIENT_SECRET.value(),
    refreshToken: ADMOB_REFRESH_TOKEN.value(),
  };
}

async function writeDailyDocs(
  byDate: Map<string, DailyTotals>,
): Promise<number> {
  if (byDate.size === 0) return 0;
  const db = getFirestore();
  const col = db.collection(AD_REVENUE_COLLECTION);
  const batch = db.batch();
  for (const [date, totals] of byDate.entries()) {
    batch.set(
      col.doc(date),
      {
        date,
        usd: totals.total,
        ios_usd: totals.ios,
        android_usd: totals.android,
        impressions: totals.totalImpressions,
        ios_impressions: totals.iosImpressions,
        android_impressions: totals.androidImpressions,
        fetched_at: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
  await batch.commit();
  return byDate.size;
}

async function syncRange(startYmd: string, endYmd: string): Promise<number> {
  const rows = await fetchAdMobEarnings({
    creds: creds(),
    publisherId: PUBLISHER_ID,
    appIds: [IOS_APP_ID, ANDROID_APP_ID],
    startDate: startYmd,
    endDate: endYmd,
  });
  const byDate = aggregateEarningsByDate(rows, IOS_APP_ID, ANDROID_APP_ID);
  return writeDailyDocs(byDate);
}

export const syncAdMobRevenue = onSchedule(
  {
    schedule: "every day 06:00",
    timeZone: "Etc/UTC",
    region: "us-central1",
    secrets: [
      ADMOB_OAUTH_CLIENT_ID,
      ADMOB_OAUTH_CLIENT_SECRET,
      ADMOB_REFRESH_TOKEN,
    ],
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const now = new Date();
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - DAILY_LOOKBACK_DAYS);
    const startYmd = utcYmd(start);
    const endYmd = utcYmd(now);
    logger.info("syncAdMobRevenue: fetching", { startYmd, endYmd });
    const written = await syncRange(startYmd, endYmd);
    logger.info("syncAdMobRevenue: done", { written });
  },
);

// Dashboard "sync now" button. Re-fetches the last 4 days like the scheduled
// run does, so a user can refresh ARPU without waiting for 06:00 UTC.
export const syncAdMobRevenueNow = onCall(
  {
    region: "us-central1",
    secrets: [
      ADMOB_OAUTH_CLIENT_ID,
      ADMOB_OAUTH_CLIENT_SECRET,
      ADMOB_REFRESH_TOKEN,
    ],
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
    // Dashboard sync button. Pass {from, to} (YYYY-MM-DD) to backfill the
    // selected range; otherwise re-fetches the lookback window. Replaces the
    // old public, token-guarded HTTP backfill endpoint.
    const data = (request.data ?? {}) as { from?: string; to?: string };
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let startYmd: string;
    let endYmd: string;
    if (data.from && data.to) {
      if (!dateRe.test(data.from) || !dateRe.test(data.to)) {
        throw new HttpsError("invalid-argument", "from/to must be YYYY-MM-DD");
      }
      startYmd = data.from;
      endYmd = data.to;
    } else {
      const now = new Date();
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - DAILY_LOOKBACK_DAYS);
      startYmd = utcYmd(start);
      endYmd = utcYmd(now);
    }
    logger.info("syncAdMobRevenueNow: triggered", { uid, startYmd, endYmd });
    const written = await syncRange(startYmd, endYmd);
    return { written, from: startYmd, to: endYmd };
  },
);
