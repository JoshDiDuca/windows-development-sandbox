# FiveM / RedM

A sandbox can run a FiveM or RedM server (FXServer, with txAdmin) for writing and testing resources. You play on it
from the FiveM or RedM client on your PC. The game client itself cannot run in a sandbox (see
[what is not supported](#what-is-not-supported)).

## Setting it up

The server comes under the Cfx.re terms, so it installs only once you accept them (a project file cannot do that for
you):

```powershell
sandbox config set toolchains.fivem.acceptLicense true   # you accept https://fivem.net/terms
sandbox account login cfx                                # your server key, typed once (see below)
sandbox config set accounts.cfx.share true               # let sandboxes have the key
```

With `enabled: "auto"` (the default) the server is installed when the project has an `fxmanifest.lua` or
`__resource.lua` up to 3 folders down (`resources\[local]\shop\fxmanifest.lua`). A C# resource (a manifest that loads
`*.net.dll`, or a `.csproj` in the resource) also turns on .NET.

| Setting                         | Default         |                                                                         |
| ------------------------------- | --------------- | ----------------------------------------------------------------------- |
| `toolchains.fivem.enabled`      | `"auto"`        | `true`, `false` or `"auto"`                                             |
| `toolchains.fivem.acceptLicense` | `false` | needed to install                                                       |
| `toolchains.fivem.game`         | `"gta5"`        | `"gta5"` = FiveM, `"rdr3"` = RedM                                       |
| `toolchains.fivem.artifact`     | `"recommended"` | the server build: `recommended`, `optional`, `latest` or a build number |
| `toolchains.fivem.txAdmin`      | `true`          | `sbx-fivem serve` starts txAdmin (its web panel on port 40120)          |
| `toolchains.fivem.keepVersions` | `2`             | how many server builds to keep                                          |

## Your server key

A server needs a licence key from the Cfx.re portal (<https://portal.cfx.re>, Server keys; it starts with `cfxk_`).
`sandbox account login cfx` asks for it (or `sandbox account import cfx --from server.cfg` reads `sv_licenseKey` and `steam_webApiKey` from an existing server.cfg, ignoring commented-out lines; the last one wins), and for an optional Steam Web API key (32 hex characters, from
<https://steamcommunity.com/dev/apikey>) if your resources use Steam identifiers. Both are kept encrypted on your PC.

At boot a sandbox writes them into one file on its own disk,
`C:\Users\WDAGUtilityAccount\AppData\Local\AgentSandbox\accounts\cfx\server-secrets.cfg`, which goes when the sandbox
closes. `sbx-fivem serve` hands it to FXServer with `+exec` before your `server.cfg`. The key is never written into
your project, the data folder or the tools folder, and it is not in the agent's environment.

## The server (sbx-fivem serve)

```powershell
sbx-fivem init                 # in an empty folder: a server.cfg (with no key in it) and resources\[local]
sbx-fivem serve                # start the server from this folder (txAdmin when toolchains.fivem.txAdmin is on)
sbx-fivem serve --no-txadmin   # plain FXServer: +exec <the key's cfg> +exec server.cfg
sbx-fivem serve --dir C:\Workspace\my-server
```

`serve` opens port 30120 (TCP and UDP) in the sandbox's firewall, only for your PC, and prints the address to
connect to. It stops when you press Ctrl+C.

The server.cfg from `init` keeps the server off the public list (`sv_master1 ""`). The standard resources (chat,
spawnmanager, sessionmanager ...) are not bundled: clone <https://github.com/citizenfx/cfx-server-data> and copy its
`resources` folder to `resources\[cfx-default]`, then remove the `#` before their `ensure` lines, or let txAdmin
deploy a recipe.

## txAdmin

With txAdmin, `sbx-fivem serve` starts FXServer without `+exec`, and txAdmin runs the server. Its data (`txData`)
is kept in the data folder under `state\fivem\txData`, so servers it deploys stay between sandboxes. Port 40120 is
opened for your PC: open `http://<sandbox address>:40120` there and enter the PIN the console prints. Or add
`network.forwardPorts` `{ "pc": 40120, "sandbox": 40120 }` and open `http://localhost:40120`.

txAdmin's setup asks for your server key and writes it into the `server.cfg` it makes, which is in the data folder
and kept. To keep the key out of it, replace the `sv_licenseKey` line in that file with:

```
exec "C:/Users/WDAGUtilityAccount/AppData/Local/AgentSandbox/accounts/cfx/server-secrets.cfg"
```

`serve` prints this line too. The key is never filled in for txAdmin.

## Server builds

The builds (the Cfx.re "artifacts") come from Cfx.re's versions list. Each build is kept in
`tools\fivem\artifacts\<build>`, about 200 MB, and the least recently used ones beyond `keepVersions` are removed.

```powershell
sbx-fivem artifact list           # recommended, optional, latest, critical, and what is installed
sbx-fivem artifact use latest     # install it now; serve and the next sandboxes use it
sbx-fivem artifact use 38164      # a build number (from the list, or from the artifacts page)
sbx-fivem artifact use recommended
```

A build chosen with `artifact use` is remembered in `state\fivem\artifact.json`. Choosing the build your
`toolchains.fivem.artifact` names goes back to that setting.

**Checksums.** Cfx.re publishes none. A build is checked by the Authenticode signature on its `FXServer.exe`, which
must be a valid one from Rockstar Games (who own Cfx.re). With `downloads.requireChecksum` on, a build without that
signature is refused. With it off, such a build is used with a warning. Only `FXServer.exe` is checked, not every file
in the build.

## New resources

```powershell
sbx-fivem new shop --lua     # Lua 5.4
sbx-fivem new shop --js      # JavaScript
sbx-fivem new shop --ts      # TypeScript: npm install, then npm run build (npm run watch keeps building)
sbx-fivem new shop --cs      # C#: dotnet publish -c Release in Client and in Server
```

In a server folder the resource goes in `resources\[local]\<name>`, and `ensure <name>` is added to `server.cfg`.
Elsewhere it goes in the current folder (or `--dir`). Nothing is ever overwritten. Each one has a `/<name>` command
that sends an event to the server and back. A running server picks a new resource up with `refresh` and then
`ensure <name>` in its console; after a change, `restart <name>`.

The C# templates use the `CitizenFX.Core.Client` and `CitizenFX.Core.Server` NuGet packages (FiveM's API). The .NET
SDK comes with the dotnet toolchain, which a C# resource turns on.

`sbx-fivem natives` downloads the natives list (JSON) for the game into `tools\fivem\natives`, for you or the agent
to search. It has no checksum, so `downloads.requireChecksum` refuses it.

## RedM

Set `toolchains.fivem.game` to `"rdr3"`. `serve` then adds `+set gamename rdr3`, txAdmin shows the RedM recipes, and
`new` writes `game 'rdr3'` with RedM's prerelease line (`rdr3_warning`) in the manifest. The natives list is RedM's.

## Databases (oxmysql)

oxmysql needs MySQL. The sandbox's MariaDB is `databases.mysql`: it starts when the project needs it, with
`--database mysql` at launch, or with `sbx-db start mysql` inside. When it runs, `sbx-fivem serve`:

- makes a database called `fivem` (user `root`, no password, 127.0.0.1 only);
- plain: sets `mysql_connection_string` to `mysql://root@127.0.0.1:3306/fivem?charset=utf8mb4` before `server.cfg`,
  so a `set mysql_connection_string` line there wins;
- txAdmin: fills the database fields of txAdmin's setup with it.

## Reaching the server from your PC

The sandbox cannot reach your network (`network.blockPrivateRanges`), but your PC can reach the sandbox on its own
Hyper-V network. `serve` opens 30120 (and 40120 for txAdmin) only for that network, so nothing else on your LAN can
connect. On your PC, start FiveM (or RedM), press F8 and type the address `serve` printed:

```
connect 172.29.144.20:30120
```

`network.forwardPorts` cannot carry the game: it forwards TCP only, and the game also needs UDP. It is fine for the
txAdmin panel. Friends on other PCs cannot join a server in a sandbox.

The server needs the internet to check its key with Cfx.re. With `network.allowOnly`, add `*.fivem.net`, `*.cfx.re`
and `*.cfx-services.net`.

## Modding apps

Add them to `apps.install` (or pick them on the Apps screen): `lua-language-server` (Lua completion and diagnostics
for editors and agents), `stylua` (formatter) and `selene` (linter). Each is a GitHub release checked against its
published SHA-256.

**CodeWalker** (the GTA V map and file editor) is not in the catalogue: it has no download that can be fetched and
checked (it is shared on its author's Discord). To use it, unpack it into a folder in the project (keep it out of
git) and point it at your game mapped read-only from your PC: `pcInstalls.steamGames: [271590]` puts the Steam copy
of GTA V at `C:\PcInstalls\steam\271590`, `pcInstalls.epicGames` maps Epic copies. A copy from the Rockstar Games
Launcher cannot be mapped. CodeWalker draws with DirectX 11: it needs the sandbox's GPU (`sandbox.vGpu`). Save edited
files into your project, never into the game folder (it is read-only).

## What is not supported

- **The FiveM or RedM client in a sandbox.** It needs GTA V or Red Dead Redemption 2 installed and signed in with
  Rockstar Games, and the anti-cheat refuses virtual machines. Play from your PC.
- Hosting for other people: the server is reachable from your PC only.
- The newer "Enhanced" server for GTA V Enhanced (it has a separate download): only the standard FXServer.

## Security notes

- **The agent can use the key.** Anyone with it can run a server under your Cfx.re account. Use a key made for
  development, and remove it in the Cfx.re portal if it leaks. `sandbox account logout cfx` forgets it on your PC.
- The key never lands in the project, so committing or sharing the project does not leak it. Keep it out of the
  `server.cfg` txAdmin makes (see [txAdmin](#txadmin)).
- Resources you download from others run with the server's rights in the sandbox, like any code there.
- The game files mapped for CodeWalker are read-only and only the games you list are mapped.

## Needs checking on a real PC

Tried in a sandbox: the signature on `FXServer.exe` (build 35245), FXServer reading the key's cfg by its full path
with `+exec`, the firewall rules, and building the TypeScript and C# templates. Not tried on a real PC yet: txAdmin
with its data in the data folder (a mapped folder refuses replacing a file by renaming over it), and reaching the
server from the PC's FiveM client on 30120 (TCP and UDP) and txAdmin on 40120.
