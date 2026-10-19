# Remote access: other Windows users and phones

Status: design (this file), then built in phases (see the end). Everything here is **off by default**: with the
default settings the web UI is exactly what it was, loopback only behind the token link.

## The goal

"Log in on the web UI from my phone or as another user of this PC, and see, manage and control everything; the same for
the menu as another user; Windows authentication; all configurable; remember access for x days."

## The one fact that shapes everything

The web UI server runs **as the owner** (the Windows user who ran `sandbox web start`). Whatever a browser asks it to
do is done with the owner's rights, settings, logins and projects: starting agents that run code, stopping the
sandbox, reading the owner's folders through the folder picker. So **access is control**: a remote user with "full
control" can do nearly what the owner can at the keyboard. The design therefore:

1. never lets anyone in without an explicit grant by the owner (a named Windows user, or a device the owner paired on
   their own screen);
2. gives every grant a role, checked on the server for every call (the browser hides what it may not do, the server
   refuses it either way);
3. keeps a small set of things for the owner alone, whatever the role (who has access, logins and secrets, stopping the
   web server), so a stolen phone can never add another device or read a secret;
4. expires every grant and lets the owner revoke one or all at any time;
5. writes every remote action (and every refusal) to the audit log, with who did it;
6. stays on the local network: never reachable from the internet (section 3).

## Who is who

| Principal | How they get in | Where | Role |
| --- | --- | --- | --- |
| **Owner** | The token link (`sandbox web open`), as today | loopback | everything |
| **Windows user** | Runs `sandbox remote` (or `sandbox remote --browser`) as themselves: the owner's server asks Windows who is on the other end of a named pipe and hands out a one-time link | loopback only | from `web.remote.users` |
| **Device** (phone, tablet, another PC) | Opens the PC's address, types a one-time code the owner shows, then a remembered cookie | LAN only (HTTPS) | chosen when allowing it |

Roles:

- **view**: every page and every live query, terminals read-only (the server drops keystrokes at the bridge, not the
  page). View protects what happens, not what is seen: a viewer sees terminal output (which can show code and
  anything an agent prints), logs, the audit log, settings (secrets as `***`) and folder names of projects. Never
  secret values, session tokens or session addresses.
- **control**: an explicit list, everything else is the owner's: start an agent in a project the sandbox has, type
  into terminals, restart sessions, stop the sandbox, show or hide its window, start apps, run the health check, and
  change a short list of harmless settings (attach, resume, personalization, the menu). **Control can read whatever the
  owner's agents can read, including their logins** (typing `cat ~/.claude/.credentials.json` into an agent's
  terminal): give it only to people you would let use your keyboard.
