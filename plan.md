# Termius Clone — Rebuild Plan

Goal: Recreate a Termius-like SSH client including all "Pro" tier features, as a
self-hosted, pure-JavaScript app. We build it in open-ended stages, each stage
leaves the app runnable and testable.

---

## 1. Assumptions & Decisions (recorded now, revisit in Milestone 0)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform | Web app (local single-user) that talks to hosts | Fastest to build & test on this Linux box; runs headless (remote VNC) |
| Desktop wrapper | Deferred (Electron/Tauri later, optional) | Core value is the SSH engine; wrapper is pure plumbing |
| SSH engine | `ssh2` (pure Node.js) | No native deps, supports real SSH + SFTP + port forwarding |
| Terminal UI | `xterm.js` + `@xterm/addon-*` | Industry standard, what Termius itself leans on |
| UI framework | React + Vite + TypeScript | Fast iteration, component reuse |
| Backend | Node.js (Fastify + `ssh2`), single process | One process hosts HTTP API + xterm websocket + SFTP + forwarders |
| State/persistence | SQLite via `better-sqlite3` | Hosts, groups, snippets, settings, audit log; single file, no server |
| "Cloud sync" | Self-hosted sync server (optional milestone) for Pro sync | Pro feature requires a server; we build one that mirrors termius.dev API shape |
| Build tool | Bun (already installed) for scripts/tests, npm for deps | Fast, already present |

---

## 2. Feature Matrix (Termius Free vs Pro)

### Free-tier features (must have)
- SSH sessions (RFC4253) with password + key auth
- Unlimited saved hosts (hostname, port, user, auth profile)
- Tabs + multi-session UI (1 concurrent connection to keep it "free-like"; we
  allow N but label it Pro)
- Terminal styling baseline (dark/light)
- Copy/paste between terminal and clipboard

### Pro features (the deliverable — all must be implemented)
1. **Multi-session** — many concurrent tabs, per-tab reconnection
2. **Cross-device Sync** — self-hosted sync server (`/sync` routes) that stores
   hosts/snippets/groups/settings and replays deltas to other devices
3. **SFTP** — drag & drop / dual-pane file manager (upload, download, mkdir,
   rename, delete, chmod, chown, symlink)
4. **Port forwarding** — Local, Remote, Dynamic (SOCKS5 proxy); UI to create/
   destroy/list tunnels per host
5. **SSH agent forwarding** — forward local agent to remote (`AgentForward`)
   with in-app agent implementation + optional ssh-agent socket bridging
6. **Telnet** — raw TCP terminal
7. **Mosh** — `mosh-client` bridge via mosh-server over UDP (best-effort; falls
   back to SSH when unavailable)
8. **Snippets** — reusable text snippets, insertion into active session, keyboard
   shortcut, per-group snippets, dynamic snippets with variables/%T prompts
9. **Protected snippets** — AES-GCM encrypted at rest per-device key
10. **Custom themes** — theme editor (bg/fg/palette/UI accent), import/export JSON
11. **Audit log** — session start/end, file transfer events, connection failures,
    reported via UI + JSONL export
12. **Groups / folder tree** — organize hosts into nested groups, group actions
13. **App passwords** — restrict sync-server access; server-side scoped tokens
14. **Termius CLI-like** — `term` binary to open a host or run a command from shell
15. **Terminal features** — clipboard history, quick commands, key-mappings
    (bash/zsh), fonts, cursor styles
16. **SSL/PKI options** — client certs for host auth, host key verification UI
    (known_hosts trust-on-first-use + fingerprint display)

### Ultimate-tier extras (stretch, note in README)
- AES key-wrapped end-to-end encryption of synced data
- Encrypted notes
- Refresh/teams & ACLs (out of scope unless requested)

---

## 3. Architecture

```
┌────────────────────────────── Browser ──────────────────────────────┐
│ React UI (Vite/TS)                                                   │
│  xterm.js  +  SFTP pane + Port-forward panel + Snippet picker        │
│         │ websocket (/term)                                    │     │
└─────────┼──────────────────────────────────────────────────────┘     │
          │HTTP  │WS        │SFTP (WS channel or multer stream)        │
┌─────────▼──────────────────────────────────────────────────────────┐ │
│ Node backend (Fastify)                                              │ │
│  REST: /api/hosts /groups /snippets /settings /themes /audit        │ │
│  /api/sync (...proxy-to sync server OR self if single-user)         │ │
│  /term  — multiplex ws: spawn ssh2 Client, pipe to xterm            │ │
│  SSH manager: sessions, tunnels, agent-forward, telnet, mosh        │ │
│  SFTP manager: ssh2-sftp-client backed ops                          │ │
│ SQLite (better-sqlite3) — hosts, groups, snippets, settings, audit  │ │
└─────────┬──────────────────────────────────────────────────────────┘ │
          │ SSH/SFTP/Telnet (outbound)            │ sync (optional)    │
   remote servers (real world)                    Sync server API      │
```

Key subsystems:
- `src/backend/ssh/` — session lifecycle, auth, PTY, key handling, reconnect
- `src/backend/forward/` — local/remote/SOCKS tunnels
- `src/backend/sftp/` — file ops
- `src/backend/sync/` — delta sync engine + optional standalone sync-server bin
- `src/backend/crypto/` — AES-GCM for protected snippets + app passwords
- `src/shared/` — types shared by UI and backend (host, snippet, theme, event)
- `src/ui/` — React app

