// Minimal Google Play Console statistics reader.
//
// The Play Developer Reporting API only covers Android Vitals (crash
// rate, ANR rate) — it does NOT expose installs/active-device/uninstall
// counts. Those live in CSV reports Play itself writes into a Cloud
// Storage bucket, which is what this reads instead.
//
// Setup (manual, in Play Console — not something this code can do):
//   1. Play Console > Setup > API access — the Play Console account needs
//      to be linked to the SAME Google Cloud project this Firebase
//      project lives in (or note whichever project it's linked to).
//   2. Play Console > Download reports (left sidebar) shows the bucket
//      name Play writes to — looks like "pubsite_prod_rev_XXXXXXXXXXXXX".
//      That's the value PLAY_CONSOLE_BUCKET needs in syncPlayConsole.ts.
//   3. Grant the Cloud Functions runtime service account "Storage Object
//      Viewer" on that bucket (IAM, in Cloud Console) — Play's own
//      process writes the files, this function only ever reads them.
//
// Reports land as monthly CSVs, appended to as the month progresses:
//   stats/installs/installs_<packageName>_<YYYYMM>_overview.csv
// Only the "overview" report is read here — it already has daily
// install/uninstall/active-device counts aggregated, no need to sum
// per-country/per-device breakdowns ourselves.

import { Storage } from "@google-cloud/storage";
import { logger } from "firebase-functions/v2";

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

// Play's overview CSVs are UTF-16LE with a byte-order mark, not UTF-8
// like most CSVs — decoding as UTF-8 would produce garbled/empty fields.
function decode(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2);
  }
  return buffer.toString("utf-8");
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

function num(row: Record<string, string>, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
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
  const rows = parseCsv(decode(buffer));
  return rows
    .map((row) => ({
      date: (row["Date"] ?? "").trim(),
      dailyDeviceInstalls: num(row, "Daily Device Installs"),
      dailyDeviceUninstalls: num(row, "Daily Device Uninstalls"),
      activeDeviceInstalls: num(row, "Active Device Installs"),
      dailyUserInstalls: num(row, "Daily User Installs"),
      dailyUserUninstalls: num(row, "Daily User Uninstalls"),
      totalUserInstalls: num(row, "Total User Installs"),
    }))
    .filter((r) => r.date.length > 0);
}
