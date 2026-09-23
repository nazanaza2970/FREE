# FREE

### FREE's Remote Everything Environment

Everything remote. Freely yours.

SSH · SFTP · Port Forwarding · Remote Sync

All your servers. All your tools. No paywalls.

FREE is a free, all-in-one remote connectivity workspace — SSH, SFTP, port
forwarding, and remote synchronization in a single application. Pure
JavaScript/TypeScript: Fastify + `ssh2` backend, React + xterm.js frontend,
SQLite for state, and an optional standalone sync server.

Runs entirely on your own machine(s). No cloud account, no vendor lock-in.

## Quick start

```bash
npm install
npm run dev            # backend on :3001 + Vite UI on :5173
```

Open http://localhost:5173, add a host (Terminal panel), and connect.

Production:

```bash
npm run build
npm start              # serves API + built UI from server/index.ts (:3001)
```

## Features

| Feature | Where |
|---|---|
| Multi-session (N concurrent tabs) | Terminal panel, `/ws/terminal` |
| SSH (password / private-key / in-app generated keys) | Terminal panel, `/api/hosts`, `/api/keys` |
| Host-key TOFU + fingerprint + trust-on-mismatch | `hostkey` WS events, `/api/known-hosts` |
| SFTP dual-pane file manager | Files panel, `/api/sftp` ops |
| Port forwarding: local, remote, SOCKS5 | Forwards panel, `/api/forwards` |
| SSH agent forwarding (in-app agent) | host option `agent_forward` |
| Telnet + Mosh (graceful fallback) | host `connection_type: telnet|mosh` |
| Snippets + protected (AES-GCM) snippets | Snippets panel, `/api/snippets` |
| Custom themes + import/export | Themes panel, `/api/themes` |
| Audit log (stream + JSONL export) | Audit panel, `/api/audit` |
| Groups / nested folders | sidebar tree, `/api/groups` |
| App passwords (scoped tokens) | Settings panel, `/api/tokens` |
| `term` CLI | `bin/term.mjs` (`npm run term -- <host>`) |
| Cross-device sync (self-hosted) | Sync panel, `/api/sync` + sync server |

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | API/UI port |
| `HOST` | `0.0.0.0` | bind address |
| `TERMUS_DB` | `data/termius.db` | main SQLite path |
| `TERMUS_CONFIG_DIR` | `~/.termius-free` | device keystore (protected snippets master key) |
| `MAX_SESSIONS` | `32` | hard cap on concurrent terminal sessions |
| `RECONNECT_COOLDOWN_MS` | `2000` | per-host delay after a session close before a new one is accepted (reconnect-storm guard) |
| `TERMUS_SERVER` | `http://127.0.0.1:3001` | server URL for the `term` CLI |
| `SYNC_DB` | `data/sync.db` | sync-server SQLite path |
| `NODE_ENV=production` | — | serve the built UI from `dist/` |

## The `term` CLI

```bash
term <host-name|id> [--server URL] [--trust] [-v]
```

Looks the host up over HTTP and drives the same WebSocket protocol as the
browser client — a full PTY in your shell.

## Self-hosted sync (M9)

Standalone sync server:

```bash
npm run sync:server          # or: node bin/sync-server.mjs --port 3901
```

Endpoints (Bearer app-password with `sync` scope):

- `POST /sync/register` — register a device
- `POST /sync/push` — push entity deltas `{type,id,payload,updated_at_ms,deleted}`
- `GET  /sync/state` — per-type revs to pull
- `GET  /sync/devices` — device registry
- `POST/GET/DELETE /sync/tokens` — scoped app passwords

On the client, open the **Sync** panel, enter the server URL + a token
(created in Settings → app passwords), save, and click **Merge now**.
Conflicts resolve last-write-wins by `updated_at_ms`; entities edited while
offline queue in `sync_queue` and push on the next successful merge.
`sync.*` settings are device-local and never synced.

## Security notes

- Local trust model: single user, bound to your host; the API is unauthenticated
  by default — keep it on a private interface/VPN.
- App passwords: salted SHA-256 at rest, `tt_` random tokens, per-token scopes
  (`read`, `write`, `verify`, `sync`); revocable from Settings.
- Host keys: TOFU with SHA256 fingerprints; mismatches block the connection
  until explicitly re-trusted (`trust: true`).
- Protected snippets: AES-256-GCM, master key in `TERMUS_CONFIG_DIR`
  (0600), never leaves the device.
- `data/termius.db` contains plaintext passwords/keys for saved hosts — protect
  the file (0600) like any credential store.
- Sync payloads are stored on the sync server in plaintext (E2E encryption is
  an Ultimate-tier stretch, not implemented).

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test suite (50 tests, in-process SSH/SFTP servers)
npm run build       # tsc + vite
npm run sync:server # standalone sync server
bash scripts/demo.sh # end-to-end demo
```

## Layout

```
server/        Fastify app: routes/, ssh/, sftp/, forward(s), sync/, crypto,
               db.ts (SQLite), terminal.ts (WS PTY), telnet, mosh
src/           React UI (xterm.js, panels, SFTP, forwards, sync)
shared/        types + WS protocol shared by UI and server
bin/           term.mjs (CLI), sync-server.mjs (sync server)
tests/         node:test suite incl. fake sshd/SFTP helpers
```
