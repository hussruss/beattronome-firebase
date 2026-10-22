// Pure helper for notifyOnPaywallLoadFailed, kept apart so tests can
// import it without initializing the Admin SDK.

export interface ActivityLogDoc {
  name?: string;
  payload?: {
    source?: string;
    code?: string;
    error?: string;
    error_message?: string;
  };
  platform?: string;
  app_version?: string;
  device_details?: { model?: string };
}

// Builds the push for a paywall that showed no plans.
export function paywallFailurePush(
  data: ActivityLogDoc,
): { title: string; body: string } {
  const p = data.payload ?? {};
  // RevenueCat's code (sent by app builds after 2026-10-21) says why;
  // older builds only send the generic error text.
  const why = p.code ?? p.error ?? "unknown error";
  const device = [data.platform, data.device_details?.model, data.app_version]
    .filter(Boolean)
    .join(" · ");
  const body = [why, p.source && `from ${p.source}`, device && `(${device})`]
    .filter(Boolean)
    .join(" ");
  return { title: "Paywall failed to load", body };
}
