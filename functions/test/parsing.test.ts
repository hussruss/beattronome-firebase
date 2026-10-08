// Unit tests for the sync jobs' pure helpers. Run: npm test
// (Node's built-in runner with TypeScript type stripping — no extra deps.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateEarningsByDate,
  compactDateToYmd,
  decodePlayCsv,
  median,
  numOrZero,
  parseCsv,
  parseTsv,
  sumNumericColumnsByDate,
  tally,
  utcYmd,
} from "../src/parsing.ts";

test("utcYmd formats in UTC regardless of local time", () => {
  assert.equal(utcYmd(new Date("2026-10-08T23:30:00-06:00")), "2026-10-09");
  assert.equal(utcYmd(new Date("2026-01-05T00:00:00Z")), "2026-01-05");
});

test("compactDateToYmd converts YYYYMMDD and leaves anything else alone", () => {
  assert.equal(compactDateToYmd("20261008"), "2026-10-08");
  assert.equal(compactDateToYmd("2026-10-08"), "2026-10-08");
  assert.equal(compactDateToYmd(""), "");
});

test("parseTsv keys cells by header and skips blank lines", () => {
  const rows = parseTsv("Date\tCounts\n2026-10-01\t5\n\n2026-10-02\t7\n");
  assert.deepEqual(rows, [
    { Date: "2026-10-01", Counts: "5" },
    { Date: "2026-10-02", Counts: "7" },
  ]);
  assert.deepEqual(parseTsv(""), []);
});

test("parseTsv fills missing trailing cells with empty strings", () => {
  assert.deepEqual(parseTsv("a\tb\n1"), [{ a: "1", b: "" }]);
});

test("decodePlayCsv reads UTF-16LE with BOM (Play overview files)", () => {
  const text = "Date,Daily Device Installs\r\n2026-10-01,12\r\n";
  const bom = Buffer.from([0xff, 0xfe]);
  const buffer = Buffer.concat([bom, Buffer.from(text, "utf16le")]);
  assert.equal(decodePlayCsv(buffer), text);
  assert.equal(decodePlayCsv(Buffer.from("plain", "utf-8")), "plain");
});

test("parseCsv trims cells, strips CR and maps by header", () => {
  const rows = parseCsv("Date , Installs\r\n2026-10-01, 12 \r\n");
  assert.deepEqual(rows, [{ Date: "2026-10-01", Installs: "12" }]);
});

test("Play overview end to end: UTF-16 file to numbers", () => {
  const text =
    "Date,Daily Device Installs,Daily Device Uninstalls\r\n" +
    "2026-10-01,12,3\r\n2026-10-02,,x\r\n";
  const buffer = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, "utf16le"),
  ]);
  const rows = parseCsv(decodePlayCsv(buffer));
  assert.equal(numOrZero(rows[0], "Daily Device Installs"), 12);
  assert.equal(numOrZero(rows[0], "Daily Device Uninstalls"), 3);
  // Empty and non-numeric cells count as 0, never NaN in Firestore.
  assert.equal(numOrZero(rows[1], "Daily Device Installs"), 0);
  assert.equal(numOrZero(rows[1], "Daily Device Uninstalls"), 0);
  assert.equal(numOrZero(rows[1], "Missing Column"), 0);
});

test("sumNumericColumnsByDate sums per day and normalizes column names", () => {
  const byDate = sumNumericColumnsByDate(
    [
      { Date: "2026-10-01", "Total Downloads": "3", Device: "iPhone" },
      { Date: "2026-10-01", "Total Downloads": "4", Device: "iPad" },
      { Date: "2026-10-02", "Total Downloads": "1", Device: "iPhone" },
      { Date: "", "Total Downloads": "99", Device: "iPhone" },
    ],
    "Date",
  );
  assert.deepEqual(byDate.get("2026-10-01"), { total_downloads: 7 });
  assert.deepEqual(byDate.get("2026-10-02"), { total_downloads: 1 });
  assert.equal(byDate.size, 2, "rows without a date are dropped");
});

test("aggregateEarningsByDate splits platforms and keeps unknown apps in totals", () => {
  const byDate = aggregateEarningsByDate(
    [
      { date: "2026-10-01", appId: "ios", usd: 1.5, impressions: 100 },
      { date: "2026-10-01", appId: "android", usd: 2, impressions: 300 },
      { date: "2026-10-01", appId: "other", usd: 0.5, impressions: 10 },
      { date: "2026-10-02", appId: "android", usd: 1, impressions: 50 },
    ],
    "ios",
    "android",
  );
  assert.deepEqual(byDate.get("2026-10-01"), {
    ios: 1.5,
    android: 2,
    total: 4,
    iosImpressions: 100,
    androidImpressions: 300,
    totalImpressions: 410,
  });
  assert.equal(byDate.get("2026-10-02")?.ios, 0);
  assert.equal(byDate.get("2026-10-02")?.android, 1);
});

test("median handles empty, odd and even inputs without mutating", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  const input = [4, 1, 3, 2];
  assert.equal(median(input), 2.5);
  assert.deepEqual(input, [4, 1, 3, 2]);
});

test("tally counts keys and ignores null/empty", () => {
  assert.deepEqual(tally(["a", "b", "a", null, ""]), { a: 2, b: 1 });
});
