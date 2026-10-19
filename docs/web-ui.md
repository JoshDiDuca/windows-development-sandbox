# Web UI

Status: **Beta, off by default** (`web.enabled`; `sandbox web start` works either way; with `web.enabled` on, every
sandbox start also starts it, and `web.openOnLaunch` opens it signed in). Every area of the menu is in it: agents,
sessions with live terminals, the sandbox, projects, apps, accounts, settings (with VPN and GitHub as categories) and
maintenance. It ends by itself after 20 minutes with no browser (5 when no sandbox runs). How every page looks and how
to check it: [design/web-ui-standard.md](design/web-ui-standard.md).

## What it is for

See and use your sandbox sessions from a browser: the list of sessions, a live terminal for each (type into it as with
`sandbox attach`), and new sessions. First in a browser on this PC (including another Windows user of it, when you
share your sandbox), later from a phone on your own network.

## Shape

```
browser (React app, xterm.js)  ──HTTP + WebSocket──>  sandbox web (Node, on the PC, as you)
                                                          │ reads run\ (sessions), checks the sharing rules
                                                          └──TCP, ptyhost protocol──>  session terminal in the sandbox
```

- **One repo, one package.** The server reuses `shared/pty` (protocol, client), `host/channel` (`SandboxChannel`,
  session requests) and `host/sharing` (who may do what). Every page besides the terminal is a view of the shared core
  ([design/shared-core.md](design/shared-core.md)): the browser runs its operations and queries over an RPC socket, and
  draws its pages with the same pure definitions the CLI and the menu use. The app lives in `web/` (React + TypeScript,
  Mantine 7, TanStack Query, `@xterm/xterm`), is bundled by esbuild (already a dependency; no Vite) into `dist/web/` and
  ships in the package. Its dependencies are dev dependencies: only the built files ship.
- **Server:** `src/host/web/` (the HTTP server, the WebSocket bridge, auth) with `node:http` and the `ws` package (small,
  no dependencies of its own, bundled). Started by `sandbox web` (start / stop / status / open), runs in the background
  like the sync watcher, and keeps running when no sandbox does (the page says so). The same four actions are in the
  menu: Maintenance > Web UI (start, open, stop; its keys are s, o and x). They are CLI and menu only: the web page is
  the web UI itself, so it does not offer to start or stop its own server.
- **The browser never gets a session's attach token.** The server holds it, connects to the session's ptyhost (only to
  sandbox addresses, `isSandboxAddress`, as `attach` does) and passes frames both ways: OUTPUT to the browser; INPUT,
  RESIZE and PING from it. Several browsers may watch one session, as several `attach` terminals can.

## Security

The server is a way into every agent you run, so it is treated like a login:

- **Off by default**, switched on in Settings or with `sandbox web start`. It is not settable from a repo's
  `.sandbox-config.json`.
- **Loopback only** (`127.0.0.1`) until the LAN phase. Every Windows user of the PC can reach loopback, so nothing works
  without a token:
  - A 32-byte random token per server start, kept in a host-only file in your storage (private ACL), never in a
    sandbox's data folder. `sandbox web open` opens `http://127.0.0.1:<port>/#k=<token>`. The fragment never reaches the
    server's logs or the browser history.
  - The page trades the token once (`POST /api/login`, constant-time compare, rate-limited) for an `HttpOnly`,
    `SameSite=Strict` session cookie. Every API call and the WebSocket upgrade need that cookie.
- **No other site can drive it.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
  The WebSocket upgrade must come from the server's own `Origin`. State-changing calls need a CSRF header. There is no
  CORS. CSP is `default-src 'self'` with no inline scripts; frames are refused (`frame-ancestors 'none'`). Everything
  is served from the package: no CDN.
