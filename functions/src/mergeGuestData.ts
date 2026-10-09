import "./admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue, type Firestore } from "firebase-admin/firestore";
import {
  checkAccount,
  checkGuestToken,
  checkPriorMerge,
  readRequest,
  stringIds,
} from "./guestMerge";

/**
 * Guest → existing account. When a guest (anonymous uid A) signs in to an
 * account that already existed (uid B), the app writes a `guest_merges`
 * doc with A's ID token. This moves what the client can't move itself:
 * A's saved sessions (re-authored in place, so shared links keep working)
 * and, again, A's library ids (the app already added them, so this only
 * matters if that write failed). Then it records the merge on both users.
 *
 * The token is the proof the request comes from A's own device; it is
 * deleted from the doc as soon as the request is handled, whatever the
 * outcome. Outcome in `status`: done | rejected (with `reason`) | error.
 *
 * Design: beattronome/docs/superpowers/specs/2026-10-08-guest-data-merge-design.md
 */
export const mergeGuestData = onDocumentCreated(
  {
    document: "guest_merges/{mergeId}",
    region: "us-central1",
    retry: false,
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("mergeGuestData: missing snapshot");
      return;
    }
    const finish = (fields: Record<string, unknown>) =>
      snap.ref.update({
        ...fields,
        guest_id_token: FieldValue.delete(),
        processed_at: FieldValue.serverTimestamp(),
      });
    const reject = async (reason: string) => {
      logger.warn("mergeGuestData: rejected", { mergeId: event.params.mergeId, reason });
      await finish({ status: "rejected", reason });
    };

    const request = readRequest(snap.data());
    if (!request.ok) return reject(request.reason);
    const { accountUid, guestUid, token } = request.value;

    try {
      let decoded;
      try {
        decoded = await getAuth().verifyIdToken(token);
      } catch {
        return reject("invalid_token");
      }
      const tokenProblem = checkGuestToken(decoded, guestUid);
      if (tokenProblem) return reject(tokenProblem);

      const account = await getAuth().getUser(accountUid);
      const accountProblem = checkAccount(account.providerData.length);
      if (accountProblem) return reject(accountProblem);

      const db = getFirestore();
      const guestUser = await db.collection("users").doc(guestUid).get();
      const priorProblem = checkPriorMerge(guestUser.get("mergedInto"), accountUid);
      if (priorProblem) return reject(priorProblem);

      const moved = await moveGuestData(db, guestUid, accountUid);
      logger.info("mergeGuestData: done", { guestUid, accountUid, ...moved });
      await finish({ status: "done", ...moved });
    } catch (e) {
      logger.error("mergeGuestData: failed", { guestUid, accountUid, error: String(e) });
      await finish({ status: "error", reason: String(e).slice(0, 300) });
    }
  },
);

async function moveGuestData(
  db: Firestore,
  guestUid: string,
  accountUid: string,
): Promise<{ rudiments: number; patterns: number; sessions: number }> {
  const [rudimentsDoc, patternsDoc, sessions] = await Promise.all([
    db.collection("my_rudiments").doc(guestUid).get(),
    db.collection("my_patterns").doc(guestUid).get(),
    db.collection("sessions").where("authorId", "==", guestUid).get(),
  ]);
  const rudimentIds = stringIds(rudimentsDoc.get("rudiments"));
  const patternIds = stringIds(patternsDoc.get("patterns"));

  const writer = db.bulkWriter();
  const failures: unknown[] = [];
  const track = (write: Promise<unknown>): void => {
    write.catch((e: unknown) => failures.push(e));
  };

  if (rudimentIds.length > 0) {
    track(writer.set(
      db.collection("my_rudiments").doc(accountUid),
      { rudiments: FieldValue.arrayUnion(...rudimentIds), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    ));
  }
  if (patternIds.length > 0) {
    track(writer.set(
      db.collection("my_patterns").doc(accountUid),
      { patterns: FieldValue.arrayUnion(...patternIds), updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    ));
  }
  // Re-authored in place: same doc ids, so links already shared still work.
  for (const session of sessions.docs) {
    track(writer.update(session.ref, { authorId: accountUid }));
  }

  const counts = {
    rudiments: rudimentIds.length,
    patterns: patternIds.length,
    sessions: sessions.size,
  };
  track(writer.set(
    db.collection("users").doc(guestUid),
    { mergedInto: accountUid, mergedAt: FieldValue.serverTimestamp() },
    { merge: true },
  ));
  track(writer.set(
    db.collection("users").doc(accountUid),
    {
      mergedGuestUids: FieldValue.arrayUnion(guestUid),
      guestMerges: { [guestUid]: { at: FieldValue.serverTimestamp(), ...counts } },
    },
    { merge: true },
  ));

  await writer.close();
  if (failures.length > 0) {
    throw new Error(`${failures.length} Firestore write(s) failed`);
  }
  return counts;
}
