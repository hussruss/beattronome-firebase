/**
 * Pure aggregation for the practice-frequency metric. No Firebase imports,
 * so it is unit-tested without credentials (`npm test`), like parsing.ts.
 *
 * Input: `practice_days` docs written by the app — one per user per local
 * day, `{userKey}_{YYYY-MM-DD}`, with seconds/runs/modes/content totals.
 * Spec: beattronome/docs/superpowers/plans/2026-10-08-core-engagement-metric-baseline.md
 */

/** A day counts as "practiced" at this many seconds, summed over the day.
 * Applied here, not in the app, so it can change without recapturing. */
export const PRACTICE_DAY_MIN_SECONDS = 60;

export type Segment = "premium" | "free" | "unknown";
const SEGMENTS: Segment[] = ["premium", "free", "unknown"];

export interface PracticeDayDoc {
  user_key: string;
  date: string;
  auth_uid?: string;
  anon_id?: string;
  is_premium?: boolean;
  seconds?: number;
  runs?: number;
  modes?: Record<string, number>;
  content?: Record<string, number>;
}

/** Guest uid → account uid, from `users.mergedGuestUids`. */
export type AliasMap = Map<string, string>;

export function buildAliasMap(
  users: { uid: string; mergedGuestUids?: unknown }[],
): AliasMap {
  const map: AliasMap = new Map();
  for (const u of users) {
    if (!Array.isArray(u.mergedGuestUids)) continue;
    for (const guest of u.mergedGuestUids) {
      if (typeof guest === "string" && guest !== u.uid) map.set(guest, u.uid);
    }
  }
  return map;
}

/** Follows guest → account links (bounded, in case of a cycle). */
export function resolveUser(key: string, aliases: AliasMap): string {
  let current = key;
  for (let i = 0; i < 5; i++) {
    const next = aliases.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

interface UserDay {
  seconds: number;
  runs: number;
  premium: boolean | undefined;
  modes: Record<string, number>;
  contentTypes: Record<string, number>;
}

function mergePremium(
  a: boolean | undefined,
  b: boolean | undefined,
): boolean | undefined {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return undefined;
}

function segmentOf(premium: boolean | undefined): Segment {
  if (premium === true) return "premium";
  if (premium === false) return "free";
  return "unknown";
}

function addInto(target: Record<string, number>, src?: Record<string, number>) {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === "number") target[k] = (target[k] ?? 0) + v;
  }
}

/** `rudiment:12` → `rudiment`. */
function contentTypeTotals(content?: Record<string, number>) {
  const out: Record<string, number> = {};
  if (!content) return out;
  for (const [k, v] of Object.entries(content)) {
    if (typeof v !== "number") continue;
    const type = k.split(":")[0] || "unknown";
    out[type] = (out[type] ?? 0) + v;
  }
  return out;
}

/** Folds one day's docs into one entry per resolved user: a guest and the
 * account it merged into, practicing the same day, are one user-day. */
export function userDaysFor(
  docs: PracticeDayDoc[],
  aliases: AliasMap,
): Map<string, UserDay> {
  const days = new Map<string, UserDay>();
  for (const d of docs) {
    const user = resolveUser(d.user_key, aliases);
    const day = days.get(user) ?? {
      seconds: 0,
      runs: 0,
      premium: undefined,
      modes: {},
      contentTypes: {},
    };
    day.seconds += d.seconds ?? 0;
    day.runs += d.runs ?? 0;
    day.premium = mergePremium(day.premium, d.is_premium);
    addInto(day.modes, d.modes);
    addInto(day.contentTypes, contentTypeTotals(d.content));
    days.set(user, day);
  }
  return days;
}

export interface SegmentDaily {
  /** Users with any recorded run that day. */
  users_any: number;
  /** Users who reached PRACTICE_DAY_MIN_SECONDS that day. */
  practicing_users: number;
  seconds: number;
  runs: number;
}

export interface PracticeDaily {
  date: string;
  threshold_seconds: number;
  segments: Record<Segment, SegmentDaily>;
  /** Seconds by mode / content type, practicing users only. */
  by_mode: Record<string, number>;
  by_content_type: Record<string, number>;
}

function emptySegments<T>(make: () => T): Record<Segment, T> {
  return { premium: make(), free: make(), unknown: make() };
}

export function aggregateDay(
  date: string,
  docs: PracticeDayDoc[],
  aliases: AliasMap,
  threshold = PRACTICE_DAY_MIN_SECONDS,
): PracticeDaily {
  const segments = emptySegments<SegmentDaily>(() => ({
    users_any: 0,
    practicing_users: 0,
    seconds: 0,
    runs: 0,
  }));
  const byMode: Record<string, number> = {};
  const byContentType: Record<string, number> = {};
  for (const day of userDaysFor(docs, aliases).values()) {
    const s = segments[segmentOf(day.premium)];
    s.users_any += 1;
    s.seconds += day.seconds;
    s.runs += day.runs;
    if (day.seconds >= threshold) {
      s.practicing_users += 1;
      addInto(byMode, day.modes);
      addInto(byContentType, day.contentTypes);
    }
  }
  return {
    date,
    threshold_seconds: threshold,
    segments,
    by_mode: byMode,
    by_content_type: byContentType,
  };
}