- **owner** (never given to anyone else): everything not on the control list, including remote access and devices,
  logins and tokens (accounts, GitHub, VPN), projects, roots and mappings, every other setting (secrets stripping,
  network, storage, sharing, audit, agents' folders and environment), importing settings, data cleaning, updates, the
  folder picker (`files.browse`, it lists the owner's disk), and stopping the web server.

Each definition in the shared core says what it needs with `access: 'view' | 'control' | 'owner'` or a pure function
of its input. **The default fails closed**: a query needs view, an operation needs owner; a definition is open to
control only when it says so, and `settings.set` / `settings.reset` only for the harmless keys. `createRpcHost` checks
it before it runs anything; the web server's RPC socket checks it again for every call and every subscription, with
the caller's role as it is now (not as it was when the socket opened).

## 1. Another Windows user, in the browser and the menu

**Chosen: a named pipe of the owner's server, identified by Windows (the client's token, not its session).**

1. While `web.remote.windowsSignIn` is on, the owner's web server runs `HostTools.exe web-door`, which serves the pipe
   `\\.\pipe\agent-sandbox-web-<owner SID>` (ACL: the owner, SYSTEM and Authenticated Users may connect; one instance
   at a time, first-instance flag so it cannot be opened twice by us).
2. Bob runs `sandbox remote` (or `sandbox remote --browser`) as himself. It finds the pipe name and port in the owner's
   machine record (`machine\active\*.json`, written by the owner, readable by the Agent Sandbox Users group, not
   writable by it), connects, and before sending anything checks with its own HostTools (`pipe-server --name`) that the
   pipe's server process runs in the owner's session (`GetNamedPipeServerProcessId`), so another user cannot squat the
   name.
3. On the owner's side the helper calls `ImpersonateNamedPipeClient` (identification is enough, no privilege needed),
   reads the thread token: user SID, integrity level, whether it is an AppContainer, then reverts. Below Medium
   integrity, an AppContainer, a SYSTEM/service account or the owner's own SID: refused. It writes those facts as one
   JSON line to the server (Node), which looks the SID up in `web.remote.users` (names resolved to SIDs with
   `LookupAccountName` by the helper) and, when allowed, answers with a **one-time login token** (32 random bytes,
   valid 60 seconds, one use) that the helper writes back down the pipe.
4. `sandbox remote` signs in with it (`POST /api/login`, like the owner's link) and talks RPC; `--browser` opens
   `http://127.0.0.1:<port>/#k=<one-time token>` in Bob's browser, exactly like `sandbox web open` for the owner.

Why not the TCP connection's session (my first idea): the session is not an identity. Anything that relays loopback
connections into Bob's session (WSL's localhost relay, `ssh -L`, VS Code or dev tunnels, a dev server's proxy, Bob's
own sandbox port forwards) would let others in as Bob, and the PID in the TCP table can outlive its process. A named
pipe client's token is who actually connected.

Then, for the cookie Bob's browser gets:

- Its record holds Bob's SID and when it was issued; the role is read from the settings on every call, so taking a
  user off the list (or changing the role) works at once, and their open sockets are closed.
- **Bound to Bob's connections.** Cookies for `127.0.0.1` are sent to every port of `127.0.0.1` (cookies, and
  `SameSite`, ignore ports), so a page of another local server Bob visits could receive it. The server checks each new
  TCP connection that carries a Windows cookie (`HostTools tcp-peer`: the full 4-tuple in the TCP table, its process,
  that process's session and that session's user, refusing a process that started after the connection) and accepts
  it only when that user is Bob. This is a second layer: a stolen cookie is useless from another account.
- `web.remote.windowsSignIn` (default off) is the switch for the browser and the menu; `web.remote.users` (default
  empty) says who. There are no new passwords.

Rejected: a token file in the other user's profile (the owner cannot write there without administrator rights; one
more secret at rest), Windows passwords typed into the page (the server would hold passwords), Negotiate/NTLM over
HTTP (needs a native SSPI binding).

**The owner's own cookie has the same port problem today** (finding C1 below): it is outside this change, passed to
the security sweep, and the recommended fix is to stop sending the login as an ambient cookie on loopback.

## 2. The menu for another Windows user

