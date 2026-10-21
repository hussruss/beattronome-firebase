/**
 * Pure checks for a guest → account merge request (`guest_merges` docs,
 * written by the app). No Firebase imports, so they are unit-tested
 * without credentials (`npm test`).
 *
 * Design: beattronome/docs/superpowers/specs/2026-10-08-guest-data-merge-design.md
 */

export interface MergeRequest {
  accountUid: string;
  guestUid: string;
  token: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Shape of the request doc. Rules already enforce it; checked again so a
 * doc written some other way can't reach the merge. */
export function readRequest(data: Record<string, unknown> | undefined): Checked<MergeRequest> {
  if (!data) return { ok: false, reason: "missing_data" };
  const { account_uid: accountUid, guest_uid: guestUid, guest_id_token: token } = data;
  if (typeof accountUid !== "string" || accountUid.length === 0) {
    return { ok: false, reason: "missing_account" };
  }
  if (typeof guestUid !== "string" || guestUid.length === 0) {
    return { ok: false, reason: "missing_guest" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing_token" };
  }
  if (accountUid === guestUid) return { ok: false, reason: "same_user" };
  return { ok: true, value: { accountUid, guestUid, token } };
}

/** The parts of a verified ID token the merge relies on. */
export interface GuestToken {
  uid: string;
  firebase?: { sign_in_provider?: string };
}

/**
 * The token must be the guest's own (proof that the request comes from
 * the guest's device: guest uids are not secret) and an anonymous one (a
 * real account is never "merged away"). Expiry is already enforced by
 * verifyIdToken. auth_time is deliberately not checked: for a guest it is
 * when the anonymous session began, which can be months old.
 */
export function checkGuestToken(decoded: GuestToken, guestUid: string): string | null {
  if (decoded.uid !== guestUid) return "token_not_guest";
  if (decoded.firebase?.sign_in_provider !== "anonymous") return "token_not_anonymous";
  return null;
}

/** A guest merges into one account only. Re-asking for the same account is
 * fine (the merge is idempotent); a different account is refused. */
export function checkPriorMerge(mergedInto: unknown, accountUid: string): string | null {
  if (mergedInto === undefined || mergedInto === null) return null;
  return mergedInto === accountUid ? null : "already_merged_elsewhere";
}

/** Only into a real account: one with at least one sign-in provider. */
export function checkAccount(providerCount: number): string | null {
  return providerCount > 0 ? null : "account_is_guest";
}

/** String ids from a Firestore array field; anything else is dropped. */
export function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))];
}
