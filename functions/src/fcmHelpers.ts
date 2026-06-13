import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const USERS_BO_COLLECTION = "users_bo";
const FCM_MULTICAST_BATCH = 500;

interface UserBoDoc {
  fcmTokens?: string[];
}

export interface FcmResponseSummary {
  success: boolean;
  error?: { code?: string };
}

export interface AdminTokens {
  tokensByDoc: Map<string, string[]>;
  total: number;
}

export async function loadAdminTokens(): Promise<AdminTokens> {
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

export async function pruneInvalidTokens(
  tokensByDoc: Map<string, string[]>,
  flatTokens: string[],
  responses: FcmResponseSummary[],
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

export interface SendPushOptions {
  title: string;
  body: string;
  data: Record<string, string>;
  logContext: Record<string, unknown>;
}

export async function sendPushToAdmins(opts: SendPushOptions): Promise<void> {
  const { tokensByDoc, total } = await loadAdminTokens();
  if (total === 0) {
    logger.info("No backoffice FCM tokens — skipping push", opts.logContext);
    return;
  }

  const flatTokens = Array.from(tokensByDoc.values()).flat();
  const messaging = getMessaging();
  const allResponses: FcmResponseSummary[] = [];

  for (let i = 0; i < flatTokens.length; i += FCM_MULTICAST_BATCH) {
    const chunk = flatTokens.slice(i, i + FCM_MULTICAST_BATCH);
    const res = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: { title: opts.title, body: opts.body },
      data: opts.data,
    });
    allResponses.push(
      ...res.responses.map((r) => ({
        success: r.success,
        error: r.error ? { code: r.error.code } : undefined,
      })),
    );
    const failures = res.responses
      .map((r, idx) => ({ r, token: chunk[idx] }))
      .filter(({ r }) => !r.success)
      .map(({ r, token }) => ({
        code: r.error?.code,
        message: r.error?.message,
        tokenSuffix: token.slice(-12),
      }));
    logger.info("Multicast batch sent", {
      ...opts.logContext,
      chunk: chunk.length,
      success: res.successCount,
      failure: res.failureCount,
      failures,
    });
  }

  await pruneInvalidTokens(tokensByDoc, flatTokens, allResponses);
}
