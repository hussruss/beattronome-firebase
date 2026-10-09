// Unit tests for the practice-metric aggregation. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateDay,
  aggregateWeek,
  buildAliasMap,
  compareVersions,
  datesBetween,
  isoWeek,
  resolveUser,
  type PracticeDayDoc,
} from "../src/practice.ts";

const doc = (p: Partial<PracticeDayDoc> & { user_key: string; date: string }):
  PracticeDayDoc => ({ seconds: 0, runs: 1, modes: {}, ...p });

test("buildAliasMap maps every merged guest uid to its account", () => {
  const map = buildAliasMap([
    { uid: "B", mergedGuestUids: ["A1", "A2", "B"] },
    { uid: "C" },
  ]);
  assert.equal(map.get("A1"), "B");
  assert.equal(map.get("A2"), "B");
  assert.equal(map.has("B"), false);
  assert.equal(resolveUser("A1", map), "B");
  assert.equal(resolveUser("Z", map), "Z");
});

test("resolveUser stops on cycles", () => {
  const map = new Map([["A", "B"], ["B", "A"]]);
  assert.ok(["A", "B"].includes(resolveUser("A", map)));
});

test("aggregateDay applies the 60 s threshold per user-day", () => {
  const day = aggregateDay("2026-10-08", [
    doc({ user_key: "u1", date: "2026-10-08", seconds: 90, is_premium: true,
      modes: { rudiments: 90 }, content: { "rudiment:12": 90 } }),
    doc({ user_key: "u2", date: "2026-10-08", seconds: 30, is_premium: true }),
    doc({ user_key: "u3", date: "2026-10-08", seconds: 300, is_premium: false,
      modes: { basic: 300 } }),
    doc({ user_key: "anon:x", date: "2026-10-08", seconds: 70 }),
  ], new Map());
  assert.equal(day.segments.premium.users_any, 2);
  assert.equal(day.segments.premium.practicing_users, 1);
  assert.equal(day.segments.free.practicing_users, 1);
  assert.equal(day.segments.unknown.practicing_users, 1);
  assert.equal(day.by_mode.rudiments, 90);
  assert.equal(day.by_mode.basic, 300);
  assert.equal(day.by_content_type.rudiment, 90);
});

test("aggregateDay merges a guest and its account into one user-day", () => {
  const aliases = new Map([["A", "B"]]);
  const day = aggregateDay("2026-10-08", [
    doc({ user_key: "A", date: "2026-10-08", seconds: 40 }),
    doc({ user_key: "B", date: "2026-10-08", seconds: 40, is_premium: true }),
  ], aliases);
  assert.equal(day.segments.premium.users_any, 1);
  assert.equal(day.segments.premium.practicing_users, 1);
  assert.equal(day.segments.premium.seconds, 80);
  assert.equal(day.segments.unknown.users_any, 0);
});

test("aggregateWeek: distribution and north star with zeros counted", () => {
  const week = isoWeek("2026-10-08");
  const docs: PracticeDayDoc[] = [
    // sub1 practices 3 days
    ...["2026-10-05", "2026-10-06", "2026-10-07"].map((date) =>
      doc({ user_key: "s1", anon_id: "i1", date, seconds: 120, is_premium: true })),
    // sub2 practices 1 day
    doc({ user_key: "s2", anon_id: "i2", date: "2026-10-08", seconds: 61, is_premium: true }),
    // below threshold, doesn't count
    doc({ user_key: "s2", anon_id: "i2", date: "2026-10-09", seconds: 20, is_premium: true }),
    // free user, 2 days
    ...["2026-10-05", "2026-10-11"].map((date) =>
      doc({ user_key: "f1", anon_id: "i9", date, seconds: 600, is_premium: false })),
    // outside the week
    doc({ user_key: "s1", anon_id: "i1", date: "2026-10-12", seconds: 999, is_premium: true }),
  ];
  // i3: an active subscriber who never practiced.
  const w = aggregateWeek(week, docs, new Map(), new Set(["i1", "i2", "i3"]));
  assert.equal(w.week, "2026-W41");
  assert.equal(w.segments.premium.practicing_users, 2);
  assert.deepEqual(w.segments.premium.days_distribution, [1, 0, 1, 0, 0, 0, 0]);
  assert.equal(w.segments.premium.avg_days_per_practicing_user, 2);
  assert.equal(w.segments.free.practicing_users, 1);
  assert.equal(w.subscribers.active_subscribers, 3);
  assert.equal(w.subscribers.practicing_subscribers, 2);
  assert.equal(w.subscribers.avg_practice_days_per_subscriber, 1.33);
  assert.equal(w.subscribers.pct_subscribers_practicing, 66.67);
});

test("aggregateWeek: install-level seconds add up across uid docs", () => {
  const week = isoWeek("2026-10-08");
  const w = aggregateWeek(week, [
    doc({ user_key: "A", anon_id: "i1", date: "2026-10-08", seconds: 30 }),
    doc({ user_key: "B", anon_id: "i1", date: "2026-10-08", seconds: 30, is_premium: true }),
  ], new Map(), new Set(["i1"]));
  assert.equal(w.subscribers.practicing_subscribers, 1);
});

test("aggregateWeek with no active subscribers reports zeros, not NaN", () => {
  const w = aggregateWeek(isoWeek("2026-10-08"), [], new Map(), new Set());
  assert.equal(w.subscribers.avg_practice_days_per_subscriber, 0);
  assert.equal(w.subscribers.pct_subscribers_practicing, 0);
});

test("isoWeek handles year boundaries", () => {
  assert.deepEqual(isoWeek("2026-10-08"),
    { id: "2026-W41", start: "2026-10-05", end: "2026-10-11" });
  assert.equal(isoWeek("2027-01-01").id, "2026-W53");
  assert.equal(isoWeek("2025-12-29").id, "2026-W01");
});

test("datesBetween is inclusive", () => {
  assert.deepEqual(datesBetween("2026-09-30", "2026-10-02"),
    ["2026-09-30", "2026-10-01", "2026-10-02"]);
});

test("compareVersions is numeric", () => {
  assert.ok(compareVersions("1.10.0", "1.9.3") > 0);
  assert.equal(compareVersions("1.7", "1.7.0"), 0);
  assert.ok(compareVersions("1.6.2", "1.7.0") < 0);
});
