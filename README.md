# beattronome-firebase

Todo lo que se despliega a Firebase para Beattronome, en un solo lugar:

| Ruta | Qué es | Antes vivía en |
|---|---|---|
| `firestore.rules`, `firestore.indexes.json`, `storage.rules` | Reglas e índices | `beattronome` |
| `rules-tests/` | Tests de reglas con el emulador | `beattronome` |
| `functions/` | Cloud Functions (sincronizaciones, notificaciones, `mergeGuestData`, `renumberExerciseNow`…) | `beattronome-backoffice` |
| `remoteconfig.dev.json`, `remoteconfig.prod.json`, `scripts/rc.sh` | Remote Config | `beattronome` |
| `scripts/firestore_upload/`, `scripts/seed_firestore.js`, `scripts/seed_feed_firestore.sh`, `scripts/seed-data/` | Scripts de datos | `beattronome` |

El historial de git de cada archivo se conservó.

## Proyectos

`.firebaserc`: `dev` = `beattronome-dev`, `prod` = `beattronome-ea8b2`.

## Antes del primer deploy en una máquina nueva

- `functions/.env` (no está en git) con `PLAY_CONSOLE_BUCKET=pubsite_prod_…`.
  Los demás secretos (AdMob, App Store Connect) viven en Secret Manager.
- `cd functions && npm ci`

## Deploy

```bash
# Reglas e índices
firebase deploy --only firestore:rules,firestore:indexes,storage --project prod

# Functions (si pregunta por borrar ext-firestore-revenuecat-purchases-handler: NO)
firebase deploy --only functions --project prod

# Remote Config: siempre pull → editar → deploy
./scripts/rc.sh pull prod
./scripts/rc.sh deploy prod
```

Un deploy de reglas reemplaza las reglas completas; uno de Remote Config
reemplaza la plantilla completa.

## Tests

```bash
# Reglas (Firestore + Storage), desde la raíz
npx firebase-tools emulators:exec --only firestore,storage --project demo-beattronome "npm --prefix rules-tests test"

# Functions
cd functions && npm ci && npm run lint && npm test
```

## Scripts de datos

`scripts/firestore_upload/upload.js` y `upload_patterns.js` leen el catálogo
de `../beattronome/assets/data/` (el repo de la app junto a este);
`DATA_FILE=/ruta/al.json` lo cambia. Necesitan
`scripts/firestore_upload/service-account-key.json` (no está en git).