- **Same rules as the CLI.** Another user's sandbox is shown and used only as far as `ownerRule` allows (look; use when
  shared; never restart or launch). Data read from `run\` is validated as everywhere else; terminal text goes only to
  xterm.js (no HTML), links in it open only after a confirmation, and clipboard writes from the terminal (OSC 52) are
  ignored.
- **Remote access (beta, opt-in):** devices on your own network and other Windows users of this PC, each with a role;
  see [Remote access](#remote-access).

## Remote access

Off by default. The design and its security review: [design/remote-access.md](design/remote-access.md).

**Anyone you let in acts as you.** The web UI runs as you, so whatever a remote user does runs with your settings,
logins and projects. Give **control** only to people you would let use your keyboard: they can type into your agents'
terminals and read what the agents can read, logins included. **View** sees everything (terminal output, logs, the
audit log, settings with secrets as `***`) but cannot change anything or type.

**Your phone or tablet, on your own network:**

1. `sandbox web lan-on` (or Remote access > Turn on LAN mode). It checks the network is marked **Private** in Windows
   and adds one firewall rule (Windows asks once): inbound TCP to this PC's private address and port 47801, from your
   local subnet, on Private networks only. LAN mode then runs only on that network.
2. `sandbox web status` (and the Remote access page, and the menu's Web UI page) shows the address, e.g.
   `https://192.168.1.20:47801`, and the certificate's fingerprint. Type the address into the phone's browser. It warns
   once about the certificate (made on your PC, not by a public authority): compare the fingerprint if the browser
   shows it, then go on. **If it ever warns again later, stop**: someone may be in between.
3. On the PC choose **Allow a new device** (`sandbox web allow-device`), pick view or control, and type the code it
   shows (`ABCD-EFGH`, 5 minutes, one use) on the phone with a name for it.
4. The phone stays signed in for `web.remote.rememberDays` days (30), counted from when it was allowed, not renewed by
   use. Sign it out any time: Remote access page, `sandbox web revoke <id>` or `revoke-all`. `sandbox web lan-off`
   signs out every device and removes the rule.

