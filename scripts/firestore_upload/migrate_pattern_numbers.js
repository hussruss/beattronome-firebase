const fs = require('fs');
const path = require('path');
const { initAdmin, renumber } = require('./renumber_lib');

const COLLECTION_NAME = 'patterns';
const ID_PREFIX = 'pattern';
const USER_COLLECTION_NAME = 'my_patterns';
const USER_ARRAY_FIELD = 'patterns';
const DEFAULT_MOVES_FILE = path.join(__dirname, 'pattern_moves.json');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const projectId = positional[0];
  const movesFile = positional[1] ? path.resolve(positional[1]) : DEFAULT_MOVES_FILE;

  if (!fs.existsSync(movesFile)) {
    console.error(`No se encontró el archivo de moves: ${movesFile}`);
    console.error('');
    console.error('Uso: node migrate_pattern_numbers.js <project-id> [moves-file.json] [--apply]');
    console.error('Formato del JSON: {"1": 41, "3": 42}  (pattern_<actual> -> pattern_<nuevo>, sufijo del id, no el campo number)');
    console.error(`Copia pattern_moves.example.json a ${path.basename(DEFAULT_MOVES_FILE)} y edítalo, o pasa tu propia ruta.`);
    process.exit(1);
  }

  const moves = JSON.parse(fs.readFileSync(movesFile, 'utf8'));
  const db = initAdmin(projectId);

  try {
    await renumber(
      db,
      {
        collectionName: COLLECTION_NAME,
        idPrefix: ID_PREFIX,
        userCollectionName: USER_COLLECTION_NAME,
        userArrayField: USER_ARRAY_FIELD,
      },
      moves,
      { apply },
    );
  } finally {
    process.exit(0);
  }
}

main();
