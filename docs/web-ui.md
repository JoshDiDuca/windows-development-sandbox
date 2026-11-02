# Web UI

**Beta, off by default.** See and use your sandbox in a browser: agents, sessions with live terminals, the sandbox,
projects, apps, accounts, settings (VPN and GitHub included) and maintenance. Every area of the menu is in it.

## Start it

| Command or setting   | What it does                                                                           |
| -------------------- | -------------------------------------------------------------------------------------- |
| `sandbox web open`   | start the server if needed and open your browser, already signed in                    |
| `sandbox web start`  | start the server in the background (works even with `web.enabled` off, for this run)   |
| `sandbox web status` | whether it runs, and its address (also the network address when LAN mode is on)        |
| `sandbox web stop`   | stop it                                                                                |
| `web.enabled`        | every sandbox start also starts the server (it keeps running until `sandbox web stop`) |
| `web.openOnLaunch`   | also open your browser, signed in, with every sandbox start                            |
| `web.port`           | the port on `127.0.0.1` (default `47800`)                                              |

The menu has the same under Maintenance > Web UI (keys `s`, `o`, `x`). The address alone does not sign you in: use
`sandbox web open`. The server stays while a page of it is open, also in a hidden tab, and stops by itself 20 minutes
after the last page closes (5 when no sandbox runs). None of these can be set by a project.

## Shells and closing sessions

**New shell** on the Sessions page opens PowerShell in a project of the running sandbox and shows its terminal. On the
command line: `sandbox shell [project] [--shell pwsh|powershell|cmd]`. A shell is a session like an agent's: listed as
`pwsh (shell)`, `powershell (shell)` or `cmd (shell)`, attachable from any terminal (`sandbox attach <id>`) and shown in
the menu.

- **Which shell:** PowerShell 7 when the sandbox has it (`toolchains.pwsh`), else Windows PowerShell 5.1; `cmd` on
  request.
- **Its environment:** the project's, as an agent gets it (toolchains, PATH, `AGENT_*` variables, memory limits), but
  without the agent's own `environment` (its API keys), hooks or add-ons.
- **Closing:** **Close** (on its row, `x` in the menu, on the terminal page, or `sandbox close <id>`) ends the session
  and everything it started, agents too. Typing `exit` does the same for a shell. Closing needs control. In a sandbox
  shared by another Windows user, they may close shells, but only the owner closes agent sessions.
- **Restart and resume leave shells alone:** `sandbox restart` restarts only agents, and shells are not reopened after
  the sandbox restarts.
- **Idle shutdown:** an open shell counts as activity. A headless sandbox shuts down only once no session (agent or
  shell) is open, so close shells you no longer need.
- **Who may open one:** only you (at the PC, or through the token link). Someone with control can type into a shell you
  opened, but cannot open one.

## Security

The server is a way into every agent you run, so it is treated like a login:

