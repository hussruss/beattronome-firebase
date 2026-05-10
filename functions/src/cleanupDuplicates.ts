import "./admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp, QueryDocumentSnapshot } from "firebase-admin/firestore";

const COLLECTIONS_TO_DEDUPE = [
  { collection: "new_installations", dateField: "date" },
  { collection: "user_sessions", dateField: "date" },
] as const;

const FIRESTORE_BATCH_LIMIT = 500;

function dayKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getDate(doc: QueryDocumentSnapshot, field: string): Date | null {
  const raw = doc.get(field);
  if (raw instanceof Timestamp) return raw.toDate();
  if (raw instanceof Date) return raw;
  if (typeof raw === "number") return new Date(raw);
  return null;
}

async function dedupeCollection(
  collection: string,
  dateField: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<{ scanned: number; deleted: number }> {
  const db = getFirestore();
  const snap = await db
    .collection(collection)
    .where(dateField, ">=", Timestamp.fromDate(windowStart))
    .where(dateField, "<", Timestamp.fromDate(windowEnd))
    .orderBy(dateField, "asc")
    .get();

  const groups = new Map<string, QueryDocumentSnapshot[]>();
  for (const doc of snap.docs) {
    const userId = doc.get("user_id") as string | undefined;
    const date = getDate(doc, dateField);
    if (!userId || !date) continue;
    const key = `${userId}|${dayKey(date)}`;
    const list = groups.get(key) ?? [];
    list.push(doc);
    groups.set(key, list);
  }

  const toDelete: QueryDocumentSnapshot[] = [];
  for (const docs of groups.values()) {
    if (docs.length <= 1) continue;
    docs.sort((a, b) => {
      const da = getDate(a, dateField)?.getTime() ?? 0;
      const db_ = getDate(b, dateField)?.getTime() ?? 0;
      return da - db_;
    });
    toDelete.push(...docs.slice(1));
  }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += FIRESTORE_BATCH_LIMIT) {
    const slice = toDelete.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();
    for (const doc of slice) batch.delete(doc.ref);
    await batch.commit();
    deleted += slice.length;
  }

  logger.info(`Deduped ${collection}`, {
    scanned: snap.size,
    deleted,
    groups: groups.size,
  });
  return { scanned: snap.size, deleted };
}

export const cleanupDuplicates = onSchedule(
  {
    schedule: "0 3 * * *",
    timeZone: "UTC",
    region: "us-central1",
    retryCount: 1,
    memory: "256MiB",
    timeoutSeconds: 540,
  },
  async () => {
    const now = new Date();
    const windowEnd = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);

    logger.info("cleanupDuplicates started", {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    });

    for (const { collection, dateField } of COLLECTIONS_TO_DEDUPE) {
      try {
        await dedupeCollection(collection, dateField, windowStart, windowEnd);
      } catch (err) {
        logger.error(`Failed to dedupe ${collection}`, err);
      }
    }
  },
);
