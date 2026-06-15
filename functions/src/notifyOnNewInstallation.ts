import "./admin";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { sendPushToAdmins } from "./fcmHelpers";
import { isNotificationEnabled } from "./notificationConfig";

interface InstallationDoc {
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
  referrer?: string;
}

export const notifyOnNewInstallation = onDocumentCreated(
  {
    document: "new_installations/{installationId}",
    region: "us-central1",
    retry: false,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("notifyOnNewInstallation: missing snapshot");
      return;
    }
    if (!(await isNotificationEnabled("on_new_installation"))) {
      logger.info("notifyOnNewInstallation: muted via config");
      return;
    }
    const data = snap.data() as InstallationDoc;
    const installationId = event.params.installationId;
    const platform = data.platform ?? "Unknown";
    const model = data.device_details?.model ?? "";
    const appVersion = data.app_version ?? "";
    const locale = data.locale ?? "";

    const head = [platform, model].filter(Boolean).join(" · ");
    const tail = [appVersion, locale].filter(Boolean).join(" · ");
    const body = tail ? `${head} (${tail})` : head || "New install";

    await sendPushToAdmins({
      title: "New installation!",
      body,
      data: {
        type: "new_installation",
        installationId,
        platform,
      },
      logContext: { installationId },
    });
  },
);
