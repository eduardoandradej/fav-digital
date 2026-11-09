#!/usr/bin/env bash
# FAV Digital — ambiente LOCAL com Podman rootless (dados SINTÉTICOS, provedor de identidade simulado).
# Uso:  ./deploy/podman/local.sh up | down | logs | reset
# Requer: podman >= 4.4. Não requer root.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=fav-net
DB=fav-db
APP=fav-app
IMG=localhost/fav-digital:local
PG_IMG=docker.io/library/postgres:18
PORT=${FAV_PORT:-8080}
PG_PASS=${FAV_PG_ADMIN_PASSWORD:-devonly}   # apenas ambiente local descartável

up() {
  echo ">> construindo imagem $IMG"
  podman build -f Containerfile -t "$IMG" .
  podman network exists $NET || podman network create $NET
  podman volume exists fav-pgdata || podman volume create fav-pgdata
  if ! podman container exists $DB; then
    echo ">> iniciando PostgreSQL 18"
    podman run -d --name $DB --network $NET -e POSTGRES_PASSWORD="$PG_PASS" -e POSTGRES_DB=fav \
      -v fav-pgdata:/var/lib/postgresql "$PG_IMG"
  else
    podman start $DB >/dev/null
  fi
  echo ">> aguardando banco"
  for _ in $(seq 1 30); do podman exec $DB pg_isready -U postgres -d fav >/dev/null 2>&1 && break; sleep 1; done
  echo ">> papéis, migrações e massa sintética"
  podman run --rm --network $NET \
    -e FAV_PROFILE=development \
    -e ADMIN_DATABASE_URL="postgres://postgres:${PG_PASS}@${DB}:5432/fav" \
    -e DATABASE_URL="postgres://fav_app:devonly@${DB}:5432/fav" \
    "$IMG" node dist/db/cli.js setup
  podman rm -f $APP >/dev/null 2>&1 || true
  echo ">> iniciando aplicação em http://localhost:${PORT}"
  podman run -d --name $APP --network $NET -p "127.0.0.1:${PORT}:8080" \
    --read-only --tmpfs /tmp:rw,size=64m,mode=1777 --cap-drop=ALL --security-opt no-new-privileges \
    -e FAV_PROFILE=development \
    -e DATABASE_URL="postgres://fav_app:devonly@${DB}:5432/fav" \
    -e SYNC_INTERVAL_MINUTES=60 \
    "$IMG"
  for _ in $(seq 1 30); do curl -fsS "http://localhost:${PORT}/api/v1/saude/pronto" >/dev/null 2>&1 && break; sleep 1; done
  echo
  echo "Pronto: http://localhost:${PORT}  (ID funcional 1000001 … 1000012, senha Sintetica#2026)"
}

down() { podman rm -f $APP $DB 2>/dev/null || true; }
reset() { down; podman volume rm -f fav-pgdata; }
logs() { podman logs -f $APP; }

"${1:-up}"
