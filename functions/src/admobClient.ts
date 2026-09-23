// Minimal AdMob Network Reporting API client.
//
// AdMob API authn quirk: it does NOT accept service-account credentials. You
// must use a user-delegated OAuth2 refresh token from an account that has
// access to the AdMob publisher. See
// functions/scripts/get-admob-refresh-token.mjs for the one-time bootstrap.

import { logger } from "firebase-functions/v2";

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

function admobDateToYmd(value: string): string {
  // AdMob returns "YYYYMMDD" for DATE dimension
  if (value.length !== 8) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export async function fetchAdMobEarnings(
  params: FetchEarningsParams,
): Promise<DailyAppEarnings[]> {
  const accessToken = await getAccessToken(params.creds);

  const reportSpec: Record<string, unknown> = {
    dateRange: {
      startDate: ymdToDateObj(params.startDate),
      endDate: ymdToDateObj(params.endDate),
    },
    dimensions: ["DATE", "APP"],
    metrics: ["ESTIMATED_EARNINGS", "IMPRESSIONS"],
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
  let rows: ReportRow[];
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? (parsed as ReportRow[]) : [parsed];
  } catch {
    rows = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReportRow);
  }

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
    out.push({ date: admobDateToYmd(dateRaw), appId, usd, impressions });
  }

  logger.info("AdMob report parsed", {
    publisher: params.publisherId,
    rows: out.length,
    range: `${params.startDate}..${params.endDate}`,
  });
  return out;
}
