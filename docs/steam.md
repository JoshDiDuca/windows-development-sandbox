# Steam

`toolchains.steam` gives a sandbox **SteamCMD**, Valve's command-line Steam client, and the **`sbx-steam`** helper. You
can use them to download games and dedicated servers, download and upload workshop items, and upload builds of your own
game (ContentBuilder). The full Steam client is optional. Your Steam sign-in is kept in [Accounts](accounts.md), like the
other service sign-ins.

```powershell
sandbox config set toolchains.steam.enabled true      # or leave it on "auto" (see below)
sandbox config set accounts.steam.share true          # let sandboxes keep your SteamCMD sign-in
```

With `"auto"`, Steam turns on for a project that has `steam_appid.txt`, `steam_api64.dll` or `steam_api.dll`, or a
`.vdf` build script whose first block is `"AppBuild"` or `"workshopitem"` (looked for a few folders deep).

| Setting                      | Default | What it does                                                                         |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `toolchains.steam.enabled`   | `auto`  | SteamCMD and `sbx-steam`                                                             |
| `toolchains.steam.client`    | `false` | also the Steam client (see [The Steam client](#the-steam-client))                    |
| `toolchains.steam.sdkFolder` | `""`    | where the Steamworks SDK is; sets `STEAMWORKS_SDK` (see [below](#the-steamworks-sdk)) |
| `accounts.steam.share`       | `false` | sandboxes get your saved SteamCMD sign-in                                            |
| `pcInstalls.steamGames`      | `false` | this PC's Steam games, read-only (see [Games from this PC](#games-from-this-pc))      |

## SteamCMD

SteamCMD comes from Valve's CDN (`steamcdn-a.akamaihd.net/client/installer/steamcmd.zip`). Valve publishes no checksum
for it, so the sandbox checks that `steamcmd.exe` is signed by Valve (Authenticode) before it keeps or runs it. A file
with any other signature is deleted, and downloaded again next boot. This also counts as the check that
`downloads.requireChecksum` asks for.

- Its programs are kept in `tools\steamcmd` on the data disk, so only the first sandbox downloads them.
- Every boot copies them to `C:\SteamCMD`, on the sandbox's own disk, and SteamCMD runs from there. Its `config\`
  folder holds your login, so the login is never stored on the data disk (only sealed, see
  [Signing in](#signing-in-sbx-steam-login)).
- On its first run SteamCMD updates itself (about 300 MB). Boot waits up to 15 minutes for that, then gives up with a
  message. The updated programs are kept in `tools\steamcmd` for the next boot.
- `C:\SteamCMD` is at the end of `PATH` (`steamcmd` works in every terminal), and `STEAMCMD` names `steamcmd.exe`.

## Signing in (sbx-steam login)

```powershell
sbx-steam login your_account_name
```

SteamCMD asks in the terminal for your password and, with Steam Guard, the code from your phone or your email. It keeps
only a login token in `C:\SteamCMD\config\config.vdf` (and, for older accounts, `ssfn*` sentry files). The password
and the Steam Guard code are never stored.

With `accounts.steam.share` on, the sandbox leaves the new login for your PC, which encrypts it for your Windows user.
The next sandboxes start signed in, so you type the password and the code once. When SteamCMD renews the token, the
renewed one goes back the same way.

You can also take the login of a SteamCMD you already use on your PC:

```powershell
sandbox account import steam --from C:\steamcmd   # the folder, its steamcmd.exe or its config\config.vdf
sandbox account status steam                      # saved or not, and the account name
sandbox account logout steam                      # forget it everywhere
```

Without `--from`, `C:\steamcmd` is used. Whether a login taken from another PC or sandbox is accepted, or Steam Guard
asks again, is up to Steam. CI tools copy these files between machines the same way, but check it with your account.

A Steam sign-in works in **one sandbox at a time**. A second sandbox started while the first one runs starts without
it, and the message says which sandbox has it.

Anything that needs no account (most dedicated servers, free tools) works signed out: `sbx-steam` uses `anonymous`
when you are not signed in, or when you add `--anonymous`.

## Downloading apps and workshop items

```powershell
sbx-steam app 740                                 # a game or dedicated server -> tools\steam-apps\740
sbx-steam app 740 --beta public-beta --validate   # a branch, and check every file
sbx-steam app 740 --dir C:\Servers\cs             # somewhere else
sbx-steam workshop get 4000 123456789 987654321   # workshop items of app 4000
sbx-steam games                                   # what is here, and this PC's games mapped read-only
```

- `app` downloads into `tools\steam-apps\<appid>`, which is kept between sandboxes, and updates what is already there.
  It first checks that the data disk has at least 5 GB free (`--need-gb <n>` for a bigger game; dedicated servers
  are often 5-40 GB). Afterwards it prints the size and records it, so `sandbox data` shows it without measuring
  the folder again.
- `workshop get` downloads into `C:\AgentData\cache\steam-workshop\steamapps\workshop\content\<appid>\<item>` and prints
  each item's folder.
- `--user <account>` uses another account that is signed in here.

## Uploading builds (ContentBuilder)

Uploading needs only SteamCMD and your build scripts (the SDK's `tools\ContentBuilder\scripts`). It does not need the
SDK itself.

```powershell
sbx-steam build C:\Workspace\game\steam\app_build_480.vdf             # upload the build
sbx-steam build .\steam\app_build_480.vdf --preview                   # check it: nothing is uploaded
sbx-steam build .\steam\app_build_480.vdf --desc "nightly from CI"    # with a build description
```

This runs SteamCMD's `run_app_build`. With `--preview` or `--desc`, `sbx-steam` writes a copy of the script beside it
with `"Preview" "1"` or `"Desc"` set, so its relative paths still work, and deletes the copy afterwards. The script must
start with an `"AppBuild"` block. Uploading needs your account (not anonymous), and the account needs the
permissions for the app in Steamworks.

## Uploading workshop items

```powershell
sbx-steam workshop push C:\Workspace\mod\workshop_item.vdf
```

This runs SteamCMD's `workshop_build_item` with a script whose first block is `"workshopitem"` (`appid`,
`publishedfileid` 0 for a new item, `contentfolder`, `previewfile`, `title`, `changenote` ...). The item ID Steam gives a
new item is printed by SteamCMD; put it in the script for later updates.

## The Steam client

Set `toolchains.steam.client` to `true` for the full Steam client, for example to test the Steamworks API, the overlay,
or uploads from inside a game.

- `SteamSetup.exe` is unpacked into `tools\steam` once (with its silent install, `/S /D=`). The installer and the
  `steam.exe` it unpacks must both be Valve-signed. `steam.exe` updates itself to 1-1.5 GB the first time you start it.
  Games you install from the client go on top.
- Start it with `sbx-steam client`.
- **Its sign-in does not carry over.** The client locks its saved login to the Windows user, and every sandbox is a
  new one. Sign in to the client in each sandbox. SteamCMD's sign-in above does carry over.
- A project that joins a running sandbox does not install the client: restart the sandbox.

## The Steamworks SDK

The SDK is never downloaded: it needs a Steamworks partner login and its licence. Put it in the project (many keep
`redistributable_bin` and the headers in the repo), or map a folder with it, and point `toolchains.steam.sdkFolder` at
it. A relative path is inside the project. The sandbox then sets `STEAMWORKS_SDK` to that folder, or says in the
boot log when the folder is missing. ContentBuilder uploads (`sbx-steam build`) do not need the SDK.

## Games from this PC

`pcInstalls.steamGames` maps games you already have on this PC into the sandbox, **read-only**. Nothing is copied:

```powershell
sandbox config set pcInstalls.steamGames true          # every library: C:\PcInstalls\steam\library1, library2 ...
sandbox config set pcInstalls.steamGames "[480, 740]"  # only these games: C:\PcInstalls\steam\480 ...
```

Your PC finds Steam through the registry (`SteamPath`), then reads `libraryfolders.vdf` and each game's
`appmanifest_<id>.acf`. `true` maps each library's `steamapps` folder; a list maps each game's install folder. Only you
can turn this on: a project's `.sandbox-config.json` cannot.

Steam cannot update or run games from a read-only folder. For a game the sandbox has to change, `sbx-steam app <id>`
downloads its own copy into `tools\steam-apps` (after the free-space check).

## Sizes

| What                                 | Where                                | Size                    |
| ------------------------------------ | ------------------------------------ | ----------------------- |
| SteamCMD                             | `tools\steamcmd`, copy in `C:\SteamCMD` | ~0.3 GB              |
| Games and dedicated servers (`app`)  | `tools\steam-apps\<appid>`           | the game's size         |
| Workshop items                       | `cache\steam-workshop`               | the items' size         |
| The Steam client                     | `tools\steam`                        | 1-1.5 GB, games on top  |
| Your PC's games                      | `C:\PcInstalls\steam` (read-only)    | 0 (not copied)          |

`sandbox data` lists them, and you can delete what you no longer need there.

## What cannot be done, and why

- **Downloading the Steamworks SDK**: it needs a partner login and its licence terms. See
  [The Steamworks SDK](#the-steamworks-sdk).
- **Keeping a Steam Guard secret** (the TOTP seed of a mobile authenticator): that would let the agent sign in as you
  at any time, with no second factor. Type the code when SteamCMD asks.
- **Keeping the Steam client's own sign-in**: Windows locks it to your user, so it cannot be used in another one.
- **Playing or updating your PC's games in place**: they are mapped read-only. Download a copy with `sbx-steam app`.
- **Anti-cheat-protected multiplayer games**: many refuse to run in a virtual machine.

## Security notes

- **The agent can use your Steam account while a sandbox has it.** With `accounts.steam.share` on, anything in the
  sandbox can run SteamCMD as you: download what you own, and upload builds and workshop items to apps your account
  can change. Consider a separate Steam account with only the Steamworks permissions the agent needs (for example a
  build account limited to one app and a beta branch).
- No password is kept, anywhere. Only SteamCMD's login token and sentry files are kept, encrypted on your PC with
  Windows DPAPI. A sandbox gets them in a file it reads once and deletes at boot.
- `sandbox account logout steam` forgets the saved login everywhere, including a renewed copy a sandbox left behind.
  To end the token itself, use "Deauthorize all other devices" in Steam Guard settings on the Steam website.
- `sbx-steam` checks every value it passes to SteamCMD (app and item IDs are digits, branch and account names are
  plain words, scripts are full paths), so nothing can add another SteamCMD command.
