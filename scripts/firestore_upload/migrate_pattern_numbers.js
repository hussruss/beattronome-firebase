const fs = require('fs');
const path = require('path');
const { initAdmin, renumber } = require('./renumber_lib');

const COLLECTION_NAME = 'patterns';
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
    console.error('Formato del JSON: {"1": 41, "3": 42}  (número actual -> número nuevo)');
    console.error(`Copia pattern_moves.example.json a ${path.basename(DEFAULT_MOVES_FILE)} y edítalo, o pasa tu propia ruta.`);
    process.exit(1);
  }

  const moves = JSON.parse(fs.readFileSync(movesFile, 'utf8'));
  const db = initAdmin(projectId);

  try {
    await renumber(db, COLLECTION_NAME, moves, { apply });
  } finally {
    process.exit(0);
  }
}

main();
