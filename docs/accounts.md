# Service sign-ins

Sandboxes are wiped when they close, so a game store, an engine or a signing key would have to be set up again every
time. You can save these sign-ins once on your PC and let sandboxes have them. They all live in **Accounts**: the
`sandbox account` command, the menu's Accounts page and the web UI's Accounts page. No service has a command of its
own.

| Service    | What is kept                                                                  | Get it with                                    | Used by                                  |
| ---------- | ----------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `epic`     | the Epic Games Launcher's "Remember me" sign-in                               | sign in once in a sandbox, or `import epic`    | Unreal                                   |
| `steam`    | SteamCMD's cached login (no password)                                         | `sbx-steam login` in a sandbox, or `import`    | Steam                                    |
| `unity`    | your Unity licence file (Personal), or your Unity ID and Plus/Pro serial      | sign in once in a sandbox, `import` or `login` | Unity ([unity.md](unity.md))             |
| `cfx`      | a FiveM / RedM server licence key (and a Steam Web API key)                   | `import cfx --from server.cfg`, or `login cfx` | the FiveM server                         |
| `keystore` | an Android upload keystore and its passwords                                  | `import keystore --from upload.jks`            | Android (and Flutter, React Native ...)  |
| `play`     | a Google Play service account key                                             | `import play --from key.json`                  | Android                                  |
| `expo`     | an Expo access token (`EXPO_TOKEN`)                                           | `login expo`                                   | React Native / Expo                      |
| `appstore` | an App Store Connect API key (`.p8`, issuer ID, key ID)                       | `import appstore --from AuthKey.p8`            | React Native, Flutter                    |
| `perplexity` | a Perplexity API key (`PERPLEXITY_API_KEY`, `pplx-...`)                   | `import perplexity` (this PC's variable), `--from .env`, or `login` | the Perplexity MCP app |
| `comet`    | the perplexity.ai sign-in cookies of the Comet browser                        | sign in to Comet once in a sandbox (it can't be copied from this PC: Windows locks it to your PC account) | the Comet app |
| `perplexityapp` | the perplexity.ai sign-in cookies of the Perplexity desktop app | sign in to the app once in a sandbox (it can't be copied from this PC: Windows locks it to your PC account) | the Perplexity desktop app |

Unity works now: see [unity.md](unity.md). The Android keys, Expo and App Store Connect come in a later version: their
rows are there, and saving one says so for now. Perplexity, Comet and the Perplexity desktop app work now: see
[agents-web.md](agents-web.md).

## Commands

```powershell
sandbox account status                           # every service: shared or not, saved or not (--json too)
sandbox account status epic                      # one of them
sandbox account import epic                      # take this PC's Epic Games Launcher sign-in (asks first)
sandbox account import keystore --from upload.jks
sandbox account login cfx                        # type a key or token
sandbox account logout steam                     # forget it (asks first; --yes skips the question)
sandbox config set accounts.epic.share true      # let sandboxes have it
```

`sandbox account list` shows your agent logins and, under them, the services that are shared or saved.

## In the menu and the web UI

Each service has a short page: **Shared** (on or off), **Sign-in** (saved with its date, or not saved), **On this PC**
(found or not found, for the ones your PC can give), and **Account** when one is saved. The names are short (Epic
Games, Steam, Unity, FiveM key, Perplexity API, Comet, Perplexity app). The actions on the page are the ones that work
for that service: *Take this PC's sign-in*, *Import from a file...*, *Type the sign-in...*, *Forget...* and the share
toggle. Comet and the Perplexity app offer only the share toggle: sign in once inside a sandbox and it is kept for the
next ones. The full warnings are asked before a sign-in is saved. Anything you change in the menu or the web UI shows on
every page straight away.

## Sharing

Saving a sign-in does not hand it to anything yet. `accounts.<service>.share` (default off) decides whether sandboxes
get it, and then only a sandbox where a toolchain that uses it is on: the Epic sign-in goes to sandboxes with Unreal,
the Unity sign-in to sandboxes with Unity, the keystore to sandboxes that build for Android. A project's
`.sandbox-config.json` can turn sharing off for itself, never on. When a sandbox starts with several projects and one of
them turns it off, the sandbox does not get it.

**Turning sharing on is enough for the ones on your PC.** When a shared service has nothing saved yet, the next launch
takes your PC's own sign-in and saves it, as `import` would: the Epic Games Launcher's, Unity's licence file, SteamCMD's
login and your `PERPLEXITY_API_KEY`. A sign-in taken from your PC follows it: when the PC's has changed since (the Epic
launcher replaces its token whenever it renews it, so an old copy no longer signs in), the launch takes the new one. A
sign-in a sandbox handed back is newer than your PC's and is kept. Comet and the Perplexity desktop app can't be copied
from your PC: sign in once in a sandbox.

**The agent in the sandbox can use every sign-in it gets.** Share only what you would let the agent use.

## One sandbox at a time

An Epic, Steam or Unity sign-in works in one place at a time. The first sandbox that gets one holds it until it stops;
another sandbox started meanwhile starts without it and says which sandbox has it. Taking your PC's Epic sign-in
(`import epic`) signs the launcher on your PC out the first time a sandbox uses it.

## Signing in inside a sandbox

For Epic, Steam and Unity you can also just sign in inside a sandbox. When the tool renews the sign-in, or you sign in
there the first time, the sandbox leaves the new one in its data folder and your PC seals it into its store on its next
sync (every few minutes, and when the sandbox stops). The next sandboxes start signed in.

## How they are kept

- On your PC each one is encrypted with Windows DPAPI for your Windows user (`<storage>\accounts\<service>.json`) and
  never printed. Only its date, where it came from and, for some, the account name are shown.
- It reaches a sandbox only in the one-shot secrets file the sandbox reads and deletes at boot, never in `session.json`
  or the launch folder. In the sandbox it goes to the tool's own files on the sandbox's disk, which is wiped.
- What a sandbox hands back is taken only from the sandbox that holds it, only within its size limit and of the right
  shape, and never through a link. Anything else is deleted unread.
- `logout` deletes the saved one, lets go of its hold, and deletes any copy a sandbox left that your PC has not taken
  yet.

The GitHub token for sandboxes, and the option to use your PC's `gh` login (`github.usePcLogin`), are described in
[configuration](configuration.md#github-token).

See also [security](security.md#service-sign-ins).