What exists stays: with `sharing.otherUsers` on, another user's own `sandbox` (CLI and menu) uses the owner's running
sandbox through the shared `run\` folder (sessions, attach, exec, stop with a typed confirmation; `ownerRule`,
`ctx.borrowed`). It needs no web server and gives no access to the owner's settings or program.

New: **`sandbox remote`** is the menu drawn over the owner's program: every view of the shared core, drawn by the
menu's own renderer (`render-view.ts`), with every query and operation sent over the owner's RPC socket after the
pipe sign-in above. The server checks the role, writes the audit line and runs it as the owner, the same code path
as the browser. A role of control may then do what `ownerRule` refuses a borrower (restart, show the window), because
the owner chose that role for that person; view or an unlisted user gets nothing new.

## 3. Phones on the local network (LAN mode)

Opt-in (`web.remote.lan.enabled`, default off). When on, the server opens a **second, HTTPS-only listener** on one
private address of this PC; loopback stays as it is.

**Local network only, never the internet.** This is a hard rule, not a default:

- The listener binds only to one private IPv4 address of this PC (10/8, 172.16/12, 192.168/16). It never binds to
  `0.0.0.0`, `::` or a public address, and a configured public address is refused with the reason. IPv6 is not
  supported at all (no listener on it).
- Every connection is checked again in the server, whatever the socket received: its peer must be a private IPv4
  address (or loopback on the loopback listener); anything else is dropped before a byte of HTTP is read.
- The firewall rule is limited to the Private profile and `LocalSubnet`.
- No tunnels, relays, UPnP or NAT-PMP port mapping, public host names or "share a link" services: the program has
  none and never will add one. Reaching it from outside your home network would need you to set up your router to
  forward the port yourself, which the docs tell you not to do (and the peer check refuses a public peer even then).

- **Address**: `web.remote.lan.address` or, when empty, this PC's private IPv4 address on a real adapter (never
  `0.0.0.0`, a public address, link-local, or a Hyper-V `vEthernet` adapter, which is the sandbox's network). A
  configured address that is not one of this PC's private addresses is refused.
- **Who may connect** (checked when the connection opens, before any HTTP): the peer must be a private IPv4 address
  **in the chosen adapter's own subnet** (on-link), must not be one of this PC's own addresses (a local user uses
  loopback, so a local squatter cannot replay a device cookie through the LAN address), and must not be in the subnet
  of any `vEthernet` adapter, listed again at every check (the sandbox's Default Switch subnet changes every boot).
  The guest is hostile and can reach the host's adapters.
- **What each listener accepts** (fixed): the LAN listener serves the app's files, `POST /api/pair` and requests with
  a device credential, nothing else (no token login, no Windows sign-in, no `/api/stop`). The loopback listener never
  accepts a device credential.
- **Network profile**: when LAN mode starts, `native\scripts\get-network-profile.ps1` (run by path) gives the chosen
  adapter's network category and name. It starts only on a **Private** network, and only on the network it was turned
  on for (its name is kept when `sandbox web lan on` runs): a laptop on a café network that is wrongly marked Private
  does not open up.
- **Port**: `web.remote.lan.port` (default 47801).
- **Certificate**: made once, in TypeScript (`node:crypto` makes an EC P-256 key and signs; a small DER encoder writes
  the X.509 certificate, 397 days, SAN IP entries, serverAuth, tested against `crypto.X509Certificate`: Node 22 has no certificate builder, and this avoids a
  dependency and an elevated `New-SelfSignedCertificate`). Subject alternative names: the private address(es) and the
  PC's name; not a CA (a CA key on the PC that a phone trusts could vouch for any site). The private key is sealed with
  `SecretStore` (DPAPI) in `<storage>\web\tls.json`. It is never replaced quietly: a new one is made
  only by `sandbox web lan new-certificate`, which also signs out every device.
- **Trust on the phone**: the phone's browser warns about a self-signed certificate once. The PC shows the
  certificate's SHA-256 fingerprint next to the address and the code, to compare with what the phone's browser shows
  (where it shows one). An attacker who intercepts the connection also serves the page, so nothing in the page can
  check the certificate: comparing is for a person. **A certificate warning after the first time means stop**: the
  docs say so plainly.
- **Firewall**: `sandbox web lan on` runs `native\scripts\set-web-firewall.ps1` elevated (one UAC prompt) to add an
  inbound rule "Agent Sandbox web UI (LAN)": TCP, that one port, profile Private only, remote address LocalSubnet,
  program = this Node. The request is a JSON file in a private temp folder; the script checks everything again: the
  rule name is exactly ours, the action is add or remove, the port is 1024-65535 and not a well-known one, the profile
  is Private, the remote address is LocalSubnet, the program path is an existing `node.exe` and not under a temp
  folder; the rule also names the local address. `lan off` removes the rule (only a rule with exactly our name). Node binds its sockets exclusively on Windows
  (libuv uses `SO_EXCLUSIVEADDRUSE`), so another program cannot share the port while the server runs. On a network
  marked Public nothing gets through, by design.
- **The address** is shown plainly on the PC: `sandbox web status`, the menu's Web UI page and the web UI's Remote
  access page all say "On your network: https://192.168.1.20:47801". The phone types it into its browser. No QR code
  (the user's choice: one less thing to build and trust).
- **Allowing a new device** (chosen over "a device asks, the owner approves": with approval alone, whoever asks first
  while the owner is looking gets in, and two phones look the same; a code typed on the phone proves the person holding
  it can see the PC's screen). The owner (token login, CLI or menu; never a device or a Windows user: the operation
  needs owner) chooses "Allow a new device", picks a role (**default view**; control is one choice away), and gets:
  - a one-time code, 8 characters of Crockford base32 shown as `ABCD-EFGH` (40 bits), valid **5 minutes**, one use;
  - limits that slow guessing without letting one LAN host lock the owner out: 5 wrong codes a minute per address,
    and a code that has seen 10 wrong tries in total is void (the PC then says "a device kept typing wrong codes").
    40 bits against at most 10 tries is a 1 in 10^11 chance.
  Only the code's SHA-256 is stored (sealed); one pending code at a time (a new one replaces it).
- **The phone**: the page it opens (not signed in) asks for the code and a name for the device, and trades them
  (`POST /api/pair`: JSON, the CSRF header, exact `Host` and `Origin: https://<address>:<port>`) for a device
  credential: cookie `__Host-sbxdev` = `<device id>.<32 random bytes>`, `HttpOnly; Secure; SameSite=Strict; Path=/`,
  `Max-Age` = the remember time. Only the token's SHA-256 is stored, sealed with `SecretStore` in
  `<storage>\web\access.json` (the private folder of the web state); a device is looked up by id, then its hash is
  compared in constant time. The device's name and the address it paired from are cleaned (`safeText`, 40 characters)
  and shown on the PC.