**Local network only, never the internet.** The listener binds only to a private IPv4 address (10.x, 172.16-31.x,
192.168.x) of a real adapter (never `0.0.0.0`, a public address or the sandbox's Hyper-V adapter); every connection
whose peer is not a private address on that same network, is this PC itself, or comes from a sandbox, is dropped before
anything is read. There are no tunnels, relays, UPnP or port mapping. Do not forward the port on your router: it would
not work (public peers are dropped) and it is not meant to.

**Another Windows user of this PC:** add them to `web.remote.users` with a role and turn on `web.remote.windowsSignIn`.
They run, as themselves, `sandbox remote` (the menu over your program: every area, with their role) or `sandbox remote
--browser` (your web UI in their browser). Windows says who they are through a named pipe of your web UI (no password);
their sign-in only works from their own Windows account. Taking them off the list ends their access at once.

**What stays yours** whatever the role: remote access itself (devices, the list, LAN mode), logins and tokens
(accounts, GitHub, VPN), projects, roots and mappings, nearly every setting (control may change only `attach.*` and
`resume.*`), data cleaning, updates, the folder picker and stopping the web UI. Every remote action, refusal, sign-in
and new device is in the audit log (Activity, `sandbox audit --kind remote`).

**Needs a real PC to try fully:** the firewall rule and the network check (here they are checked by dry runs), trusting
the certificate on a phone, and a second Windows account for `sandbox remote`.

## Phases

1. **Foundation** (done, behind the setting): the server, auth, the bridge, the React app with the session list, a
   terminal page (resize, reconnect, detach) and "new session" (an agent in a project of the running sandbox).
2. **Redesign** (done): a design system, the sidebar with the sandbox's live state, Ctrl+K search, one renderer for
   every Page (cards, tiles, tables, inline settings, categories), a folder picker, a terminal page with find, text
   size, full screen and a phone key row, settings rows for the web UI itself.
3. **Every area in the web UI** (done): every area of the menu is a shared-core feature and shows up here. Still
   planned: a plain shell session kind (PowerShell through ptyhost) and closing a session.
4. **The sandbox's desktop in the browser** (idea): a view of the sandbox window with mouse and keyboard, so it can be
   used from another device. Options, in the order to try: capturing the sandbox window on the PC and streaming it
   over this server (no server in the guest); a VNC server in the sandbox that connects out to the PC, shown with
   noVNC (MPL-2.0). Either needs a security review first: the guest is hostile, and this is a new way in.
5. **LAN, phones and other Windows users** (beta, built): see [Remote access](#remote-access) below and
   [design/remote-access.md](design/remote-access.md).

## What Phase 1 is (as built)

- **Settings:** `web.enabled` (default off; on = every sandbox start also starts the server), `web.openOnLaunch` (default off; opens the
  browser already signed in) and `web.port` (default 47800, 1024-65535). Not in `LocalOverrides`.
- **Commands:** `sandbox web start | stop | status | open` (PC only). `start` spawns the hidden `_web` command detached,
  works with `web.enabled` off (it then runs for this run only), and prints no
  token. `open` starts it if needed and opens the default browser (through `cmd /c start`) on `/#k=<token>`. `stop`
  signs in with the token and asks the server to stop. The server needs the built app in `dist/web` (`npm run build`).
- **Server** (`src/host/web/`): `node:http` and `ws` (bundled, `bundleDependencies`), on `127.0.0.1` only. The token, pid
  and port are in `<storage>\web\server.json`, in a folder made private with `protectPrivateFolder`. Login is
  `POST /api/login` (constant-time compare; 8 wrong tries within a minute lock it for a minute), cookie `sbxweb`
  (`HttpOnly`, `SameSite=Strict`, 12 hours unused). Calls that change something need the `X-Sandbox-Web: 1` header and
  an `Origin` that is the page; the WebSocket needs the cookie and that `Origin`; every request needs a loopback
  `Host`. The CSP is `default-src 'self'` with scripts only from the server; styles may be inline because xterm.js
  sets them.
- **API:** `GET /api/info` (sandbox state, owner line, agents, projects), `GET /api/sessions` (no attach address or
  token), `POST /api/sessions` `{harness, project}` (an agent in a project the running sandbox has), `POST /api/stop`,
  `WS /api/sessions/:id/terminal?cols=&rows=`, and `WS /api/rpc` (below).
- **RPC socket** (`WS /api/rpc`, `host/web/rpc.ts`): the same Origin and cookie checks as a terminal, at most 8 per
  server and 32 open calls or subscriptions per socket. Every message is checked against the kernel's zod schemas
  (`src/app/kernel/rpc.ts`); anything else (binary, not JSON, unknown fields, a bad id) closes the socket with 1008. Only
  definitions registered in `src/app/registry.ts` whose `surfaces` include the web run (`createRpcHost`); their input
  and output are checked like on every surface. Questions an operation asks go to the browser and its answer is checked
  against the question's kind (anything else counts as no); a browser that leaves mid-question answers no. Errors reach
  the browser as message and fix; a bug says only "Something went wrong." Live queries are read again at their
  `live.everyMs` and sent only when the result changed. Outputs never carry an attach token, and secrets are `***`. Sharing rules: nothing of another user's sandbox unless it is shared
  (`ownerRule`, `use`); restarting and launching are not offered. The address check is the backend's
  (`hostEndpoint` in `host/channel/attach.ts`, `isSandboxAddress`); the bridge connects to what it is given.
- **Terminal socket:** browser to server, binary = keystrokes, text = `{t:'resize',cols,rows}` (anything else closes it
  with 1008); server to browser, binary = output (through the same `OutputFilter` as `attach`, so OSC 52 never
  arrives), text = `ready` / `restarting` / `exit` / `error`. The server sends HELLO with the session token and PING
  every 5 s, holds output back when the browser is slow and closes it after a minute.
- **App** (`web/`, React 18, Mantine 7 with its static stylesheets (no CSS-in-JS script, so the CSP holds), TanStack
  Query, `@mantine/spotlight`, xterm.js with its search, web-links and unicode11 addons; bundled by
  `scripts/bundle-web.mjs` into `dist/web` with hashed names; the build type-checks it): the theme and tokens
  (`theme.ts`, `app.css`), a sidebar with the sandbox's live state and the areas that are in the web UI (the others are
  named, never dead links), Ctrl+K search over pages, sessions and settings, every page a view of the shared core drawn
  from its Page by one renderer (`web/src/render`: header, tiles, rows, cards, tables, categories with controls in
  place, skeleton, error and empty states), operations with their questions as modals and their progress and result as
  notifications, a folder picker over `files.browse` for every path, the terminal page (fit, reconnect with backoff,
  find, text size, full screen, a key row on touch screens, back / detach), the new-session dialog, dark or light (the
  OS, or the toggle). Links in the terminal ask before opening.
- **Working on it:** `npm run web:preview` serves the real app with sample data (and the real settings code against a
  temp file); `npm run web:shots -- <folder> [paths] [--dark] [--mobile]` takes screenshots with Edge through
  playwright-core.
- **Tests:** `npm test web` (`src/selftest/web.test.ts`): login, Host / Origin / CSRF, path traversal, sessions without
  tokens, the bridge against a fake ptyhost, and the RPC socket against a fake host (checks, questions, errors, live
  queries, refusals). `npm test app` covers the shared core it serves.
