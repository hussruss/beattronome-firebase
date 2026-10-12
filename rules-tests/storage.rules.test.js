// Firebase Storage security rules tests. They need the Storage emulator
// (Java), started from the repo root where firebase.json names the rules:
//   cd rules-tests && npm ci && npm run emulator
// CI runs them on every change to storage.rules (.github/workflows).
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteObject, getBytes, ref, uploadBytes } from "firebase/storage";

let env;

const admin = () => env.authenticatedContext("admin", { admin: true }).storage();
const user = (uid = "alice") => env.authenticatedContext(uid).storage();
const guest = () => env.unauthenticatedContext().storage();

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const image = { contentType: "image/png" };

/** Puts a file in place bypassing the rules. */
async function seed(path) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), path), png, image);
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-beattronome",
    storage: { rules: readFileSync("../storage.rules", "utf8") },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearStorage();
});

const folders = [
  "rudiments",
  "patterns",
  "grooves",
  "banners",
  "posts",
  "stories",
  "sessions",
];

describe("public pictures", () => {
  for (const folder of folders) {
    test(`${folder}: anyone opens them, only admins upload or delete`, async () => {
      await seed(`${folder}/x.png`);
      await assertSucceeds(getBytes(ref(guest(), `${folder}/x.png`)));
      await assertSucceeds(getBytes(ref(user(), `${folder}/x.png`)));
      await assertFails(uploadBytes(ref(user(), `${folder}/y.png`), png, image));
      await assertFails(deleteObject(ref(user(), `${folder}/x.png`)));
      await assertSucceeds(uploadBytes(ref(admin(), `${folder}/y.png`), png, image));
      await assertSucceeds(deleteObject(ref(admin(), `${folder}/x.png`)));
    });
  }

  test("the Studio replaces a picture in another format", async () => {
    await seed("rudiments/abc.png");
    await assertSucceeds(
      uploadBytes(ref(admin(), "rudiments/abc.webp"), png, {
        contentType: "image/webp",
      }),
    );
    await assertSucceeds(deleteObject(ref(admin(), "rudiments/abc.png")));
  });

  test("admins upload pictures only, under 10 MB", async () => {
    await assertFails(
      uploadBytes(ref(admin(), "rudiments/a.txt"), png, {
        contentType: "text/plain",
      }),
    );
    await assertFails(
      uploadBytes(
        ref(admin(), "rudiments/big.png"),
        new Uint8Array(11 * 1024 * 1024),
        image,
      ),
    );
  });
});

describe("everything else", () => {
  test("is closed, admins included", async () => {
    await seed("other/x.png");
    await seed("rudiments/nested/x.png");
    await assertFails(getBytes(ref(guest(), "other/x.png")));
    await assertFails(getBytes(ref(admin(), "other/x.png")));
    await assertFails(uploadBytes(ref(admin(), "other/y.png"), png, image));
    await assertFails(getBytes(ref(admin(), "rudiments/nested/x.png")));
  });
});
