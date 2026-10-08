// Minimal Google Play Console statistics reader.
//
// The Play Developer Reporting API only covers Android Vitals (crash
// rate, ANR rate) — it does NOT expose installs/active-device/uninstall
// counts. Those live in CSV reports Play itself writes into a Cloud
// Storage bucket, which is what this reads instead.
//
// Setup (manual, in Play Console — not something this code can do):
//   1. Play Console > Download reports > Statistics (pick the right app in
//      the top-right app selector) shows a "Copy Cloud Storage URI" button
//      per report section, and expanding a month's rows exposes direct
//      https://storage.cloud.google.com/<bucket>/... download links — the
//      bucket segment is the value PLAY_CONSOLE_BUCKET needs, e.g.
//      "pubsite_prod_<play developer account ID>".
//   2. This bucket is Google-managed, NOT a bucket inside this Firebase
//      project's own Cloud project — it does not show up under this
//      project's Cloud Storage / IAM in Cloud Console, and granting IAM
//      roles on it there does nothing (confirmed: Console reports
//      "missing storage.buckets.getIamPolicy permission" when trying).
//      Real access is granted through Play Console itself: Users and
//      permissions > Invite new users > enter the Cloud Functions runtime
//      service account's email (Cloud Run service's Security tab, or
//      YAML > `run.googleapis.com/build-service-account` — commonly
//      "<project-number>-compute@developer.gserviceaccount.com" when no
//      App Engine default service account exists) > Account permissions >
//      check "View app information and download bulk reports (read-only)"
//      (no financial-data permission needed, this function only reads
//      install/uninstall stats, not revenue). Service-account invites
//      auto-accept immediately, no separate confirmation step.
//
// Reports land as monthly CSVs, appended to as the month progresses:
//   stats/installs/installs_<packageName>_<YYYYMM>_overview.csv
// Only the "overview" report is read here — it already has daily
// install/uninstall/active-device counts aggregated, no need to sum
// per-country/per-device breakdowns ourselves.

import { Storage } from "@google-cloud/storage";
import { logger } from "firebase-functions/v2";
import { decodePlayCsv, numOrZero, parseCsv } from "./parsing";

let storage: Storage | null = null;
function client(): Storage {
  storage ??= new Storage();
  return storage;
}

export interface PlayConsoleDailyRow {
  date: string; // YYYY-MM-DD
  dailyDeviceInstalls: number;
  dailyDeviceUninstalls: number;
  activeDeviceInstalls: number;
  dailyUserInstalls: number;
  dailyUserUninstalls: number;
  totalUserInstalls: number;
}

/** Reads one month's "overview" installs CSV. Returns an empty array if
 * that month's file doesn't exist yet — e.g. a run near a month boundary
 * asking for the month that just started, before Play has written
 * anything into it. */
export async function fetchMonthlyOverview(
  bucketName: string,
  packageName: string,
  yyyymm: string,
): Promise<PlayConsoleDailyRow[]> {
  const path = `stats/installs/installs_${packageName}_${yyyymm}_overview.csv`;
  const file = client().bucket(bucketName).file(path);
  const [exists] = await file.exists();
  if (!exists) {
    logger.info("playConsole: no overview file yet", { path });
    return [];
  }
  const [buffer] = await file.download();
  const rows = parseCsv(decodePlayCsv(buffer));
  return rows
    .map((row) => ({
      date: (row["Date"] ?? "").trim(),
      dailyDeviceInstalls: numOrZero(row, "Daily Device Installs"),
      dailyDeviceUninstalls: numOrZero(row, "Daily Device Uninstalls"),
      activeDeviceInstalls: numOrZero(row, "Active Device Installs"),
      dailyUserInstalls: numOrZero(row, "Daily User Installs"),
      dailyUserUninstalls: numOrZero(row, "Daily User Uninstalls"),
      totalUserInstalls: numOrZero(row, "Total User Installs"),
    }))
    .filter((r) => r.date.length > 0);
}
