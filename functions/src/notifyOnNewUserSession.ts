import "./admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { sendPushToAdmins } from "./fcmHelpers";
import { isNotificationEnabled } from "./notificationConfig";

interface UserSessionDoc {
  user_id?: string;
  platform?: string;
  device_details?: {
    model?: string;
    manufacturer?: string;
    os_version?: string;
    name?: string;
  };
  app_version?: string;
  locale?: string;
}

export const notifyOnNewUserSession = onDocumentCreated(
  {
    document: "user_sessions/{sessionId}",
    region: "us-central1",
    retry: false,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("notifyOnNewUserSession: missing snapshot");
      return;
    }
    if (!(await isNotificationEnabled("on_new_user_session"))) {
      logger.info("notifyOnNewUserSession: muted via config");
      return;
    }
    const data = snap.data() as UserSessionDoc;
    const sessionId = event.params.sessionId;
    const platform = data.platform ?? "Unknown";
    const model = data.device_details?.model ?? "";
    const appVersion = data.app_version ?? "";
    const locale = data.locale ?? "";

    const head = [platform, model].filter(Boolean).join(" · ");
    const tail = [appVersion, locale].filter(Boolean).join(" · ");
    const body = tail ? `${head} (${tail})` : head || "New user session";

    await sendPushToAdmins({
      title: "New user session",
      body,
      data: {
        type: "new_user_session",
        sessionId,
        platform,
      },
      logContext: { sessionId },
    });
  },
);
