import "./admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { sendPushToAdmins } from "./fcmHelpers";
import { isNotificationEnabled } from "./notificationConfig";
import { ActivityLogDoc, paywallFailurePush } from "./paywallPush";

const EVENT_NAME = "paywall_load_failed";

// Firestore triggers can't filter on a field, so this runs for every
// activity log and returns right away unless it is a paywall failure.
export const notifyOnPaywallLoadFailed = onDocumentCreated(
  {
    document: "activity_logs/{logId}",
    region: "us-central1",
    retry: false,
  },
  async (event) => {
    const data = event.data?.data() as ActivityLogDoc | undefined;
    if (data?.name !== EVENT_NAME) return;
    if (!(await isNotificationEnabled("on_paywall_load_failed"))) {
      logger.info("notifyOnPaywallLoadFailed: muted via config");
      return;
    }
    const logId = event.params.logId;
    const { title, body } = paywallFailurePush(data);
    await sendPushToAdmins({
      title,
      body,
      data: { type: EVENT_NAME, logId },
      logContext: { logId },
    });
  },
);
