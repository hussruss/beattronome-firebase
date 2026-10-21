import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  aggregateDay,
  aggregateWeek,
  buildAliasMap,
  compareVersions,
  datesBetween,
  isoWeek,
  type AliasMap,
  type PracticeDayDoc,
} from "./practice";

const PRACTICE_DAYS_COLLECTION = "practice_days";
const DAILY_COLLECTION = "practice_daily";
const WEEKLY_COLLECTION = "practice_weekly";
const USER_SESSIONS_COLLECTION = "user_sessions";

// Days are device-local in the app; the business runs on Mexico City time
// (UTC-6, no DST since 2022) for "today" and for week bounds.
const TIME_ZONE = "America/Mexico_City";
const UTC_OFFSET = "-06:00";

// Late writes (offline devices) keep arriving for a couple of days.
const DAILY_LOOKBACK_DAYS = 3;

// First app version that writes practice_days. Subscribers on older
// versions can't show up in the numerator, so they are left out of the
// denominator too. UPDATE to the actual release version before deploying.
const PRACTICE_MIN_APP_VERSION = "1.6.1";

function localYmd(date: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function loadAliases(): Promise<AliasMap> {
  const snap = await getFirestore()
    .collection("users")
    .where("mergedGuestUids", "!=", null)
    .select("mergedGuestUids")
    .get();
  return buildAliasMap(
    snap.docs.map((d) => ({ uid: d.id, mergedGuestUids: d.get("mergedGuestUids") })),
  );
}

async function loadPracticeDocs(start: string, end: string): Promise<PracticeDayDoc[]> {
  const snap = await getFirestore()
    .collection(PRACTICE_DAYS_COLLECTION)
    .where("date", ">=", start)
    .where("date", "<=", end)
    .select("user_key", "date", "anon_id", "is_premium", "seconds", "runs", "modes", "content")
    .get();
  return snap.docs.map((d) => d.data() as PracticeDayDoc);
}

/** Install ids of subscribers who opened the app in [start, end] on a
 * version that records practice. Needs the (is_premium, date) index. */
async function loadActiveSubscriberInstalls(start: string, end: string): Promise<Set<string>> {
  const from = Timestamp.fromDate(new Date(`${start}T00:00:00${UTC_OFFSET}`));
  const to = Timestamp.fromDate(new Date(`${addDays(end, 1)}T00:00:00${UTC_OFFSET}`));
  const snap = await getFirestore()
    .collection(USER_SESSIONS_COLLECTION)
    .where("is_premium", "==", true)
    .where("date", ">=", from)
    .where("date", "<", to)
    .select("user_id", "app_version")
    .get();
  const installs = new Set<string>();
  for (const d of snap.docs) {
    const id = d.get("user_id");
    const version = d.get("app_version");
    if (typeof id !== "string" || typeof version !== "string") continue;
    if (compareVersions(version, PRACTICE_MIN_APP_VERSION) < 0) continue;
    installs.add(id);
  }
  return installs;
}

/** Recomputes the daily docs for [dates] and the weekly docs of every ISO
 * week they touch. Idempotent: each run overwrites what it computes. */
async function aggregateRange(start: string, end: string): Promise<{
  days: number;
  weeks: string[];
}> {
  const weeks = new Map<string, { id: string; start: string; end: string }>();
  for (const date of datesBetween(start, end)) {
    const w = isoWeek(date);
    weeks.set(w.id, w);
  }
  // Weeks need all their days, so read the union of week bounds.
  const readStart = [...weeks.values()].reduce((m, w) => (w.start < m ? w.start : m), start);
  const readEnd = [...weeks.values()].reduce((m, w) => (w.end > m ? w.end : m), end);

  const [aliases, docs] = await Promise.all([
    loadAliases(),
    loadPracticeDocs(readStart, readEnd),
  ]);

  const byDate = new Map<string, PracticeDayDoc[]>();
  for (const d of docs) {
    const list = byDate.get(d.date) ?? [];
    list.push(d);
    byDate.set(d.date, list);
  }

  const db = getFirestore();
  const writer = db.bulkWriter();
  const failures: unknown[] = [];
  const track = (write: Promise<unknown>): void => {
    write.catch((e: unknown) => failures.push(e));
  };

  const dates = datesBetween(start, end);
  for (const date of dates) {
    const daily = aggregateDay(date, byDate.get(date) ?? [], aliases);
    track(writer.set(db.collection(DAILY_COLLECTION).doc(date), {
      ...daily,
      computed_at: FieldValue.serverTimestamp(),
    }));
  }

  for (const w of weeks.values()) {
    const installs = await loadActiveSubscriberInstalls(w.start, w.end);
    const weekly = aggregateWeek(w, docs, aliases, installs);
    track(writer.set(db.collection(WEEKLY_COLLECTION).doc(w.id), {
      ...weekly,
      min_app_version: PRACTICE_MIN_APP_VERSION,
      computed_at: FieldValue.serverTimestamp(),
    }));
  }

  await writer.close();
  if (failures.length > 0) {
    throw new Error(`aggregatePractice: ${failures.length} Firestore write(s) failed`);
  }
  return { days: dates.length, weeks: [...weeks.keys()] };
}

function lookbackRange(): { start: string; end: string } {
  const today = localYmd(new Date());
  return { start: addDays(today, -DAILY_LOOKBACK_DAYS), end: today };
}

export const aggregatePractice = onSchedule(
  {
    schedule: "every day 04:00",
    timeZone: TIME_ZONE,
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async () => {
    const { start, end } = lookbackRange();
    logger.info("aggregatePractice: computing", { start, end });
    const result = await aggregateRange(start, end);
    logger.info("aggregatePractice: done", result);
  },
);

// Dashboard "recompute" + backfill. Pass {from, to} (YYYY-MM-DD) for an
// arbitrary range; otherwise recomputes the lookback window.
export const aggregatePracticeNow = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
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

    const data = (request.data ?? {}) as { from?: string; to?: string };
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let start: string;
    let end: string;
    if (data.from && data.to) {
      if (!dateRe.test(data.from) || !dateRe.test(data.to) || data.from > data.to) {
        throw new HttpsError("invalid-argument", "from/to must be YYYY-MM-DD, from <= to");
      }
      if (datesBetween(data.from, data.to).length > 120) {
        throw new HttpsError("invalid-argument", "Range too long (max 120 days).");
      }
      start = data.from;
      end = data.to;
    } else {
      ({ start, end } = lookbackRange());
    }

    logger.info("aggregatePracticeNow: triggered", { uid, start, end });
    const result = await aggregateRange(start, end);
    return { ...result, from: start, to: end };
  },
);
