const fs = require('fs');
const path = require('path');

const SERVICE_ACCOUNT_KEY_PATH = path.join(__dirname, 'service-account-key.json');

/**
 * Shared Firebase Admin bootstrap for the scripts in this folder — same
 * service-account-key.json / Application Default Credentials fallback as
 * upload.js / upload_patterns.js. Lazily requires 'firebase-admin' so
 * `renumber()` below stays unit-testable (with a fake `db`) without that
 * dependency installed.
 */
function initAdmin(projectId) {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    if (fs.existsSync(SERVICE_ACCOUNT_KEY_PATH)) {
      const serviceAccount = require(SERVICE_ACCOUNT_KEY_PATH);
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log('Using Service Account Key.');
    } else if (projectId) {
      console.log(`Service account key not found. Using Application Default Credentials for project: ${projectId}...`);
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
      });
    } else {
      console.error('Error: no service-account-key.json found and no project ID given.');
      process.exit(1);
    }
  }
  return admin.firestore();
}

// Firestore caps a batch at 500 writes. Each move contributes 2 (set +
// delete on the catalog doc) plus 1 per affected user doc, so this is the
// number of *moves* (not writes) bundled per commit — comfortably under the
// cap even for a move whose id a few dozen users saved.
const MOVES_PER_BATCH = 50;

/**
 * Renames documents in `collectionName` per `moves` ({oldIdNumber:
 * newIdNumber}), where the document id is `${idPrefix}_${number}` (e.g.
 * "rudiment_1"). Firestore has no rename primitive, so a "move" is: read
 * `${idPrefix}_${oldNumber}`, write its data to a new doc
 * `${idPrefix}_${newNumber}`, delete the old doc, AND fix every per-user
 * reference to the old id — see below.
 *
 * Every uploaded doc also carries its own id as a plain data field (see
 * upload.js/upload_patterns.js: `rudiment.id = id`), and that field —
 * not the Firestore document key — is what the app actually reads:
 * `BeattRudiment.fromJson`/`.withConverter(fromFirestore: ...)` build the
 * model from `snapshot.data()` alone and never consult `snapshot.id`. So
 * renaming only the document key (leaving `data.id` as the old value)
 * moves the doc but leaves the app treating it as the old id — this
 * write always sets `id: newId` in the new doc's data for that reason.
 * `number` is left exactly as it was on the old doc — untouched, not
 * synced to the new id.
 *
 * `userCollectionName`/`userArrayField` name the per-user side of this:
 * one doc per user (`my_rudiments`/`my_patterns`, doc id = uid) holding a
 * flat array of catalog ids the user saved (confirmed against
 * beattronome_repository.dart / patterns_repository.dart). Renaming a
 * catalog id without also rewriting it inside every user's array would
 * orphan that reference the moment the old catalog doc is deleted — so
 * for every move, this queries `userCollectionName` with
 * `array-contains: oldId` and rewrites the matching array entry to
 * `newId` in the same commit as the catalog rename. That's the actual
 * point of doing this server-side instead of just editing the catalog by
 * hand: the catalog rename and every user-list fixup land atomically
 * together, so there's no window where a saved id points at nothing.
 *
 * Safety model: dry-run unless `apply` is true. A move is only planned if
 * (a) `${idPrefix}_${oldNumber}` exists, and (b) `${idPrefix}_${newNumber}`
 * does not already exist — including ids freed by *other* entries in the
 * same moves file, which this deliberately does NOT chain together. Do
 * multi-step reshuffles as separate runs, one freed slot at a time —
 * matches doing this "uno por uno, con calma." The dry-run preview always
 * runs the `array-contains` lookups too, so affected-user counts are known
 * *before* `--apply`, not discovered after.
 */
