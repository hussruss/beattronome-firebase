// Pure pieces of the backoffice's "move to another number" for rudiments
// and patterns. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { exerciseId, exerciseKind, replaceSavedIds } from "../src/renumber.ts";

test("exerciseKind knows rudiments and patterns only", () => {
  assert.equal(exerciseKind("rudiments")?.userCollection, "my_rudiments");
  assert.equal(exerciseKind("patterns")?.idPrefix, "pattern");
  assert.equal(exerciseKind("grooves"), null);
  assert.equal(exerciseKind(undefined), null);
});

test("exerciseId joins the prefix and the number", () => {
  assert.equal(exerciseId("rudiment", 41), "rudiment_41");
});

test("replaceSavedIds swaps the old id in place and drops duplicates", () => {
  assert.deepEqual(
    replaceSavedIds(["rudiment_2", "rudiment_1", "rudiment_5"], ["rudiment_1"], "rudiment_41"),
    ["rudiment_2", "rudiment_41", "rudiment_5"],
  );
  assert.deepEqual(
    replaceSavedIds(["a", "old", "new", 7], ["old", "legacy"], "new"),
    ["a", "new"],
  );
  assert.deepEqual(replaceSavedIds([], ["old"], "new"), []);
});
