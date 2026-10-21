import "./admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { sendPushToAdmins } from "./fcmHelpers";
import { isNotificationEnabled } from "./notificationConfig";

interface SubscriptionEntry {
  is_sandbox?: boolean;
  store?: string;
}

interface CustomerDoc {
  original_app_user_id?: string;
  first_seen?: string;
  subscriptions?: Record<string, SubscriptionEntry>;
  entitlements?: Record<string, unknown>;
}

function pickFirstSubscription(
  subs: Record<string, SubscriptionEntry> | undefined,
): { productId: string; entry: SubscriptionEntry } | null {
  if (!subs) return null;
  const keys = Object.keys(subs);
  if (keys.length === 0) return null;
  const productId = keys[0];
  return { productId, entry: subs[productId] };
}

function isSandbox(entry: SubscriptionEntry | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.is_sandbox === "boolean") return entry.is_sandbox;
  const store = entry.store?.toLowerCase() ?? "";
  return store.includes("sandbox");
}

export const notifyOnNewCustomer = onDocumentCreated(
  {
    document: "customers/{customerId}",
    region: "us-central1",
    retry: false,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("notifyOnNewCustomer: missing snapshot");
      return;
    }
    if (!(await isNotificationEnabled("on_new_customer"))) {
      logger.info("notifyOnNewCustomer: muted via config");
      return;
    }
    const data = snap.data() as CustomerDoc;
    const customerId = event.params.customerId;

    const first = pickFirstSubscription(data.subscriptions);
    if (first && isSandbox(first.entry)) {
      logger.info("Skipping sandbox customer", { customerId });
      return;
    }

    const productId = first?.productId ?? "";
    const store = first?.entry.store ?? "";
    const detail = [productId, store].filter(Boolean).join(" · ");
    const body = detail
      ? `🎉 New customer subscribed — ${detail}`
      : "🎉 New customer subscribed!";

    await sendPushToAdmins({
      title: "Congratulations!! 🎉",
      body,
      data: {
        type: "new_customer",
        customerId,
        productId,
      },
      logContext: { customerId, productId },
    });
  },
);
