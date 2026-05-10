import "./admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const USERS_BO_COLLECTION = "users_bo";
const FCM_MULTICAST_BATCH = 500;

interface UserBoDoc {
  fcmTokens?: string[];
}

async function loadAdminTokens(): Promise<{ tokensByDoc: Map<string, string[]>; total: number }> {
  const db = getFirestore();
  const snap = await db.collection(USERS_BO_COLLECTION).get();
  const tokensByDoc = new Map<string, string[]>();
  let total = 0;
  for (const doc of snap.docs) {
    const data = doc.data() as UserBoDoc;
    const tokens = (data.fcmTokens ?? []).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (tokens.length > 0) {
      tokensByDoc.set(doc.id, tokens);
      total += tokens.length;
    }
  }
  return { tokensByDoc, total };
}

async function pruneInvalidTokens(
  tokensByDoc: Map<string, string[]>,
  flatTokens: string[],
  responses: { success: boolean; error?: { code?: string } }[],
): Promise<void> {
  const invalidCodes = new Set([
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
  ]);
  const invalid = new Set<string>();
  responses.forEach((r, i) => {
    if (!r.success && r.error?.code && invalidCodes.has(r.error.code)) {
      invalid.add(flatTokens[i]);
    }
  });
  if (invalid.size === 0) return;

  const db = getFirestore();
  const batch = db.batch();
  for (const [docId, tokens] of tokensByDoc.entries()) {
    const stale = tokens.filter((t) => invalid.has(t));
    if (stale.length === 0) continue;
    batch.update(db.collection(USERS_BO_COLLECTION).doc(docId), {
      fcmTokens: FieldValue.arrayRemove(...stale),
    });
  }
  await batch.commit();
  logger.info("Pruned invalid FCM tokens", { count: invalid.size });
}

export const notifyOnNewUser = onDocumentCreated(
  {
    document: "users/{userId}",
    region: "us-central1",
    retry: false,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("notifyOnNewUser: missing snapshot");
      return;
    }
    const data = snap.data();
    const userId = event.params.userId;
    const name = (data.name as string | undefined) ?? null;
    const email = (data.email as string | undefined) ?? null;
    const isAnonymous = (data.isAnonymous as boolean | undefined) ?? false;

    if (isAnonymous) {
      logger.info("Skipping push for anonymous user", { userId });
      return;
    }

    const { tokensByDoc, total } = await loadAdminTokens();
    if (total === 0) {
      logger.info("No backoffice FCM tokens — skipping push", { userId });
      return;
    }

    const flatTokens = Array.from(tokensByDoc.values()).flat();
    const displayName = name ?? email ?? "A new user";
    const body = email && name ? `${name} (${email}) just signed up` : `${displayName} just signed up`;

    const messaging = getMessaging();
    const allResponses: { success: boolean; error?: { code?: string } }[] = [];

    for (let i = 0; i < flatTokens.length; i += FCM_MULTICAST_BATCH) {
      const chunk = flatTokens.slice(i, i + FCM_MULTICAST_BATCH);
      const res = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: "New user!",
          body,
        },
        data: {
          type: "new_user",
          userId,
          email: email ?? "",
        },
      });
      allResponses.push(
        ...res.responses.map((r) => ({
          success: r.success,
          error: r.error ? { code: r.error.code } : undefined,
        })),
      );
      logger.info("Multicast batch sent", {
        chunk: chunk.length,
        success: res.successCount,
        failure: res.failureCount,
      });
    }

    await pruneInvalidTokens(tokensByDoc, flatTokens, allResponses);
  },
);
