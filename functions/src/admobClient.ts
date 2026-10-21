// Minimal AdMob Network Reporting API client.
//
// AdMob API authn quirk: it does NOT accept service-account credentials. You
// must use a user-delegated OAuth2 refresh token from an account that has
// access to the AdMob publisher. See
// functions/scripts/get-admob-refresh-token.mjs for the one-time bootstrap.

import { logger } from "firebase-functions/v2";
import { AdHealthRow, compactDateToYmd } from "./parsing";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface AdMobOAuthCreds {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface DailyAppEarnings {
  date: string; // YYYY-MM-DD
  appId: string; // ca-app-pub-...
  usd: number;
  impressions: number;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export async function getAccessToken(
  creds: AdMobOAuthCreds,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OAuth refresh failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as AccessTokenResponse;
  return json.access_token;
}

interface ReportRow {
  row?: {
    dimensionValues?: Record<string, { value?: string; displayLabel?: string }>;
    metricValues?: Record<
      string,
      { microsValue?: string; integerValue?: string; doubleValue?: number }
    >;
  };
  header?: unknown;
  footer?: unknown;
}

export interface FetchEarningsParams {
  creds: AdMobOAuthCreds;
  publisherId: string; // "pub-XXXXXXXXXXXXXXXX" (no ca-app- prefix)
  appIds: string[]; // ["ca-app-pub-..~..", ...]
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD (inclusive)
  timeZone?: string;
}

function ymdToDateObj(ymd: string): { year: number; month: number; day: number } {
  const [y, m, d] = ymd.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** Runs one Network Report over the params' date range and apps, with the
 * given dimensions and metrics, and returns its raw rows. */
async function runNetworkReport(
  params: FetchEarningsParams,
  dimensions: string[],
  metrics: string[],
): Promise<ReportRow[]> {
  const accessToken = await getAccessToken(params.creds);

  const reportSpec: Record<string, unknown> = {
    dateRange: {
      startDate: ymdToDateObj(params.startDate),
      endDate: ymdToDateObj(params.endDate),
    },
    dimensions,
    metrics,
    localizationSettings: { currencyCode: "USD", languageCode: "en-US" },
    timeZone: params.timeZone ?? "America/Los_Angeles",
  };
  if (params.appIds.length > 0) {
    reportSpec.dimensionFilters = [
      { dimension: "APP", matchesAny: { values: params.appIds } },
    ];
  }

  const url =
    `https://admob.googleapis.com/v1/accounts/${params.publisherId}` +
    `/networkReport:generate`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reportSpec }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AdMob report failed (${res.status}): ${text}`);
  }

  // AdMob streams the response as a JSON array whose elements are header /
  // row / footer objects. Some accounts get NDJSON; handle both shapes.
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ReportRow[]) : [parsed];
  } catch {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReportRow);
  }
}

export async function fetchAdMobEarnings(
  params: FetchEarningsParams,
): Promise<DailyAppEarnings[]> {
  const rows = await runNetworkReport(
    params,
    ["DATE", "APP"],
    ["ESTIMATED_EARNINGS", "IMPRESSIONS"],
  );

  const out: DailyAppEarnings[] = [];
  for (const r of rows) {
    if (!r.row) continue;
    const dateRaw = r.row.dimensionValues?.DATE?.value;
    const appId = r.row.dimensionValues?.APP?.value;
    const micros = r.row.metricValues?.ESTIMATED_EARNINGS?.microsValue;
    const impressionsRaw = r.row.metricValues?.IMPRESSIONS?.integerValue;
    if (!dateRaw || !appId) continue;
    const usd = micros ? Number(micros) / 1_000_000 : 0;
    const impressions = impressionsRaw ? Number(impressionsRaw) : 0;
    out.push({ date: compactDateToYmd(dateRaw), appId, usd, impressions });
  }

  logger.info("AdMob report parsed", {
    publisher: params.publisherId,
    rows: out.length,
    range: `${params.startDate}..${params.endDate}`,
  });
  return out;
}

/** Requests, matched requests and impressions per day, app, ad format and
 * app version: the numbers behind match rate and show rate. */
export async function fetchAdMobHealth(
  params: FetchEarningsParams,
): Promise<AdHealthRow[]> {
  const rows = await runNetworkReport(
    params,
    ["DATE", "APP", "FORMAT", "APP_VERSION_NAME"],
    ["AD_REQUESTS", "MATCHED_REQUESTS", "IMPRESSIONS"],
  );

  const int = (v: { integerValue?: string } | undefined): number =>
    v?.integerValue ? Number(v.integerValue) : 0;
  const out: AdHealthRow[] = [];
  for (const r of rows) {
    if (!r.row) continue;
    const dims = r.row.dimensionValues;
    const metrics = r.row.metricValues;
    const dateRaw = dims?.DATE?.value;
    const appId = dims?.APP?.value;
    if (!dateRaw || !appId) continue;
    out.push({
      date: compactDateToYmd(dateRaw),
      appId,
      format: dims?.FORMAT?.value ?? "",
      version: dims?.APP_VERSION_NAME?.value ?? "",
      requests: int(metrics?.AD_REQUESTS),
      matched: int(metrics?.MATCHED_REQUESTS),
      impressions: int(metrics?.IMPRESSIONS),
    });
  }

  logger.info("AdMob health report parsed", {
    publisher: params.publisherId,
    rows: out.length,
    range: `${params.startDate}..${params.endDate}`,
  });
  return out;
}
