import "./admin";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { exerciseId, exerciseKind, replaceSavedIds } from "./renumber";

// The backoffice version of beattronome/scripts/firestore_upload's
// migrate_rudiment_numbers.js / migrate_pattern_numbers.js: moves one
// rudiment or pattern to `<prefix>_<to>` and fixes every user's saved list.
//
// Firestore has no rename, so a move writes the doc under the new id with
// `id` set to it (the app reads that field, not the doc key), deletes the
// old doc, and rewrites the old id inside every `my_rudiments` /
// `my_patterns` array that holds it. Without that last step a saved id
// would point at nothing once the old doc is gone.
//
// Same safety model as the scripts: the source must exist and the target
// must not, and `apply: false` is a dry run that already counts the users
// a move would touch. Like them, it doesn't touch feed posts, saved
// sessions, Storage images (the doc keeps its `imageUrl`) or what each
// phone has unlocked locally.

// A batch takes 500 writes; the first one also carries the catalog set
// and delete.
const USERS_PER_BATCH = 400;

interface RenumberRequest {
  kind?: unknown;
  docId?: unknown;
  to?: unknown;
  apply?: unknown;
}

export const renumberExerciseNow = onCall(
  { region: "us-central1", timeoutSeconds: 120, memory: "256MiB" },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");
    const db = getFirestore();
    const adminDoc = await db.collection("users_bo").doc(uid).get();
    if (!adminDoc.exists) {
      throw new HttpsError("permission-denied", "Backoffice users only.");
    }

    const data = (request.data ?? {}) as RenumberRequest;
    const kind = exerciseKind(data.kind);
    if (!kind) {
      throw new HttpsError("invalid-argument", "kind must be rudiments or patterns");
    }
    const docId = typeof data.docId === "string" ? data.docId : "";
    if (!docId || docId.includes("/")) {
      throw new HttpsError("invalid-argument", "docId is required");
    }
    const to = Number(data.to);
    if (!Number.isInteger(to) || to < 1) {
      throw new HttpsError("invalid-argument", "to must be a whole number from 1");
    }
    const apply = data.apply === true;

    const catalog = db.collection(kind.collection);
    const source = await catalog.doc(docId).get();
    if (!source.exists) {
      throw new HttpsError("not-found", `${docId} doesn't exist`);
    }
    const sourceData = source.data() ?? {};
    const name = typeof sourceData.name === "string" ? sourceData.name : "";
    const newId = exerciseId(kind.idPrefix, to);
    if (newId === docId) {
      throw new HttpsError("invalid-argument", `${docId} already has that number`);
    }

    const target = await catalog.doc(newId).get();
    if (target.exists) {
      const targetName = target.data()?.name;
      return {
        fromId: docId,
        toId: newId,
        name,
        targetExists: true,
        targetName: typeof targetName === "string" ? targetName : "",
        affectedUsers: 0,
        applied: false,
      };
    }

    // The saved lists hold the doc's `id` field; it's normally the doc key
    // too, but both are looked up in case an old doc has them apart.
    const oldIds = [
      ...new Set(
        [docId, sourceData.id].filter((v): v is string => typeof v === "string"),
      ),
    ];
    const users = await db
      .collection(kind.userCollection)
      .where(kind.userArrayField, "array-contains-any", oldIds)
      .get();

    const plan = {
      fromId: docId,
      toId: newId,
      name,
      targetExists: false,
      targetName: "",
      affectedUsers: users.size,
    };
    if (!apply) return { ...plan, applied: false };

    // The first batch carries the catalog move with its first users, so the
    // two land together; `create` fails it if the target appeared since the
    // check above.
    const userDocs = users.docs;
    for (let i = 0; i === 0 || i < userDocs.length; i += USERS_PER_BATCH) {
      const batch = db.batch();
      if (i === 0) {
        batch.create(catalog.doc(newId), { ...sourceData, id: newId });
        batch.delete(catalog.doc(docId));
      }
      for (const user of userDocs.slice(i, i + USERS_PER_BATCH)) {
        const saved = user.get(kind.userArrayField);
        batch.update(user.ref, {
          [kind.userArrayField]: replaceSavedIds(
            Array.isArray(saved) ? saved : [],
            oldIds,
            newId,
          ),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }

    logger.info("renumberExerciseNow: moved", {
      uid,
      collection: kind.collection,
      from: docId,
      to: newId,
      users: users.size,
    });
    return { ...plan, applied: true };
  },
);
