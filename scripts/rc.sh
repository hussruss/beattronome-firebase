#!/bin/bash
# Remote Config: pull/deploy seguro por proyecto.
#
#   ./scripts/rc.sh pull   <dev|prod>   baja lo vivo a remoteconfig.<env>.json
#   ./scripts/rc.sh diff   <dev|prod>   tus cambios vs lo que bajaste
#   ./scripts/rc.sh deploy <dev|prod>   sube, solo si lo vivo no cambio desde tu pull
#
# Un deploy reemplaza TODA la plantilla. Por eso deploy aborta si alguien
# cambio algo en la consola despues de tu ultimo pull: primero pull, luego
# editar, luego deploy.
set -euo pipefail

cd "$(dirname "$0")/.."

cmd="${1:-}"
env="${2:-}"
case "$env" in
  dev)  project="beattronome-dev" ;;
  prod) project="beattronome-ea8b2" ;;
  *) echo "Uso: $0 <pull|diff|deploy> <dev|prod>"; exit 1 ;;
esac

file="remoteconfig.$env.json"
base=".rc/$env.base.json"
mkdir -p .rc

# Solo lo que importa al comparar (version/etag cambian en cada deploy).
normalize() { jq -S '{conditions, parameters, parameterGroups}' "$1"; }

fetch_live() {
  firebase remoteconfig:get --project "$project" -o "$1" >/dev/null
}

case "$cmd" in
  pull)
    fetch_live "$file"
    cp "$file" "$base"
    echo "OK: $file = lo vivo en $project"
    ;;

  diff)
    [ -f "$base" ] || { echo "Primero: $0 pull $env"; exit 1; }
    diff <(normalize "$base") <(normalize "$file") && echo "Sin cambios."
    ;;

  deploy)
    [ -f "$base" ] || { echo "Primero: $0 pull $env"; exit 1; }
    live=".rc/$env.live.json"
    fetch_live "$live"
    if ! diff -q <(normalize "$base") <(normalize "$live") >/dev/null; then
      echo "ABORTADO: $project cambio desde tu ultimo pull (alguien edito la consola)."
      diff <(normalize "$base") <(normalize "$live") || true
      echo "Corre '$0 pull $env', vuelve a aplicar tus cambios y reintenta."
      exit 1
    fi
    if diff <(normalize "$live") <(normalize "$file"); then
      echo "Nada que subir."
      exit 0
    fi
    [ "$env" = "prod" ] && echo "*** PRODUCCION ***"
    read -r -p "Subir estos cambios a $project? (escribe si) " answer
    [ "$answer" = "si" ] || { echo "Cancelado."; exit 1; }
    # Config temporal en la raiz: las rutas de firebase.json son relativas a
    # el, y el firebase.json real ya no declara remoteconfig a proposito.
    config=".firebase.rc.json"
    echo "{\"remoteconfig\":{\"template\":\"$file\"}}" > "$config"
    trap 'rm -f "$config"' EXIT
    firebase deploy --only remoteconfig --project "$project" --config "$config"
    fetch_live "$base"
    echo "OK: subido y snapshot actualizado."
    ;;

  *) echo "Uso: $0 <pull|diff|deploy> <dev|prod>"; exit 1 ;;
esac
