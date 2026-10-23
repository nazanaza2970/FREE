# FREE Desktop — Tauri 2 + Rust Backend Plan

**Branch:** `tauri-desktop` (off `UI_revamp`)
**Date:** 2026-10-20

## Goal

Replace the "install npm, run two dev servers" workflow with a true desktop application:

- One native app window per OS (Windows, Linux; macOS later)
- No Node.js, no npm, no browser required for end users
- The "portable" esbuild bundle and the sql.js/WASM SQLite hack are removed entirely

## Decisions

| Decision | Choice |
|---|---|
| Framework | Tauri 2 |
| Backend | Full Rust rewrite (axum + russh + rusqlite) |
| Frontend | React kept; only `src/api.ts` / `src/ws.ts` change |
| Old npm workflow | Killed for end users; vite/npm remain as *developer* build tools for the frontend |
| Distribution | Windows: NSIS installer + portable zip. Linux: AppImage + .deb |

## Architecture

```
┌─────────────────────────────────────────────┐
│  FREE.exe / free (single process)           │
│                                             │
│  Tauri WebView (window)                     │
│    └── React UI (existing src/, bundled)    │
│           │ fetch + WebSocket               │
│  Rust core (tokio runtime)                  │
│    ├── axum HTTP+WS on 127.0.0.1:<ephemeral>│
│    ├── russh / russh-sftp  (SSH/SFTP)       │
│    ├── rusqlite (bundled SQLite)            │
│    ├── aes-gcm (keystore, protected data)   │
│    └── port forwards, VNC tunnel, telnet    │
└─────────────────────────────────────────────┘
```

**Protocol parity is the core constraint.** The Rust server keeps the exact REST
routes and WebSocket protocols of the old TypeScript server
(`shared/protocol.ts`, `server/routes/*`), so the React UI is ~95% untouched and
the existing node:test suite is the behavioral spec for the Rust port.

**Auth on desktop:** first run mints a random token (hash stored in DB); the
Rust side hands the plaintext to the webview once via a Tauri command; the
frontend stores it in `localStorage` like today. Lock screen keeps working.
`scripts/insert-token.ts` is replaced by a Rust `recover` subcommand.

**Data:** SQLite lives in Tauri's app-data dir. Same schema — an existing
`data/termius.db` is opened directly, no migration step. Keystore migrates
from `~/.termius-free/keystore.json`.

## Crate stack

| Need | Crate |
|---|---|
| HTTP + WebSocket | `axum` + `tokio` (in Tauri's runtime) |
| SSH + SFTP | `russh` + `russh-sftp` (pure Rust) |
| SQLite | `rusqlite` (`bundled`) |
| Crypto | `aes-gcm`, `sha2`, `rand`, `base64` |
| Logs | `tracing` + `tracing-subscriber` |

## Milestones

- **M0** ✅ Branch + Tauri scaffold + plan doc + CI skeleton
- **M1** ✅ Rust DB layer (rusqlite) + all REST routes + token auth + bootstrap command; frontend base-URL change
- **M2** ✅ SSH client (russh): password/key auth, keygen, host-key TOFU, keepalive, `/ws/terminal`, telnet, mosh (optional, system binary)
- **M3** ✅ SFTP (russh-sftp), `/ws/sftp`
- **M4** ✅ Port forwards (local/remote/SOCKS5) + agent forwarding + auto-start
- **M5** ✅ VNC session lifecycle + binary RFB tunnel over `/ws/vnc`
- **M6** ✅ Crypto parity (protected snippets, app passwords), data-dir migration, bundled fonts
- **M7** ✅ Packaging: NSIS + portable zip (Windows), AppImage + deb (Linux), release CI
- **M8** ✅ Delete old TS server / portable / bin; rewrite README

## Deferred / dropped

- **Sync server** — deferred (schema columns kept for future return)
- **`term` CLI** — deferred (can be a Rust subcommand later)
- **Browser/self-host mode** — dropped
- **macOS** — config stub only; CI job added later
- **Tray icon** — skipped for now (appindicator dev headers unavailable)
