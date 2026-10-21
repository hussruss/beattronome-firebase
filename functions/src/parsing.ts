/**
 * Pure helpers shared by the sync jobs: report parsing, date formats and
 * small aggregations. No Firebase/Google imports on purpose, so they can be
 * unit-tested without credentials or emulators (`npm test`).
 */

/** UTC date as `YYYY-MM-DD`. */
export function utcYmd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** GA4 and AdMob report dates as `YYYYMMDD` → `YYYY-MM-DD`. Anything that
 * isn't 8 characters is returned unchanged rather than mangled. */
export function compactDateToYmd(value: string): string {
  if (value.length !== 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

/** Parses Apple's tab-separated analytics report format into records
 * keyed by header name — resilient to Apple reordering/adding columns,
 * as long as the names this pipeline looks up by stay the same. */
export function parseTsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t");
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

/** Play's overview CSVs are UTF-16LE with a byte-order mark, not UTF-8
 * like most CSVs — decoding as UTF-8 would produce garbled/empty fields. */
export function decodePlayCsv(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le", 2);
  }
  return buffer.toString("utf-8");
}

export function parseCsv(text: string): Record<string, string>[] {
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

/** Numeric cell, 0 when missing or not a number. */
export function numOrZero(row: Record<string, string>, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

/** Sums every numeric column present in `rows`, grouped by `dateColumn`,
 * keyed by (lowercased, space-stripped) column name. Column names Apple
 * doesn't actually send just don't appear — nothing to hardcode wrong. */
export function sumNumericColumnsByDate(
  rows: Record<string, string>[],
  dateColumn: string,
): Map<string, Record<string, number>> {
  const byDate = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const date = row[dateColumn];
    if (!date) continue;
    const day = byDate.get(date) ?? {};
    for (const [key, raw] of Object.entries(row)) {
      if (key === dateColumn) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue; // skip non-numeric columns
      const field = key.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      day[field] = (day[field] ?? 0) + value;
    }
    byDate.set(date, day);
  }
  return byDate;
}

export interface EarningsRow {
  date: string;
  appId: string;
  usd: number;
  impressions: number;
}

export interface DailyTotals {
  ios: number;
  android: number;
  total: number;
  iosImpressions: number;
  androidImpressions: number;
  totalImpressions: number;
}

/** AdMob earnings per day, split by platform. Rows from any other app id
 * still count towards the totals. */
export function aggregateEarningsByDate(
  rows: EarningsRow[],
  iosAppId: string,
  androidAppId: string,
): Map<string, DailyTotals> {
  const byDate = new Map<string, DailyTotals>();
  for (const row of rows) {
    const entry = byDate.get(row.date) ?? {
      ios: 0,
      android: 0,
      total: 0,
      iosImpressions: 0,
      androidImpressions: 0,
      totalImpressions: 0,
    };
    if (row.appId === iosAppId) {
      entry.ios += row.usd;
      entry.iosImpressions += row.impressions;
    } else if (row.appId === androidAppId) {
      entry.android += row.usd;
      entry.androidImpressions += row.impressions;
    }
    entry.total += row.usd;
    entry.totalImpressions += row.impressions;
    byDate.set(row.date, entry);
  }
  return byDate;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Occurrences per key, ignoring null/empty keys. */
export function tally(keys: (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    if (!k) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** One country in the realtime card. `countryId` is GA4's ISO 3166-1
 * alpha-2 code (for the flag); null when GA4 has none ("(not set)"). */
export interface RealtimeCountry {
  country: string;
  countryId: string | null;
  activeUsers: number;
}

interface ReportRow {
  dimensionValues?: { value?: string | null }[] | null;
  metricValues?: { value?: string | null }[] | null;
}

/** Rows of a realtime report with dimensions `[country, countryId]` and
 * metric `activeUsers`. */
export function parseRealtimeCountries(
  rows: ReportRow[] | null | undefined,
): RealtimeCountry[] {
  return (rows ?? []).map((row) => {
    const code = row.dimensionValues?.[1]?.value ?? "";
    return {
      country: row.dimensionValues?.[0]?.value || "Unknown",
      countryId: /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : null,
      activeUsers: Number(row.metricValues?.[0]?.value ?? "0") || 0,
    };
  });
}

/** `YYYY-MM-DD` shifted by [days] (negative goes back). */
export function addDays(dayYmd: string, days: number): string {
  const d = new Date(`${dayYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcYmd(d);
}

/** One row of the AdMob health report: requests, fills and impressions for
 * an app, ad format and app version on one day. */
export interface AdHealthRow {
  date: string;
  appId: string;
  format: string;
  version: string;
  requests: number;
  matched: number;
  impressions: number;
}

/** What an `ad_health_daily` day-doc holds per platform, format and
 * version. Empty formats and versions read "unknown". */
export interface AdHealthEntry {
  platform: "ios" | "android" | "other";
  format: string;
  version: string;
  requests: number;
  matched: number;
  impressions: number;
}

/** AdMob health rows grouped per day, with the app id resolved to a
 * platform, the format lower-cased and repeated keys summed. */
export function aggregateAdHealthByDate(
  rows: AdHealthRow[],
  iosAppId: string,
  androidAppId: string,
): Map<string, AdHealthEntry[]> {
  const byDate = new Map<string, Map<string, AdHealthEntry>>();
  for (const row of rows) {
    const platform =
      row.appId === iosAppId
        ? "ios"
        : row.appId === androidAppId
          ? "android"
          : "other";
    const format = row.format.trim().toLowerCase() || "unknown";
    const version = row.version.trim() || "unknown";
    const key = `${platform}|${format}|${version}`;
    const day = byDate.get(row.date) ?? new Map<string, AdHealthEntry>();
    const entry = day.get(key) ?? {
      platform,
      format,
      version,
      requests: 0,
      matched: 0,
      impressions: 0,
    };
    entry.requests += row.requests;
    entry.matched += row.matched;
    entry.impressions += row.impressions;
    day.set(key, entry);
    byDate.set(row.date, day);
  }
  return new Map(
    [...byDate].map(([date, day]) => [date, [...day.values()]]),
  );
}

/** Active users of one platform and app version on one day. */
export interface VersionUsers {
  platform: string;
  version: string;
  users: number;
}

/** Rows of a GA4 report with dimensions `[date, platform, appVersion]` and
 * metric `activeUsers`, grouped per day. GA4's "(not set)" and empty
 * versions read "unknown"; rows with no users are dropped. */
export function parseVersionRows(
  rows: ReportRow[] | null | undefined,
): Map<string, VersionUsers[]> {
  const byDate = new Map<string, VersionUsers[]>();
  for (const row of rows ?? []) {
    const rawDate = row.dimensionValues?.[0]?.value;
    if (!rawDate) continue;
    const users = Number(row.metricValues?.[0]?.value ?? "0") || 0;
    if (users <= 0) continue;
    const rawVersion = row.dimensionValues?.[2]?.value ?? "";
    const date = compactDateToYmd(rawDate);
    const day = byDate.get(date) ?? [];
    day.push({
      platform: row.dimensionValues?.[1]?.value || "unknown",
      version:
        rawVersion === "" || rawVersion === "(not set)" ? "unknown" : rawVersion,
      users,
    });
    byDate.set(date, day);
  }
  return byDate;
}

/** Days after install at which retention is measured. */
export const RETENTION_OFFSETS = [1, 7, 30] as const;

/** The `ga4_retention_daily` field a cohort fills when its users are seen
 * on [dayYmd]: "d1", "d7" or "d30", or null for any other gap (the
 * install day itself included). */
export function retentionFieldFor(
  cohortYmd: string,
  dayYmd: string,
): string | null {
  for (const offset of RETENTION_OFFSETS) {
    if (addDays(cohortYmd, offset) === dayYmd) return `d${offset}`;
  }
  return null;
}