- **Devices** are listed (name, role, address, paired, last seen, expires) on the Remote access page, the CLI
  (`sandbox web devices`) and the menu, and can be revoked one by one or all at once. Turning LAN mode off revokes
  every device.
- Host and Origin checks extend to the LAN listener's own `<address>:<port>` (`https://` only); everything else
  (CSP, CSRF header, no CORS) is unchanged.

## 4. Remember access

`web.remote.rememberDays` (1-90, default 30): how long a device or a Windows sign-in stays signed in. **Fixed, not
sliding**: the credential ends that many days after it was issued, however often it is used, so a stolen one cannot
live forever; allowing the device again (or `sandbox remote --browser` again) starts a new period. Revocation works at
any time, for one or for all: `sandbox web revoke <device>|--all`, the page, the menu. Every credential has an id and
an issue time, and "revoke all" moves an epoch, so nothing revoked ever comes back (removing and re-adding a user does
not revive their old cookie). Changing the setting applies to new credentials. Turning LAN mode off revokes every
device; taking a Windows user off the list ends their access at once.

## 5. Roles, enforcement and the audit log

- The server knows the caller of every request and socket: owner (token cookie), Windows user (bound cookie) or device
  (device cookie). `/api/me` tells the page who it is and what it may do, so the page disables what the role cannot
  do; the server refuses it either way.
- RPC: the socket checks the caller's role **as it is now** before every call and every subscription, and
  `createRpcHost` checks again before it runs. A refusal is a normal error ("Your access is view only.").
- Terminals: view opens them read-only (the bridge drops keystrokes); new sessions need control.
- **Open sockets end with the access**: every socket remembers its credential; revoking, expiry, a role change, taking a
  user off the list or turning LAN mode off closes them (checked when the access changes and every 30 seconds).
- `/api/stop` (stopping the web server) is the owner's.
- **Audit**: every remote operation (who, what, ok/refused/failed), sign-ins, pairings, wrong codes and revocations
  are written to the audit log (`k: 'remote'`) of the owner's data set, so the Activity page and
  `sandbox audit --kind remote` show them. Owner calls through the token link are not "remote" and are not logged there.

## 6. Settings