export interface SegmentWeekly {
  practicing_users: number;
  /** Index i = users who practiced i+1 days (1..7). */
  days_distribution: number[];
  avg_days_per_practicing_user: number;
}

export interface SubscriberWeekly {
  /** Subscriber installs that opened the app this week on a version that
   * records practice — the denominator, so update adoption doesn't drag
   * the metric down. */
  active_subscribers: number;
  practicing_subscribers: number;
  /** North star: practice days per active subscriber (zeros count). */
  avg_practice_days_per_subscriber: number;
  pct_subscribers_practicing: number;
}

export interface PracticeWeekly {
  week: string;
  start: string;
  end: string;
  threshold_seconds: number;
  segments: Record<Segment, SegmentWeekly>;
  subscribers: SubscriberWeekly;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * [docs] are the week's practice_days docs. [activeSubscriberInstalls] are
 * install ids (`user_sessions.user_id` = `practice_days.anon_id`) of
 * subscribers active that week on a tracking version. The subscriber block
 * is joined per install because that is the key user_sessions has.
 */
export function aggregateWeek(
  week: { id: string; start: string; end: string },
  docs: PracticeDayDoc[],
  aliases: AliasMap,
  activeSubscriberInstalls: Set<string>,
  threshold = PRACTICE_DAY_MIN_SECONDS,
): PracticeWeekly {
  const byDate = new Map<string, PracticeDayDoc[]>();
  for (const d of docs) {
    if (d.date < week.start || d.date > week.end) continue;
    const list = byDate.get(d.date) ?? [];
    list.push(d);
    byDate.set(d.date, list);
  }

  // Practiced days per resolved user, and the user's segment for the week
  // (premium if premium on any day, so a mid-week upgrade counts as paying).
  const userDaysCount = new Map<string, number>();
  const userPremium = new Map<string, boolean | undefined>();
  // Practiced days per install, for the subscriber join.
  const installDays = new Map<string, Set<string>>();

  for (const [date, dayDocs] of byDate) {
    for (const [user, day] of userDaysFor(dayDocs, aliases)) {
      userPremium.set(user, mergePremium(userPremium.get(user), day.premium));
      if (day.seconds < threshold) continue;
      userDaysCount.set(user, (userDaysCount.get(user) ?? 0) + 1);
    }
    // Install-level seconds for the day (several docs can share an install
    // when the uid changed mid-day).
    const installSeconds = new Map<string, number>();
    for (const d of dayDocs) {
      if (!d.anon_id) continue;
      installSeconds.set(
        d.anon_id,
        (installSeconds.get(d.anon_id) ?? 0) + (d.seconds ?? 0),
      );
    }
    for (const [install, secs] of installSeconds) {
      if (secs < threshold) continue;
      const set = installDays.get(install) ?? new Set<string>();
      set.add(date);
      installDays.set(install, set);
    }
  }

  const segments = emptySegments<SegmentWeekly>(() => ({
    practicing_users: 0,
    days_distribution: [0, 0, 0, 0, 0, 0, 0],
    avg_days_per_practicing_user: 0,
  }));
  const totals = emptySegments(() => 0);
  for (const [user, n] of userDaysCount) {
    const seg = segmentOf(userPremium.get(user));
    segments[seg].practicing_users += 1;
    segments[seg].days_distribution[Math.min(n, 7) - 1] += 1;
    totals[seg] += n;
  }
  for (const seg of SEGMENTS) {
    const s = segments[seg];
    s.avg_days_per_practicing_user =
      s.practicing_users === 0 ? 0 : round2(totals[seg] / s.practicing_users);
  }

  let practicingSubs = 0;
  let subDays = 0;
  for (const install of activeSubscriberInstalls) {
    const n = installDays.get(install)?.size ?? 0;
    if (n > 0) practicingSubs += 1;
    subDays += Math.min(n, 7);
  }
  const active = activeSubscriberInstalls.size;

  return {
    week: week.id,
    start: week.start,
    end: week.end,
    threshold_seconds: threshold,
    segments,
    subscribers: {
      active_subscribers: active,
      practicing_subscribers: practicingSubs,
      avg_practice_days_per_subscriber: active === 0 ? 0 : round2(subDays / active),
      pct_subscribers_practicing:
        active === 0 ? 0 : round2((practicingSubs / active) * 100),
    },
  };
}

/** ISO-8601 week of a `YYYY-MM-DD` date: id `YYYY-Www`, Monday..Sunday. */
export function isoWeek(ymd: string): { id: string; start: string; end: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - dow);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  // ISO year = year of the week's Thursday.
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Monday = new Date(jan4);
  jan4Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const weekNo =
    1 + Math.round((monday.getTime() - jan4Monday.getTime()) / (7 * 86400000));
  return {
    id: `${isoYear}-W${String(weekNo).padStart(2, "0")}`,
    start: ymdOf(monday),
    end: ymdOf(sunday),
  };
}

function ymdOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` dates from [start] to [end], inclusive. */
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 400; i++) {
    const ymd = ymdOf(cur);
    if (ymd > end) break;
    out.push(ymd);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** Numeric semver compare (`1.10.0` > `1.9.3`); non-numeric parts → 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
