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

/**
 * Renumbers documents in `collectionName` per `moves` ({oldNumber: newNumber}).
 *
 * Per-user "my_rudiments"/"my_patterns" docs only ever store the catalog
 * document's Firestore `id` (never `number`) — confirmed by reading
 * beattronome_repository.dart / patterns_repository.dart before writing this
 * script. Renumbering a catalog doc's `number` field is therefore safe on
 * its own; no per-user document needs touching.
 *
 * The one side effect this script can't fix: a device that already
 * downloaded an item caches its `number` locally (SQLite) and won't see the
 * new number until that item is deleted+redownloaded, or local storage is
 * cleared. That's cosmetic (sort order in "My Rudiments"/"My Patterns" on
 * that one device) and self-heals on redownload — not a reason to touch
 * per-user data, and not something a Firestore-side script can reach.
 *
 * Safety model: dry-run unless `apply` is true. A move is only planned if
 * (a) exactly one document currently holds `oldNumber`, and (b) no document
 * currently holds `newNumber` — including numbers freed by *other* entries
 * in the same moves file, which this deliberately does NOT chain together.
 * Do multi-step reshuffles as separate runs, one freed slot at a time —
 * matches doing this "uno por uno, con calma."
 */
async function renumber(db, collectionName, moves, { apply }) {
  const entries = Object.entries(moves || {}).map(([oldNumber, newNumber]) => ({
    oldNumber: Number(oldNumber),
    newNumber: Number(newNumber),
  }));

  if (entries.length === 0) {
    console.log('Nothing to do — the moves file is empty.');
    return;
  }

  // Load the full current state once, so validation sees every document —
  // not just the ones named in the moves file.
  const snapshot = await db.collection(collectionName).get();
  const byNumber = new Map();
  snapshot.forEach((doc) => {
    const data = doc.data();
    const number = data.number;
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push({ id: doc.id, name: data.name ?? '(sin nombre)' });
  });

  let hasErrors = false;
  const plannedMoves = [];
  const claimedTargets = new Set();

  for (const { oldNumber, newNumber } of entries) {
    if (Number.isNaN(oldNumber) || Number.isNaN(newNumber)) {
      console.error(`Entrada inválida: "${oldNumber}" -> "${newNumber}" (no son números).`);
      hasErrors = true;
      continue;
    }

    const atOld = byNumber.get(oldNumber) || [];
    if (atOld.length === 0) {
      console.error(`Nadie tiene el número ${oldNumber} en "${collectionName}" — no hay nada que mover.`);
      hasErrors = true;
      continue;
    }
    if (atOld.length > 1) {
      console.error(
        `Hay ${atOld.length} documentos compartiendo el número ${oldNumber} en "${collectionName}" ` +
          `(${atOld.map((d) => d.id).join(', ')}) — resuelve ese duplicado antes de renumerarlo.`,
      );
      hasErrors = true;
      continue;
    }

    const atNew = byNumber.get(newNumber) || [];
    if (atNew.length > 0) {
      console.error(
        `El número destino ${newNumber} no está vacío — ya lo usa "${atNew[0].name}" (${atNew[0].id}). ` +
          `Mueve ese primero a otro lado.`,
      );
      hasErrors = true;
      continue;
    }
    if (claimedTargets.has(newNumber)) {
      console.error(`El número destino ${newNumber} aparece más de una vez en este archivo de moves.`);
      hasErrors = true;
      continue;
    }

    claimedTargets.add(newNumber);
    plannedMoves.push({ id: atOld[0].id, name: atOld[0].name, oldNumber, newNumber });
  }

  if (hasErrors) {
    console.error('\nCorrige los errores de arriba antes de volver a correr esto. No se escribió nada.');
    process.exitCode = 1;
    return;
  }

  console.log(`\nMovimientos planeados en "${collectionName}" (${plannedMoves.length}):`);
  for (const move of plannedMoves) {
    console.log(`  #${move.oldNumber} -> #${move.newNumber}   "${move.name}" (${move.id})`);
  }

  if (!apply) {
    console.log('\nSolo dry-run — no se escribió nada. Vuelve a correr con --apply para aplicar estos cambios.');
    return;
  }

  const batch = db.batch();
  for (const move of plannedMoves) {
    batch.update(db.collection(collectionName).doc(move.id), { number: move.newNumber });
  }
  await batch.commit();
  console.log(`\nListo — ${plannedMoves.length} documento(s) actualizados en "${collectionName}".`);
}

module.exports = { initAdmin, renumber };
