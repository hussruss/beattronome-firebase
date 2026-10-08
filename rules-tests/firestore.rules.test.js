// Firestore security rules tests. They need the Firestore emulator (Java):
//   cd rules-tests && npm ci && npm run emulator
// CI runs them on every change to firestore.rules (.github/workflows).
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

let env;

const admin = () => env.authenticatedContext("admin", { admin: true }).firestore();
const user = (uid = "alice") => env.authenticatedContext(uid).firestore();
const guest = () => env.unauthenticatedContext().firestore();

/** Writes fixture docs bypassing the rules. */
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-beattronome",
    firestore: { rules: readFileSync("../firestore.rules", "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe("catalogue (rudiments, patterns, grooves)", () => {
  for (const name of ["rudiments", "patterns", "grooves"]) {
    test(`${name}: anyone reads, only admins write`, async () => {
      await seed(`${name}/x`, { premium: true, downloadCount: 3 });
      await assertSucceeds(getDoc(doc(guest(), `${name}/x`)));
      await assertFails(setDoc(doc(user(), `${name}/y`), { premium: false }));
      await assertFails(updateDoc(doc(user(), `${name}/x`), { premium: false }));
      await assertFails(deleteDoc(doc(user(), `${name}/x`)));
      await assertSucceeds(setDoc(doc(admin(), `${name}/y`), { premium: true }));
    });

    test(`${name}: a signed-in user may only bump downloadCount by one`, async () => {
      await seed(`${name}/x`, { premium: true, downloadCount: 3 });
      await assertSucceeds(updateDoc(doc(user(), `${name}/x`), { downloadCount: 4 }));
      await assertFails(updateDoc(doc(user(), `${name}/x`), { downloadCount: 10 }));
      await assertFails(
        updateDoc(doc(user(), `${name}/x`), { downloadCount: 5, premium: false }),
      );
      await assertFails(updateDoc(doc(guest(), `${name}/x`), { downloadCount: 5 }));
    });
  }
});

describe("users and personal libraries", () => {
  test("users/{uid}: only the owner or an admin", async () => {
    await seed("users/alice", { name: "A" });
    await assertSucceeds(getDoc(doc(user("alice"), "users/alice")));
    await assertFails(getDoc(doc(user("bob"), "users/alice")));
    await assertFails(getDoc(doc(guest(), "users/alice")));
    await assertSucceeds(getDoc(doc(admin(), "users/alice")));
  });

  for (const name of ["my_rudiments", "my_patterns"]) {
    test(`${name}/{uid}: only the owner`, async () => {
      await assertSucceeds(setDoc(doc(user("alice"), `${name}/alice`), { ids: [] }));
      await assertFails(getDoc(doc(user("bob"), `${name}/alice`)));
      await assertFails(setDoc(doc(user("bob"), `${name}/alice`), { ids: [] }));
    });
  }

  test("users_bo: owner updates only whitelisted keys", async () => {
    await seed("users_bo/alice", { name: "A", role: "viewer" });
    await assertSucceeds(updateDoc(doc(user("alice"), "users_bo/alice"), { name: "B" }));
    await assertFails(updateDoc(doc(user("alice"), "users_bo/alice"), { role: "admin" }));
    await assertFails(getDoc(doc(user("bob"), "users_bo/alice")));
  });
});

describe("sessions", () => {
  test("owner and admins read private sessions, others only public ones", async () => {
    await seed("sessions/private", { authorId: "alice", isPublic: false });
    await seed("sessions/public", { authorId: "alice", isPublic: true });
    await assertSucceeds(getDoc(doc(user("alice"), "sessions/private")));
    await assertFails(getDoc(doc(user("bob"), "sessions/private")));
    await assertSucceeds(getDoc(doc(user("bob"), "sessions/public")));
    await assertSucceeds(getDoc(doc(admin(), "sessions/private")));
  });

  test("the owner's authorId query (sessions list) is allowed", async () => {
    await seed("sessions/s1", { authorId: "alice", isPublic: false });
    await assertSucceeds(
      getDocs(query(collection(user("alice"), "sessions"), where("authorId", "==", "alice"))),
    );
  });

  test("create only as yourself; nobody can take over another's session", async () => {
    await assertSucceeds(
      addDoc(collection(user("alice"), "sessions"), { authorId: "alice", isPublic: false }),
    );
    await assertFails(
      addDoc(collection(user("alice"), "sessions"), { authorId: "bob", isPublic: false }),
    );
    await seed("sessions/s1", { authorId: "alice", isPublic: false });
    await assertFails(updateDoc(doc(user("bob"), "sessions/s1"), { isPublic: true }));
    await assertFails(updateDoc(doc(user("alice"), "sessions/s1"), { authorId: "bob" }));
    await assertFails(deleteDoc(doc(user("bob"), "sessions/s1")));
    await assertSucceeds(deleteDoc(doc(user("alice"), "sessions/s1")));
  });
});

describe("subscriptions and analytics", () => {
  test("customers: owner or admin read, nobody writes from the client", async () => {
    await seed("customers/alice", { entitlements: {} });
    await assertSucceeds(getDoc(doc(user("alice"), "customers/alice")));
    await assertFails(getDoc(doc(user("bob"), "customers/alice")));
    await assertFails(setDoc(doc(user("alice"), "customers/alice"), { entitlements: { premium: {} } }));
  });

  test("customers_events: admin only", async () => {
    await seed("customers_events/e1", { type: "INITIAL_PURCHASE" });
    await assertFails(getDoc(doc(user("alice"), "customers_events/e1")));
    await assertSucceeds(getDoc(doc(admin(), "customers_events/e1")));
  });

  for (const name of ["new_installations", "user_sessions", "activity_logs"]) {
    test(`${name}: anyone creates, only admins read`, async () => {
      await assertSucceeds(addDoc(collection(guest(), name), { at: 1 }));
      await seed(`${name}/x`, { at: 1 });
      await assertFails(getDoc(doc(user(), `${name}/x`)));
      await assertFails(updateDoc(doc(user(), `${name}/x`), { at: 2 }));
      await assertSucceeds(getDoc(doc(admin(), `${name}/x`)));
    });
  }

  for (const name of [
    "ad_revenue",
    "ga4_uninstalls",
    "ga4_events_daily",
    "ga4_users_daily",
    "ga4_uninstall_paths_daily",
    "play_console_daily",
    "asc_installs_daily",
    "asc_engagement_daily",
  ]) {
    test(`${name}: admin read only, no client writes`, async () => {
      await seed(`${name}/d`, { v: 1 });
      await assertFails(getDoc(doc(user(), `${name}/d`)));
      await assertSucceeds(getDoc(doc(admin(), `${name}/d`)));
      await assertFails(setDoc(doc(admin(), `${name}/d2`), { v: 1 }));
    });
  }
});

test("anything not listed is closed", async () => {
  await assertFails(getDoc(doc(admin(), "secrets/x")));
  await assertFails(setDoc(doc(user(), "secrets/x"), { a: 1 }));
});
