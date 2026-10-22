import { test } from "node:test";
import assert from "node:assert/strict";
import { isOfflineFailure, paywallFailurePush } from "../src/paywallPush.ts";

test("paywall push leads with RevenueCat's code", () => {
  const push = paywallFailurePush({
    name: "paywall_load_failed",
    payload: {
      code: "networkError",
      error: "Failed to load subscription packages",
      source: "premium_action_guard",
    },
    platform: "Android",
    app_version: "1.6.1",
    device_details: { model: "Pixel 7" },
  });
  assert.equal(push.title, "Paywall failed to load");
  assert.equal(
    push.body,
    "networkError from premium_action_guard (Android · Pixel 7 · 1.6.1)",
  );
});

test("paywall push falls back to the generic error from older builds", () => {
  const push = paywallFailurePush({
    payload: { error: "Failed to load subscription packages" },
  });
  assert.equal(push.body, "Failed to load subscription packages");
});

test("offline failures are recognized and skipped", () => {
  assert.equal(
    isOfflineFailure({ payload: { has_connectivity: "false" } }),
    true,
  );
  assert.equal(
    isOfflineFailure({ payload: { has_connectivity: "true" } }),
    false,
  );
  // Older builds don't send the flag: they still notify.
  assert.equal(isOfflineFailure({ payload: {} }), false);
});
