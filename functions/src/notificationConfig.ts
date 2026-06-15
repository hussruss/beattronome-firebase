import { getFirestore } from "firebase-admin/firestore";

// Single-doc, global-to-the-tenant notification preferences. Missing fields
// resolve to ON so a stale or partial doc never accidentally mutes anything.
const CONFIG_COLLECTION = "config";
const CONFIG_DOC = "notifications";

export type NotificationKey =
  | "on_new_installation"
  | "on_new_user_session"
  | "on_new_customer";

interface NotificationConfigDoc {
  on_new_installation?: boolean;
  on_new_user_session?: boolean;
  on_new_customer?: boolean;
}

export async function isNotificationEnabled(
  key: NotificationKey,
): Promise<boolean> {
  const db = getFirestore();
  const snap = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
  if (!snap.exists) return true;
  const data = snap.data() as NotificationConfigDoc | undefined;
  const value = data?.[key];
  return value !== false;
}
