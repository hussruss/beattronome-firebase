// Unit tests for the guest → account merge checks. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkAccount,
  checkGuestToken,
  checkPriorMerge,
  readRequest,
  stringIds,
} from "../src/guestMerge.ts";

const valid = { account_uid: "B", guest_uid: "A", guest_id_token: "jwt", status: "pending" };

test("readRequest accepts a well-formed request", () => {
  assert.deepEqual(readRequest(valid), {
    ok: true,
    value: { accountUid: "B", guestUid: "A", token: "jwt" },
  });
});

test("readRequest rejects missing pieces and self-merges", () => {
  assert.deepEqual(readRequest(undefined), { ok: false, reason: "missing_data" });
  assert.deepEqual(readRequest({ ...valid, account_uid: "" }), { ok: false, reason: "missing_account" });
  assert.deepEqual(readRequest({ ...valid, guest_uid: 3 }), { ok: false, reason: "missing_guest" });
  assert.deepEqual(readRequest({ ...valid, guest_id_token: undefined }), { ok: false, reason: "missing_token" });
  assert.deepEqual(readRequest({ ...valid, guest_uid: "B" }), { ok: false, reason: "same_user" });
});

test("checkGuestToken: must be the guest's own anonymous token", () => {
  const anon = { uid: "A", firebase: { sign_in_provider: "anonymous" } };
  assert.equal(checkGuestToken(anon, "A"), null);
  // Someone else's token (e.g. the attacker's own guest session).
  assert.equal(checkGuestToken({ ...anon, uid: "X" }, "A"), "token_not_guest");
  // A real account's token never gets merged away.
  assert.equal(
    checkGuestToken({ uid: "A", firebase: { sign_in_provider: "google.com" } }, "A"),
    "token_not_anonymous",
  );
  assert.equal(checkGuestToken({ uid: "A" }, "A"), "token_not_anonymous");
});

test("checkPriorMerge: idempotent for the same account, refused for another", () => {
  assert.equal(checkPriorMerge(undefined, "B"), null);
  assert.equal(checkPriorMerge(null, "B"), null);
  assert.equal(checkPriorMerge("B", "B"), null);
  assert.equal(checkPriorMerge("C", "B"), "already_merged_elsewhere");
});

test("checkAccount: only into an account with a sign-in provider", () => {
  assert.equal(checkAccount(1), null);
  assert.equal(checkAccount(0), "account_is_guest");
});

test("stringIds keeps unique non-empty strings", () => {
  assert.deepEqual(stringIds(["a", "b", "a", "", 3, null]), ["a", "b"]);
  assert.deepEqual(stringIds("a"), []);
  assert.deepEqual(stringIds(undefined), []);
});
