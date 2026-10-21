// Minimal App Store Connect API client — Analytics Reports only.
//
// Auth quirk vs. the GA4/AdMob clients: App Store Connect does NOT accept a
// Google service account or an OAuth refresh token. It uses its own API
// Key (a .p8 EC private key + Key ID + Issuer ID), generated in App Store
// Connect > Users and Access > Integrations > App Store Connect API.
// Generating the key needs an Account Holder or Admin; a key with the
// "App Manager" (or "Finance"/"Analytics" — check what App Store Connect
// currently offers) role is enough to READ analytics reports afterwards.
//
// The key itself is a short-lived JWT (ES256, capped at 20 minutes by
// Apple) built by hand here instead of pulling in `jsonwebtoken`: Node's
// built-in `crypto` can sign with `SHA256`/`prime256v1`, it just emits a
// DER-encoded signature where JWS wants the raw 64-byte r||s
// concatenation — `derToJose` below does that conversion. Verified against
// a locally-generated EC key pair (sign -> derToJose -> convert back to
// DER -> crypto.verify) before shipping this; see the commit that added
// this file for that test if the conversion is ever suspected of being
// the problem.
//
// Analytics data itself comes back through a three-step, asynchronous
// flow (not a single call like GA4/AdMob):
//   1. Create (or reuse) an ONGOING report request for the app.
//   2. List the reports under that request, find the one matching the
//      report name you want (e.g. "App Store Installation and Deletion
//      Standard"), list its instances (one per day/granularity once
//      Apple has finished processing it).
//   3. List the segments of the instance you want and download each
//      segment's signed URL — a gzip-compressed, tab-separated CSV.

import { createSign } from "crypto";
import { gunzipSync } from "zlib";
import { logger } from "firebase-functions/v2";

export interface AppStoreConnectCreds {
  keyId: string;
  issuerId: string;
  privateKeyPem: string; // the .p8 file's contents, unmodified.
}

const API_BASE = "https://api.appstoreconnect.apple.com/v1";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ECDSA P-256 signatures from Node's crypto.sign() are DER-encoded
// (SEQUENCE of two INTEGERs); JWS ES256 wants the raw 32-byte-each r||s
// concatenation instead. This walks the DER by hand rather than pulling
// in a dependency just for this.
function derToJose(der: Buffer): Buffer {
  let offset = 2; // skip the outer SEQUENCE tag + length byte(s).
  function readInt(): Buffer {
    if (der[offset] !== 0x02) {
      throw new Error("Expected INTEGER in DER-encoded ECDSA signature");
    }
    offset++;
    const len = der[offset];
    offset++;
    let bytes = der.subarray(offset, offset + len);
    offset += len;
    // DER pads with a leading 0x00 to keep the value non-negative; JOSE
    // wants exactly 32 bytes with no such padding.
    if (bytes.length > 32) bytes = bytes.subarray(bytes.length - 32);
    if (bytes.length < 32) {
      const padded = Buffer.alloc(32);
      bytes.copy(padded, 32 - bytes.length);
      bytes = padded;
    }
    return bytes;
  }
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

function buildJwt(creds: AppStoreConnectCreds): string {
  const header = { alg: "ES256", kid: creds.keyId, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  // Apple rejects anything over 20 minutes; stay a minute under.
  const payload = {
    iss: creds.issuerId,
    iat: now,
    exp: now + 19 * 60,
    aud: "appstoreconnect-v1",
  };
  const signingInput =
    `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const sign = createSign("SHA256");
  sign.update(signingInput);
  sign.end();
  const der = sign.sign(creds.privateKeyPem);
  return `${signingInput}.${base64url(derToJose(der))}`;
}

async function apiFetch<T>(
  creds: AppStoreConnectCreds,
  path: string,
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${buildJwt(creds)}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `App Store Connect API failed (${res.status}) ${path}: ${text}`,
    );
  }
  return (await res.json()) as T;
}

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}
interface JsonApiList {
  data: JsonApiResource[];
}

/** Finds the existing ONGOING report request for the app, or creates one.
 * Apple rejects a second ONGOING request for the same app with a 409, so
 * this always lists first. */
export async function ensureOngoingReportRequest(
  creds: AppStoreConnectCreds,
  appId: string,
): Promise<string> {
  const existing = await apiFetch<JsonApiList>(
    creds,
    `/apps/${appId}/analyticsReportRequests?filter[accessType]=ONGOING`,
  );
  if (existing.data.length > 0) return existing.data[0].id;

  const res = await fetch(`${API_BASE}/analyticsReportRequests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${buildJwt(creds)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType: "ONGOING" },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Could not create analytics report request (${res.status}): ${text}`,
    );
  }
  const created = (await res.json()) as { data: JsonApiResource };
  logger.info("appStoreConnect: created ONGOING report request", {
    appId,
    requestId: created.data.id,
  });
  return created.data.id;
}

/** Finds the report, under a request, whose name contains `nameContains`
 * (case-insensitive) — a substring match rather than an exact string so a
 * minor naming difference in Apple's catalog doesn't silently match
 * nothing. Logs every available name if none match, so a real deploy
 * surfaces the mismatch immediately instead of failing quietly. */
export async function findReportId(
  creds: AppStoreConnectCreds,
  reportRequestId: string,
  category: string,
  nameContains: string,
): Promise<string | null> {
  const resp = await apiFetch<JsonApiList>(
    creds,
    `/analyticsReportRequests/${reportRequestId}/reports` +
      `?filter[category]=${encodeURIComponent(category)}`,
  );
  const needle = nameContains.toLowerCase();
  const match = resp.data.find((r) =>
    String(r.attributes?.name ?? "").toLowerCase().includes(needle),
  );
  if (!match) {
    logger.warn("appStoreConnect: no report matched", {
      category,
      nameContains,
      available: resp.data.map((r) => r.attributes?.name),
    });
    return null;
  }
  return match.id;
}

interface ReportInstance extends JsonApiResource {
  attributes?: { granularity?: string; processingDate?: string };
}

/** Most recent instances of a report, newest first. `granularity` is
 * usually "DAILY" for the reports this pipeline cares about. */
export async function listRecentInstances(
  creds: AppStoreConnectCreds,
  reportId: string,
  limit = 10,
): Promise<ReportInstance[]> {
  const resp = await apiFetch<{ data: ReportInstance[] }>(
    creds,
    `/analyticsReports/${reportId}/instances?limit=${limit}`,
  );
  return resp.data.sort((a, b) =>
    (b.attributes?.processingDate ?? "").localeCompare(
      a.attributes?.processingDate ?? "",
    ),
  );
}

interface Segment extends JsonApiResource {
  attributes?: { url?: string };
}

/** Downloads every segment of an instance and returns them already
 * gunzipped, as raw TSV text (Apple's analytics reports are
 * tab-separated, not comma-separated). */
export async function downloadInstanceSegments(
  creds: AppStoreConnectCreds,
  instanceId: string,
): Promise<string[]> {
  const resp = await apiFetch<{ data: Segment[] }>(
    creds,
    `/analyticsReportInstances/${instanceId}/segments`,
  );
  const out: string[] = [];
  for (const segment of resp.data) {
    const url = segment.attributes?.url;
    if (!url) continue;
    // Segment URLs are pre-signed — no Authorization header needed/wanted.
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Segment download failed (${res.status}): ${url}`);
    }
    const gz = Buffer.from(await res.arrayBuffer());
    out.push(gunzipSync(gz).toString("utf-8"));
  }
  return out;
}

// Kept importable from here for existing callers; lives in ./parsing.
export { parseTsv } from "./parsing";
