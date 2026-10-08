// App Store Connect Analytics sync — installs/deletions + engagement
// (impressions, product page views).
//
// NOT WIRED UP YET: needs three secrets that only an Account Holder/Admin
// can generate (App Store Connect > Users and Access > Integrations >
// App Store Connect API — "Team Keys", not an individual's personal key):
//   ASC_KEY_ID           the Key ID shown next to the generated key
//   ASC_ISSUER_ID        shown at the top of the same Integrations page
//   ASC_PRIVATE_KEY      the *contents* of the downloaded .p8 file, as-is
//                         (including the BEGIN/END PRIVATE KEY lines)
// and one non-secret config value:
//   APPLE_APP_ID          the app's numeric Apple ID (App Store Connect >
//                         App Information > Apple ID — NOT the bundle id
//                         com.beattronome; it looks like "1234567890",
//                         also visible in the App Store URL
//                         apps.apple.com/.../id1234567890)
//
// A key generated with the "App Manager" role (or whatever role App Store
// Connect currently labels for analytics/reporting access) is enough to
// USE this once created — Admin is only needed to create the key itself.
//
// Until those are set (`firebase functions:secrets:set ASC_KEY_ID` etc.
// and `firebase functions:config:set` or a `defineString` default for
// APPLE_APP_ID), both functions below will throw on first use — that's
// expected, not a bug to chase.
//
// Report-name matching is a substring search (see appStoreConnectClient's
// findReportId) rather than an exact string, and the TSV parsing sums
// whatever numeric-looking columns it finds rather than hardcoding exact
// Apple column names — this pipeline has never run against a real Apple
// response, so the shape is a best-effort from Apple's published docs,
// not a verified contract. First real run's logs are the place to check
// that the report names/columns actually matched what was expected.

import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import {
  AppStoreConnectCreds,
  downloadInstanceSegments,
  ensureOngoingReportRequest,
  findReportId,
  listRecentInstances,
  parseTsv,
} from "./appStoreConnectClient";
import { sumNumericColumnsByDate } from "./parsing";

const ASC_KEY_ID = defineSecret("ASC_KEY_ID");
const ASC_ISSUER_ID = defineSecret("ASC_ISSUER_ID");
const ASC_PRIVATE_KEY = defineSecret("ASC_PRIVATE_KEY");
const APPLE_APP_ID = defineString("APPLE_APP_ID", { default: "" });

const INSTALLS_COLLECTION = "asc_installs_daily";
const ENGAGEMENT_COLLECTION = "asc_engagement_daily";

// How many of the most recent instances to pull each run. Apple's ONGOING
// reports post a new daily instance once processing finishes; a handful
// of days covers both a normal run and catching up after a gap.
const INSTANCES_PER_RUN = 5;

function creds(): AppStoreConnectCreds {
  return {
    keyId: ASC_KEY_ID.value(),
    issuerId: ASC_ISSUER_ID.value(),
    privateKeyPem: ASC_PRIVATE_KEY.value(),
  };
}

function appId(): string {
  const id = APPLE_APP_ID.value();
  if (!id) {
    throw new Error(
      "APPLE_APP_ID is not set — see the comment at the top of " +
        "syncAppStoreConnect.ts for where to find it.",
    );
  }
  return id;
}

async function fetchLatestReportRows(
  reportRequestId: string,
  category: string,
  nameContains: string,
): Promise<Record<string, string>[]> {
  const reportId = await findReportId(
    creds(),
    reportRequestId,
    category,
    nameContains,
  );
  if (!reportId) return [];

  const instances = await listRecentInstances(
    creds(),
    reportId,
    INSTANCES_PER_RUN,
  );
  const rows: Record<string, string>[] = [];
  for (const instance of instances) {
    const segments = await downloadInstanceSegments(creds(), instance.id);
    for (const tsv of segments) rows.push(...parseTsv(tsv));
  }
  return rows;
}

async function writeByDate(
  collection: string,
  byDate: Map<string, Record<string, number>>,
): Promise<number> {
  if (byDate.size === 0) return 0;
  const db = getFirestore();
  const col = db.collection(collection);
  const batch = db.batch();
  for (const [date, metrics] of byDate.entries()) {
    batch.set(
      col.doc(date),
      { date, ...metrics, fetched_at: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
  await batch.commit();
  return byDate.size;
}

async function syncOnce(): Promise<{
  installDays: number;
  engagementDays: number;
}> {
  const reportRequestId = await ensureOngoingReportRequest(creds(), appId());

  const [installRows, engagementRows] = await Promise.all([
    fetchLatestReportRows(
      reportRequestId,
      "APP_USAGE",
      "Installation and Deletion Standard",
    ),
    fetchLatestReportRows(
      reportRequestId,
      "APP_STORE_ENGAGEMENT",
      "App Store Engagement Standard",
    ),
  ]);

  const installsByDate = sumNumericColumnsByDate(installRows, "Date");
  const engagementByDate = sumNumericColumnsByDate(engagementRows, "Date");

  const [installDays, engagementDays] = await Promise.all([
    writeByDate(INSTALLS_COLLECTION, installsByDate),
    writeByDate(ENGAGEMENT_COLLECTION, engagementByDate),
  ]);

  return { installDays, engagementDays };
}

export const syncAppStoreConnect = onSchedule(
  {
    schedule: "every day 08:00",
    timeZone: "Etc/UTC",
    region: "us-central1",
    secrets: [ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY],
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    logger.info("syncAppStoreConnect: starting");
    const result = await syncOnce();
    logger.info("syncAppStoreConnect: done", result);
  },
);

// Dashboard "sync now" button, once a UI exists to call it.
export const syncAppStoreConnectNow = onCall(
  {
    region: "us-central1",
    secrets: [ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY],
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
    logger.info("syncAppStoreConnectNow: triggered", { uid });
    return syncOnce();
  },
);
