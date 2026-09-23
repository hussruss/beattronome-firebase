// Google Play Console installs/uninstalls/active-devices sync.
//
// NOT WIRED UP YET: needs PLAY_CONSOLE_BUCKET set (see the comment at the
// top of playConsoleClient.ts for how to find it in Play Console) and the
// Cloud Functions runtime service account granted "Storage Object Viewer"
// on that bucket. Until then this throws on first use — expected, not a
// bug to chase.

import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineString } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { fetchMonthlyOverview } from "./playConsoleClient";

const PLAY_CONSOLE_BUCKET = defineString("PLAY_CONSOLE_BUCKET", {
  default: "",
});
const PACKAGE_NAME = "com.beattronome";
const DAILY_COLLECTION = "play_console_daily";

function bucketName(): string {
  const name = PLAY_CONSOLE_BUCKET.value();
  if (!name) {
    throw new Error(
      "PLAY_CONSOLE_BUCKET is not set — see the comment at the top of " +
        "playConsoleClient.ts for where to find it in Play Console.",
    );
  }
  return name;
}

function yyyymm(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}${m}`;
}

async function syncOnce(): Promise<{ days: number }> {
  const bucket = bucketName();
  const now = new Date();
  const prevMonth = new Date(now);
  prevMonth.setUTCMonth(prevMonth.getUTCMonth() - 1);

  // Current month's file plus the previous month's, so a run near a month
  // boundary doesn't miss the tail end of the month that just closed —
  // Play files data under the calendar month it happened in, not the
  // month the sync happens to run in.
  const [previous, current] = await Promise.all([
    fetchMonthlyOverview(bucket, PACKAGE_NAME, yyyymm(prevMonth)),
    fetchMonthlyOverview(bucket, PACKAGE_NAME, yyyymm(now)),
  ]);
  const rows = [...previous, ...current];
  if (rows.length === 0) return { days: 0 };

  const db = getFirestore();
  const col = db.collection(DAILY_COLLECTION);
  const batch = db.batch();
  for (const row of rows) {
    const { date, ...metrics } = row;
    batch.set(
      col.doc(date),
      { date, ...metrics, fetched_at: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();
  return { days: rows.length };
}

export const syncPlayConsole = onSchedule(
  {
    schedule: "every day 07:30",
    timeZone: "Etc/UTC",
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    logger.info("syncPlayConsole: starting");
    const result = await syncOnce();
    logger.info("syncPlayConsole: done", result);
  },
);

// Dashboard "sync now" button, once a UI exists to call it.
export const syncPlayConsoleNow = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 120,
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
    logger.info("syncPlayConsoleNow: triggered", { uid });
    return syncOnce();
  },
);
