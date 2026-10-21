/**
 * Pure pieces of moving a rudiment or pattern to another id (see
 * renumberExercise.ts). No Firebase imports, so they're unit-testable.
 */

/** Where an exercise kind lives: its catalog collection, the id prefix
 * (`rudiment_12`), and the per-user list of saved ids. */
export interface ExerciseKindConfig {
  collection: string;
  idPrefix: string;
  userCollection: string;
  userArrayField: string;
}

const KINDS: Record<string, ExerciseKindConfig> = {
  rudiments: {
    collection: "rudiments",
    idPrefix: "rudiment",
    userCollection: "my_rudiments",
    userArrayField: "rudiments",
  },
  patterns: {
    collection: "patterns",
    idPrefix: "pattern",
    userCollection: "my_patterns",
    userArrayField: "patterns",
  },
};

/** The config for `rudiments` or `patterns`; null for anything else. */
export function exerciseKind(kind: unknown): ExerciseKindConfig | null {
  return typeof kind === "string" && kind in KINDS ? KINDS[kind] : null;
}

/** `rudiment_12` for prefix `rudiment` and number 12. */
export function exerciseId(idPrefix: string, number: number): string {
  return `${idPrefix}_${number}`;
}

/** A user's saved ids with every one of [oldIds] replaced by [newId], in
 * place and without leaving duplicates. */
export function replaceSavedIds(
  saved: unknown[],
  oldIds: string[],
  newId: string,
): string[] {
  const out: string[] = [];
  for (const raw of saved) {
    if (typeof raw !== "string") continue;
    const id = oldIds.includes(raw) ? newId : raw;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