All under `web.remote`, never in `LocalOverrides` (a repo's `.sandbox-config.json` cannot set any of it; a self-test
checks that), with the defaults keeping today's behaviour:

| Setting | Default | What |
| --- | --- | --- |
| `web.remote.windowsSignIn` | `false` | Other Windows users on `users` may sign in with their Windows account (`sandbox remote`, also `--browser`). |
| `web.remote.users` | `[]` | `{ "name": "bob", "role": "view" \| "control" }`. |
| `web.remote.rememberDays` | `30` | 1-90 days, fixed. |
| `web.remote.lan.enabled` | `false` | The HTTPS listener for devices on your network. |
| `web.remote.lan.port` | `47801` | 1024-65535, not `web.port`. |
| `web.remote.lan.address` | `""` | Empty: this PC's private address; else one of them. |

Every setting but a short list of harmless ones is owner-only on every remote surface.

## Threats and answers

| Threat | Answer |
| --- | --- |
| Someone on the internet | Not reachable: private address only, Private profile + LocalSubnet rule, non-local peers dropped in the server, no tunnels or port mapping. |
| Another local user without a grant | Nothing works: no token, the pipe refuses them (and it is logged). |
| A relay into Bob's session (WSL, ssh -L, a tunnel) | Identity comes from the pipe client's token, not from a TCP connection. |
| A local process steals a Windows cookie (via another 127.0.0.1 port) | The cookie only works from Bob's own connections. |
| A squatter on the pipe name or the port | `sandbox remote` checks the pipe's server is in the owner's session before sending anything. |
| Someone on the LAN | Needs a device credential; allowing a device needs a 5-minute one-time code from the owner's screen; limits. |
| MITM on the LAN while allowing a device | Not fully solvable in a page. The certificate warning, the fingerprint on the PC, the device's address shown on the PC, default role view, "a later warning means stop". |
| The sandbox reaches the LAN listener | Peers from `vEthernet` subnets and non-on-link peers are dropped, and it still needs a credential. |
| A stolen phone | Its role at most (never owner): no new devices, no secrets, no settings beyond the harmless ones; revoke it; it expires. |
| A control user escalates to owner | Operations are owner by default; control is an explicit short list; settings only the harmless keys. What remains is documented: they can read what the agents can. |
| Revoked but still connected | Its sockets are closed; every call re-checks. |
| A repo turns it on | `web.*` is not in `LocalOverrides`. |
| Brute force | Codes: 40 bits, 5 wrong a minute per address, void after 10, 5 minutes; device tokens 256 bits. |
| DNS rebinding, CSRF, other sites | Host must be our loopback or LAN `address:port`; Origin checked; CSRF header; `SameSite=Strict`; no CORS. |

## Second opinion

An Opus advisor reviewed the first draft of this design. Their findings and what changed:

