#!/usr/bin/env bash
# End-to-end demo: sync server + main app, token, device, host CRUD, sync merge.
# Usage: bash scripts/demo.sh [--full]   (--full also runs the test suite)
set -euo pipefail
cd "$(dirname "$0")/.."

APP_PORT="${APP_PORT:-3951}"
SYNC_PORT="${SYNC_PORT:-3952}"
DIR="$(mktemp -d)"
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$DIR"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
json_get() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const p='$1'.split('.');let v=j;for(const k of p){v=v?.[k]}process.stdout.write(String(v??''))})"; }

step "Starting sync server (:$SYNC_PORT) and app (:$APP_PORT) in $DIR"
SYNC_DB="$DIR/sync.db" PORT="$SYNC_PORT" HOST=127.0.0.1 node --import tsx server/sync/server.ts &
PIDS+=($!)
TERMUS_DB="$DIR/demo.db" TERMUS_CONFIG_DIR="$DIR/cfg" PORT="$APP_PORT" HOST=127.0.0.1 node --import tsx server/index.ts &
PIDS+=($!)

for _ in $(seq 1 75); do
  if curl -sf "http://127.0.0.1:$APP_PORT/health" >/dev/null && curl -sf "http://127.0.0.1:$SYNC_PORT/sync/health" >/dev/null; then
    break
  fi
  sleep 0.2
done
curl -sf "http://127.0.0.1:$APP_PORT/health" >/dev/null || { echo "app failed to start"; exit 1; }
curl -sf "http://127.0.0.1:$SYNC_PORT/sync/health" >/dev/null || { echo "sync server failed to start"; exit 1; }
echo "both services up"

step "Creating app password (scope: sync)"
TOK=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/api/tokens" -H 'content-type: application/json' -d '{"name":"demo","scope":"sync"}' | json_get token)
[ -n "$TOK" ] || { echo "token creation failed"; exit 1; }
echo "token: ${TOK:0:12}..."

step "Registering this device on the sync server"
curl -s -X POST "http://127.0.0.1:$SYNC_PORT/sync/register" -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"deviceId":"demo-device","name":"demo box"}'
echo

step "Creating a host via the API"
HOST_ID=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/api/hosts" -H 'content-type: application/json' -d '{"name":"demo","host":"127.0.0.1","port":22,"username":"demo","auth_method":"password","password":"secret"}' | json_get id)
echo "host id: $HOST_ID"
curl -s "http://127.0.0.1:$APP_PORT/api/hosts" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,1)))"

step "Configuring sync in the app and merging"
curl -s -X PUT "http://127.0.0.1:$APP_PORT/api/sync/config" -H 'content-type: application/json' \
  -d "{\"enabled\":true,\"server_url\":\"http://127.0.0.1:$SYNC_PORT\",\"device_name\":\"demo box\",\"token\":\"$TOK\"}" >/dev/null
curl -s -X POST "http://127.0.0.1:$APP_PORT/api/sync/merge"
echo

step "Sync server state (devices + entities)"
curl -s "http://127.0.0.1:$SYNC_PORT/sync/devices" -H "authorization: Bearer $TOK"
echo
curl -s "http://127.0.0.1:$SYNC_PORT/sync/state" -H "authorization: Bearer $TOK"
echo

step "Audit trail (last 5 events)"
curl -s "http://127.0.0.1:$APP_PORT/api/audit?limit=5" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const e of JSON.parse(d))console.log(e.created_at,e.action,e.detail??'')})"

if [ "${1:-}" = "--full" ]; then
  step "Full test suite"
  npm test
fi

step "Demo complete"