---

## 4. Project Structure (target)

```
termius_free/
├─ plan.md
├─ README.md
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ server/                 # Node backend (Fastify)
│  ├─ index.ts             # boot: db, http, ws, ssh manager
│  ├─ db.ts                # sqlite schema + migrations
│  ├─ routes/              # hosts, groups, snippets, settings, themes, audit
│  ├─ ssh/                 # manager.ts, session.ts, keys.ts, known_hosts.ts
│  ├─ forward/             # local.ts, remote.ts, dynamic.ts
│  ├─ sftp/                # server + ops.ts
│  ├─ telnet/              # telnet.ts
│  ├─ mosh/                # moshBridge.ts
│  ├─ sync/                # engine.ts, server.ts (optional separate bin)
│  └─ crypto/              # aes.ts, passwords.ts
├─ src/                    # React UI
│  ├─ main.tsx
│  ├─ App.tsx              # layout: sidebar (hosts/groups), tabs, terminal
│  ├─ components/          # HostForm, GroupTree, TerminalTab, SftpPane,
│  │                       # ForwardPanel, SnippetPicker, ThemeEditor,
│  │                       # AuditView, SyncStatus
│  ├─ state/               # zustand stores (hosts, sessions, settings)
│  └─ hooks/               # useTerminalSession, useSftp, useTunnels
├─ shared/                 # TS types + protocol constants
├─ tests/                  # unit + integration (vitest / node:test)
└─ bin/                    # term CLI shim
```

---

## 5. Milestones (each ends runnable + tested)

### M0 — Skeleton (verify: app boots, empty UI, CI-style script passes)
- Scaffold Vite+React+TS, Fastify server, SQLite schema, shared types
- `npm run dev` starts server + UI; `npm test` green
- plan.md/README.md present

### M1 — SSH core (verify: real SSH to localhost + a remote box)
- `ssh2` session, PTY, xterm websocket pipe
- Password & private-key auth, known_hosts TOFU with fingerprint UI
- Multi-tab sessions, reconnect, session close events
- Unit tests: auth helper, event serialization

### M2 — Host management (verify: CRUD via UI + API)
- Hosts CRUD (grouped), groups nested tree, settings persistence
- Auth profiles (password/key), on-device key generation (`ssh-keygen`-free:
  use `ssh2`'s hostkey generation via `generateKeyPair`)

### M3 — SFTP (verify: transfer real files local↔remote, both directions)
- Dual-pane browser, upload/download/mkdir/rename/rm/chmod/chown/symlink
- Progress + cancel, audit events on transfer

### M4 — Port forwarding (verify: browser-service or mysql via tunnel on localhost)
- Local forward: `127.0.0.1:PORT -> remote:PORT`
- Remote forward: remote binds and forwards into local net
- Dynamic: SOCKS5 proxy, verify with `curl --socks5`

### M5 — Snippets + protected snippets (verify: insert into live session, encrypt)
- CRUD, group scoping, insert via picker + shortcut, variables
- AES-GCM protected snippets, master key stored in device keystore (config dir)

### M6 — Themes + terminal polish (verify: theme switch, import/export)
- Theme editor (colors → xterm theme), accent color, import/export JSON
- Fonts, cursor, clipboard history, quick launcher, key-mappings

### M7 — Agent forwarding + Telnet + Mosh (verify: agent on remote ssh, telnet telnetd, mosh)
- AgentForward with in-app agent (sign with local keys on behalf of remote)
- Telnet over raw TCP
- Mosh bridge: spawn real `mosh-client`/`mosh-server` when binaries exist, else graceful fallback

### M8 — Audit + app passwords + CLI (verify: log streams, token auth, `term host`)
- Audit event bus → SQLite + JSONL export + UI view
- App passwords: scoped tokens accepted by sync server
- `bin/term <host>` — launch/attach using the same API

### M9 — Self-hosted sync (verify: two "devices" converge)
- Sync engine: per-entity version vectors, delta push/pull, conflict=last-write-wins
- Standalone sync-server bin (Fastify) storing device registry + blobs
- UI SyncStatus + "merge now" button; offline queue

### M10 — Hardening & packaging (verify: full suite, README, single-bundle)
- Error paths, reconnect storms, locking, resource limits (max sessions)
- README: run, config, security notes; optional Electron wrapper stub
- Final full test pass + demo script

---

## 6. Testing strategy
- **Unit (vitest)**: auth, crypto, forward bookkeeping, sync vectors, parsers
- **Integration**: spawn app on random port; use fake SSH server
  (`ssh2`-based test host in-process) for PTY, SFTP, forward tests in CI-less flow
- **Live smoke**: `tests/smoke.md` — manual matrix of the verifications above
- Run: `npm test`, `npm run typecheck`, `npm run lint` (eslint+prettier)

## 7. Key risks & mitigations
- **Mosh** needs native binaries → degrade gracefully; document detection
- **Agent forwarding** across envs → implement in-app agent; test vs `ssh -A`
- **Sync correctness** → version vectors + LWW, deterministic ordering
- **Port ranges/privileged ports** → user-configurable, error surfaced in UI
- **Scope creep** → keep Ultimate notes in README, not in code, unless requested

## 8. Definition of done
- Every Pro-row in the matrix has a UI + API + test/smoke evidence
- App runs from a single `npm run dev`; `npm test` green; typecheck clean
- README documents config, security posture, and how each Pro feature maps
```