async function renumber(
  db,
  { collectionName, idPrefix, userCollectionName, userArrayField },
  moves,
  { apply },
) {
  const entries = Object.entries(moves || {}).map(([oldNumber, newNumber]) => ({
    oldNumber: Number(oldNumber),
    newNumber: Number(newNumber),
  }));

  if (entries.length === 0) {
    console.log('Nothing to do — the moves file is empty.');
    return;
  }

  let hasErrors = false;
  const plannedMoves = [];
  const claimedTargets = new Set();
  const claimedSources = new Set();

  for (const { oldNumber, newNumber } of entries) {
    if (Number.isNaN(oldNumber) || Number.isNaN(newNumber)) {
      console.error(`Entrada inválida: "${oldNumber}" -> "${newNumber}" (no son números).`);
      hasErrors = true;
      continue;
    }

    const oldId = `${idPrefix}_${oldNumber}`;
    const newId = `${idPrefix}_${newNumber}`;

    const oldSnap = await db.collection(collectionName).doc(oldId).get();
    if (!oldSnap.exists) {
      console.error(`No existe "${oldId}" en "${collectionName}" — no hay nada que mover.`);
      hasErrors = true;
      continue;
    }

    const newSnap = await db.collection(collectionName).doc(newId).get();
    if (newSnap.exists) {
      const existingName = newSnap.data().name ?? '(sin nombre)';
      console.error(
        `El id destino "${newId}" ya existe — lo usa "${existingName}". Mueve ese primero a otro lado.`,
      );
      hasErrors = true;
      continue;
    }
    if (claimedTargets.has(newId)) {
      console.error(`El id destino "${newId}" aparece más de una vez en este archivo de moves.`);
      hasErrors = true;
      continue;
    }
    if (claimedSources.has(oldId)) {
      console.error(`El id origen "${oldId}" aparece más de una vez en este archivo de moves.`);
      hasErrors = true;
      continue;
    }

    claimedTargets.add(newId);
    claimedSources.add(oldId);
    plannedMoves.push({
      oldId,
      newId,
      name: oldSnap.data().name ?? '(sin nombre)',
      data: oldSnap.data(),
    });
  }

  if (hasErrors) {
    console.error('\nCorrige los errores de arriba antes de volver a correr esto. No se escribió nada.');
    process.exitCode = 1;
    return;
  }

  // Find every per-user doc that has the old id saved, for every planned
  // move — done up front so the dry-run preview shows the full blast
  // radius before anything is written.
  for (const move of plannedMoves) {
    const usersSnap = await db
      .collection(userCollectionName)
      .where(userArrayField, 'array-contains', move.oldId)
      .get();
    move.affectedUsers = usersSnap.docs.map((doc) => ({
      id: doc.id,
      array: doc.data()[userArrayField] || [],
    }));
  }

  console.log(`\nMovimientos planeados en "${collectionName}" (${plannedMoves.length}):`);
  for (const move of plannedMoves) {
    console.log(`  ${move.oldId} -> ${move.newId}   "${move.name}"`);
    if (move.affectedUsers.length > 0) {
      console.log(
        `    + ${move.affectedUsers.length} usuario(s) en "${userCollectionName}" con este id guardado — se actualizarán.`,
      );
    }
  }

  if (!apply) {
    console.log('\nSolo dry-run — no se escribió nada. Vuelve a correr con --apply para aplicar estos cambios.');
    return;
  }

  const admin = require('firebase-admin');
  const totalAffectedUsers = plannedMoves.reduce((n, m) => n + m.affectedUsers.length, 0);

  for (let i = 0; i < plannedMoves.length; i += MOVES_PER_BATCH) {
    const chunk = plannedMoves.slice(i, i + MOVES_PER_BATCH);
    const batch = db.batch();
    for (const move of chunk) {
      batch.set(db.collection(collectionName).doc(move.newId), { ...move.data, id: move.newId });
      batch.delete(db.collection(collectionName).doc(move.oldId));
      for (const user of move.affectedUsers) {
        const updatedArray = user.array.map((id) => (id === move.oldId ? move.newId : id));
        batch.update(db.collection(userCollectionName).doc(user.id), {
          [userArrayField]: updatedArray,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
    await batch.commit();
  }

  console.log(
    `\nListo — ${plannedMoves.length} documento(s) renombrados en "${collectionName}", ` +
      `${totalAffectedUsers} referencia(s) de usuario actualizadas en "${userCollectionName}".`,
  );
}

module.exports = { initAdmin, renumber };