- **Off by default**, and not settable from a repo's `.sandbox-config.json`.
- **Loopback only** (`127.0.0.1`) unless you turn on LAN mode. Every Windows user of the PC can reach loopback, so
  nothing works without a token:
  - A 32-byte random token per server start, kept in a private file in your storage (never in a sandbox's data folder).
    `sandbox web open` opens `http://127.0.0.1:<port>/#k=<token>`. The part after `#` never reaches the server's logs
    or the browser history.
  - The page trades the token once for an `HttpOnly`, `SameSite=Strict` session cookie, which every API call and
    WebSocket needs. Wrong tries are limited.
- **No other site can drive it.** The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` (against DNS
  rebinding). The WebSocket must come from the server's own `Origin`. Calls that change something need a CSRF header.
  There is no CORS. The CSP is `default-src 'self'` with no inline scripts, frames are refused, and everything is served
  from the package (no CDN).
- **Same rules as the CLI.** Another user's sandbox is shown and used only as far as sharing allows (look; use when
  shared; never restart or launch). Data read from the sandbox is validated. Terminal text goes only to xterm.js (no
  HTML), links in it open only after a confirmation, and clipboard writes from the terminal (OSC 52) are ignored.
- **The browser never gets a session's attach token.** The server holds it and passes the terminal through.

## Remote access

**Beta, off by default.** Devices on your own network, and other Windows users of this PC, each with a role. Design and
security review: [design/remote-access.md](design/remote-access.md).

**Anyone you let in acts as you.** The web UI runs as you, so whatever a remote user does runs with your settings,
logins and projects. Give **control** only to people you would let use your keyboard: they can type into your agents'
terminals and read what the agents can read, logins included. **View** sees everything (terminal output, logs, the
audit log, settings with secrets as `***`) but cannot change anything or type.

**Your phone or tablet, on your own network:**

1. Run `sandbox web lan-on` (or Remote access > Turn on LAN mode). It checks the network is marked **Private** in
   Windows and adds one firewall rule (Windows asks once): inbound TCP to this PC's private address on port 47801, from
   your local subnet, on Private networks only.
2. `sandbox web status` (or the Remote access page) shows the address, e.g. `https://192.168.1.20:47801`, and the
   certificate's fingerprint. Type the address into the phone's browser. It warns once about the certificate (made on
   your PC): compare the fingerprint if the browser shows it, then go on. **If it ever warns again later, stop**:
   someone may be in between.
3. On the PC choose **Allow a new device** (`sandbox web allow-device`), pick view or control, and type the code it
   shows (`ABCD-EFGH`, 5 minutes, one use) on the phone, with a name for it.
4. The phone stays signed in for `web.remote.rememberDays` days (default 30, 1 to 90), counted from when it was allowed.
   Sign it out any time on the Remote access page, or with `sandbox web revoke <id>` or `revoke-all`.
   `sandbox web lan-off` signs out every device and removes the firewall rule.

**Local network only, never the internet.** The server listens only on a private IPv4 address (10.x, 172.16-31.x,
192.168.x) of a real adapter, never `0.0.0.0`, a public address or the sandbox's adapter. Connections from anything but
a private address on that network, from this PC itself or from a sandbox are dropped before anything is read. There are
no tunnels, relays, UPnP or port mapping. Do not forward the port on your router: public connections are dropped anyway.

**Another Windows user of this PC:** add them to `web.remote.users` with a role (`{ "name": "bob", "role": "view" }`)
and turn on `web.remote.windowsSignIn`. They then run, as themselves, `sandbox remote` (the menu over your program,
with their role) or `sandbox remote --browser` (your web UI in their browser). Windows tells your web UI who they are
through a named pipe, so no password is needed, and it only works from their own Windows account. Taking them off the
list ends their access at once.

**What stays yours**, whatever the role: remote access itself (devices, the list, LAN mode), logins and tokens
(accounts, GitHub, VPN), projects, roots and mappings, nearly every setting (control may change only `attach.*` and
`resume.*`), data cleaning, updates, the folder picker, stopping the web UI, and opening a new shell. Every remote
action, refusal, sign-in and new device is in the audit log (Activity, or `sandbox audit --kind remote`).

**Needs a real PC to try fully:** the firewall rule and the network check (tested here with dry runs), trusting the
certificate on a phone, and a second Windows account for `sandbox remote`.

## Phases

1. **Foundation** (done): the server, sign-in, the terminal bridge, the session list, a terminal page and "new
   session".
2. **Redesign** (done): a design system, a sidebar with the sandbox's live state, Ctrl+K search, one renderer for every
   page, a folder picker, a terminal page with find, text size, full screen and a phone key row.
3. **Every area in the web UI** (done): every area of the menu, plus plain shell sessions and closing sessions.
4. **The sandbox's desktop in the browser** (idea): the sandbox window with mouse and keyboard, from another device.
   Options, in the order to try: capturing the sandbox window on the PC and streaming it through this server (nothing
   in the guest), or a VNC server in the sandbox that connects out to the PC, shown with noVNC (MPL-2.0). Either needs a
   security review first: the guest is hostile, and this is a new way in.
5. **LAN, phones and other Windows users** (beta, built): see [remote access](#remote-access).

## How it is built

For contributors. How every page looks and how to check it: [design/web-ui-standard.md](design/web-ui-standard.md).

```
browser (React app, xterm.js)  ──HTTP + WebSocket──>  sandbox web (Node, on the PC, as you)
                                                          │ reads run\ (sessions), checks the sharing rules
                                                          └──TCP, ptyhost protocol──>  session terminal in the sandbox
```

- **One package.** The server reuses `shared/pty` (protocol, client), `host/channel` (`SandboxChannel`, session
  requests) and `host/sharing` (who may do what). Every page except the terminal is a view of the shared core
  ([design/shared-core.md](design/shared-core.md)): the browser runs its operations and queries over an RPC socket, and
  draws its pages from the same pure definitions the CLI and the menu use.
- **Server** (`src/host/web/`): `node:http` and the `ws` package (bundled, `bundleDependencies`), on `127.0.0.1` only
  unless LAN mode is on. `sandbox web start` spawns the hidden `_web` command, detached; it runs in the background like
  the sync watcher, also when no sandbox does. The token, pid and port are in `<storage>\web\server.json`, in a folder
  made private with `protectPrivateFolder`. The server needs the built app in `dist/web` (`npm run build`).
- **Sign-in:** `POST /api/login` (constant-time compare; 8 wrong tries within a minute lock it for a minute), cookie
  `sbxweb` (`HttpOnly`, `SameSite=Strict`, 12 hours unused). Calls that change something need the `X-Sandbox-Web: 1`
  header and an `Origin` that is the page; the WebSocket needs the cookie and that `Origin`; every request needs a
  loopback `Host`. Styles may be inline because xterm.js sets them.
- **API:** `GET /api/info` (sandbox state, owner line, agents, projects), `GET /api/sessions` (no attach address or
  token), `POST /api/sessions` `{harness, project}`, `POST /api/stop`, `WS /api/sessions/:id/terminal?cols=&rows=`, and
  `WS /api/rpc`.
- **RPC socket** (`WS /api/rpc`, `host/web/rpc.ts`): the same Origin and cookie checks as a terminal; at most 8 sockets
  per server and 32 open calls or subscriptions per socket. Every message is checked against the kernel's zod schemas
  (`src/app/kernel/rpc.ts`); anything else closes the socket with 1008. Only definitions in `src/app/registry.ts` whose
  `surfaces` include the web run (`createRpcHost`), with input and output checked as on every surface. Questions go to
  the browser and the answer is checked against the question's kind; a browser that leaves mid-question answers no.
  Errors reach the browser as message and fix; a bug says only "Something went wrong." Live queries are read again at
  their `live.everyMs` and sent only when the result changed. Outputs never carry an attach token, and secrets are
  `***`. The address check is the backend's (`hostEndpoint` in `host/channel/attach.ts`, `isSandboxAddress`).
- **Terminal socket:** from the browser, binary = keystrokes, text = `{t:'resize',cols,rows}` (anything else closes it
  with 1008). To the browser, binary = output (through the same `OutputFilter` as `attach`, so OSC 52 never arrives),
  text = `ready` / `restarting` / `exit` / `error`. The server connects to the session's ptyhost only at sandbox
  addresses, sends HELLO with the session token and PING every 5 s, holds output back when the browser is slow and
  closes it after a minute. Several browsers may watch one session.
- **Mouse:** xterm.js reports clicks, the wheel, drags and moves as the program asked (DECSET 1000, 1002, 1003 with SGR
  1006). When the program restarts or exits, the server first tells the browser to stop mouse tracking, so a drag in an
  ended terminal selects text again.
- **App** (`web/`): React 18, Mantine 7 with its static stylesheets (no CSS-in-JS, so the CSP holds), TanStack Query,
  `@mantine/spotlight`, xterm.js with its search, web-links and unicode11 addons. Bundled by `scripts/bundle-web.mjs`
  (esbuild, no Vite) into `dist/web` with hashed names; the build type-checks it. Its dependencies are dev dependencies:
  only the built files ship. Every page is drawn from its Page by one renderer (`web/src/render`).
- **Working on it:** `npm run web:preview` serves the real app with sample data (and the real settings code against a
  temp file). `npm run web:shots -- <folder> [paths] [--dark] [--mobile]` takes screenshots with Edge through
  playwright-core.
- **Tests:** `npm test web` (`src/selftest/web.test.ts`): sign-in, Host / Origin / CSRF, path traversal, sessions
  without tokens, the bridge against a fake ptyhost, and the RPC socket against a fake host. `npm test app` covers the
  shared core it serves.