| | Finding | Answer |
| --- | --- | --- |
| C1 | The owner's existing loopback cookie is sent to every port of 127.0.0.1, so another local server the owner visits can take it and replay it. | True today, outside this change. Passed to the security sweep (it owns `auth.ts`); recommended fix: the login as a header or WebSocket protocol from port-scoped storage. Windows cookies get the per-connection user check; device cookies are refused on loopback and from this PC's own addresses. |
| C2 | "control" was nearly owner: settings like mappings, roots, agents' folders and environment, secrets stripping, network, storage, audit, the updater and the folder picker let a control user escalate or take secrets. | Adopted: operations are owner unless they say control; control is a short explicit list; `settings.set`/`reset` allow control only for harmless keys; documented that control reads what agents read. |
| C3 | A TCP connection's session is not an identity (WSL relay, `ssh -L`, tunnels, the sandbox's port forwards, PID reuse). | Adopted: identity from a named pipe client's token (`ImpersonateNamedPipeClient`, integrity and AppContainer checks), handing out a one-time link; the TCP check is kept only as the second layer for Windows cookies (full 4-tuple, process start time). |
| H1 | Revocation must reach open sockets. | Adopted: sockets carry their credential, are closed on change and checked every 30 s; every RPC call re-checks the role; the terminal bridge drops a viewer's keystrokes. |
| H2 | The sandbox can reach the host's LAN address from the Default Switch subnet. | Adopted: on-link peers of the chosen adapter only, `vEthernet` subnets listed at every check and refused. |
| H3 | Each listener must accept a fixed set of credentials. | Adopted (see "What each listener accepts"). |
| H4 | The pairing MITM cannot be fixed in the page. | Agreed: default role view, a long-lived certificate never replaced quietly, the device's address on the PC, "a later warning means stop". A PC-side approval step is an open decision for the user (they asked for the simpler of code or approval). |
| H5 | The firewall rule is loose; a laptop on a wrong "Private" network. | The rule is kept to Private + LocalSubnet + this Node; LAN mode starts only on a Private network and only the one it was turned on for. A rule only while running would need UAC at every start: not done. |
| M1 | View is about integrity, not confidentiality. | Documented; no secret values, tokens or endpoints reach non-owners. "View without terminals" is an open decision. |
| M2 | `sandbox remote` races; does it bypass `ownerRule`? | The pipe check replaces the port check; the record folder is not writable by the group; a control role may do more than a borrower, by the owner's choice (documented). |
| M3 | Epochs for credentials. | Adopted. |
| M4 | A global lockout lets any LAN host block pairing. | Adopted: per-address limits; a code is void after 10 wrong tries, and the PC says so. |
| L1-L4 | Exact Origin/Host on `/api/pair`; notify sign-ins; DER encoder tested against `X509Certificate`; a test that control cannot set protected settings. | Adopted (notifications as audit lines and the devices list). |

A second pass (on the revised section 3) added:

| | Finding | Answer |
| --- | --- | --- |
| C1+ | `sandbox web open` can hand the token link to a squatter on the web port. | Passed to the security sweep with C1 (check that the listening socket's process is the owner's before putting a token in a URL; the `tcp-peer` helper can do it). |
| H2 | The TCP-table lookup can race (process exit, PID or port reuse). | Adopted in `tcp-peer`: table, then session, then table again; same PID, ESTABLISHED, the server-side row is ours; users compared by SID, not session number. |
| H6 | The guest reaches the LAN listener through the Default Switch's forwarding. | Adopted: the firewall rule also names the local address; every accepted socket's `localAddress` must be the address we bound; peers in any `vEthernet` subnet are dropped. |
| M1 | Names in `web.remote.users` are ambiguous. | Adopted: names are turned into SIDs by Windows (`LookupAccountName`) and SIDs are compared. |
| M4 | A helper process per connection invites a denial of service. | Adopted: one long-running helper (`HostTools web-helper`, JSON lines on stdin/stdout) serves the pipe, the peer checks and the name lookups; its queue is capped. |
| M7 | Another HTTPS server on the same address (a forwarded sandbox port) would receive the device cookie. | Documented. |
| L1 | `localhost` in `hostAllowed` lets a squatter on `[::1]` catch requests. | Passed to the security sweep (it owns `auth.ts`). |
| L2 | Certificates: SAN IP entries, serverAuth, at most 397 days (Apple). | Adopted: 397 days; the PC shows when it ends; renewed only on request. |
| L3 | Code attempts with no code pending must not count. | Adopted. |
| L4 | The elevated script must hash the bytes it reads. | Adopted: it reads the request once, checks its SHA-256 (given as a parameter) and parses those bytes. |

## Phases

1. Settings and this document.
2. The access store (devices, sealed token hashes, codes, expiry, epochs, revocation), the roles in the shared core,
   `createRpcHost` and the RPC socket, the audit lines.
3. Windows sign-in (HostTools `web-door`, `pipe-server`, `tcp-peer`; fakes in the tests) and `sandbox remote`.
4. LAN mode: address and peer checks, certificate, the HTTPS listener, the network profile and firewall scripts.
5. The Remote access page (web, menu, CLI) with "Allow a new device", the address and the devices; the phone's code
   screen.
