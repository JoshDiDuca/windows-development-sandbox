# Perplexity, Comet and computer-use tools

Tools that let the agents search the web, hand work to a cloud agent, or drive a browser. All of them are in **Apps**
(off by default, and only in your own settings: a project's `.sandbox-config.json` cannot turn them on). The two
Perplexity sign-ins live in **Accounts**, like every other [service sign-in](accounts.md).

| App (`apps.install` id)                           | What it does                                                                                     | Sign-in                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Perplexity Computer MCP (`perplexity-computer-mcp`) | Hands tasks to Perplexity Computer, Perplexity's cloud agent, from Claude Code and Codex        | your Perplexity account (OAuth), kept with the agent login |
| Perplexity MCP (`perplexity-mcp`)                 | Web search, answers, deep research and reasoning from Perplexity's API                            | a Perplexity API key (`accounts.perplexity`)     |
| Comet (`comet`)                                   | Perplexity's agentic browser (Chromium), portable                                                 | your perplexity.ai sign-in (`accounts.comet`)    |
| Perplexity desktop app (`perplexity-desktop`)     | Perplexity's Windows app with Perplexity Computer, from the Microsoft Store                      | your perplexity.ai sign-in (`accounts.perplexityapp`) |
| Comet MCP (`comet-mcp`)                           | Lets the agents hand web tasks to Comet's own assistant and read its answers                      | through Comet                                    |
| Chrome DevTools MCP (`chrome-devtools-mcp`)       | Drives and inspects a browser with DevTools (console, network, performance traces), with Edge     | none                                             |
| Browser Use MCP (`browser-use-mcp`)               | Browser automation from Browser Use; its own task agent needs an OpenAI or Anthropic API key      | none (an LLM key for its agent)                  |

Every MCP server goes into the sandbox's Claude Code (user scope, names starting `sbx-`) and into the sandbox's Codex
(`[mcp_servers.sbx-...]` in `config.toml`) every boot while it is on, and is removed when it is off. Your own servers
are never touched, and nothing on your PC changes.

## Perplexity Computer (the cloud agent)

Turn on **Perplexity Computer MCP**. It is Perplexity's official remote MCP server,
`https://www.perplexity.ai/rest/computer/mcp`: nothing is installed in the sandbox. The first time, sign in with your
Perplexity account: in Claude Code with `/mcp` (pick `sbx-perplexity-computer`), in Codex with
`codex mcp login sbx-perplexity-computer`. Tasks run in Perplexity's cloud and spend your Computer credits.

The sign-in is kept between sandboxes:

- Claude Code keeps MCP sign-ins in `.credentials.json`, which is part of your saved Claude logins.
- Codex keeps them in Windows Credential Manager by default, which is wiped with the sandbox. So the sandbox sets
  `mcp_oauth_credentials_store = "file"` in Codex's `config.toml` at boot (unless you set it yourself): they go into
  `$CODEX_HOME\.credentials.json` on the data folder, and `harnesses.codex.home.loginFiles` now saves that file with
  your Codex logins.

## Perplexity API

Turn on **Perplexity MCP** (`@perplexity-ai/mcp-server` 1.3.0, pinned with its lock file): the agents get
`perplexity_search`, `perplexity_ask`, `perplexity_research` and `perplexity_reason`. It needs an API key from
[perplexity.ai/account/api](https://www.perplexity.ai/account/api/keys). **Perplexity Pro does not include API use;
the API key is billed separately.**

```powershell
sandbox account import perplexity                 # this PC's PERPLEXITY_API_KEY (this terminal, else your user environment)
sandbox account import perplexity --from .env     # the PERPLEXITY_API_KEY line of a file (nothing else in it is kept)
sandbox account login perplexity                  # type it (hidden)
sandbox config set accounts.perplexity.share true
```

The key is kept encrypted on your PC, and shown only as `pplx-...` and its last 4 characters. A sandbox where
Perplexity MCP is on gets it as the variable `PERPLEXITY_API_KEY` of the agent, in memory only: no file in the sandbox,
the launch folder or the data folder holds it. Claude Code passes its environment to the server; Codex is told the
variable's name (`env_vars`), never its value.

## Comet

Turn on **Comet** (category Browsers, about 600 MB). The installer comes from Perplexity's own download address. It has
no published checksum, so it is kept only when its Authenticode signature is valid and names **Perplexity AI, Inc.**,
issued by GlobalSign GCC R45 EV CodeSigning CA 2020. It is not run: 7-Zip opens it stage by stage (the updater, then
`mini_installer.exe`, then `chrome.7z`) and the browser runs portable from `C:\AgentData\tools\apps\comet`, with no
updater and nothing registered. If a new installer cannot be opened that way, the signed installer is kept instead and
run with `--install --silent` at every boot, after its signature is checked again.

Start Comet from its shortcut (desktop, or **Start > Sandbox apps**). It uses its own profile on the sandbox's disk
(`%LOCALAPPDATA%\AgentSandbox\comet-profile`) and listens for DevTools on `127.0.0.1` only.

**Your sign-in.** Your Comet sign-in can't be copied from this PC: Windows locks it to your PC account (and reading
another browser's cookies is what password stealers do). Sign in once inside a sandbox and it is kept for the next
ones. With `accounts.comet.share` on:

- While the sandbox runs, the sandbox asks the running Comet every two minutes for the cookies of
  `perplexity.ai` (only those addresses are asked for) and keeps only the persistent, HttpOnly ones: the sign-in.
  When they change, your PC seals them into its store on the next sync. Never saved passwords, other sites' cookies,
  localStorage or history.
- The next sandbox gets them back: they are written into Comet's profile over DevTools once Comet is ready.
- Several sandboxes can use it at once; the sign-in the last one hands back is kept.

## Perplexity desktop app (Microsoft Store)

Turn on **Perplexity (desktop app)** (`perplexity-desktop`, about 300 MB). The app exists only in the Microsoft Store
(product `9P9XG917PWCJ`, package family `PerplexityAI.PerplexityApp_3jh4kjrg4dzr2`; the old installer gives a 404), and
Windows Sandbox has no Store. So **this PC** fetches the package and the sandbox installs it:

1. At every launch with the app on, your PC runs `winget download --id 9P9XG917PWCJ --source msstore` (script
   `native\scripts\get-store-package.ps1`), with **your own** Windows and Microsoft Store access. No account token is
   held, asked for or hard-coded anywhere. The original signed `.msix` and its frameworks (VCLibs ...) are kept in
   `<storage>\store-packages\9P9XG917PWCJ` and looked for again after 30 days (a failed look keeps the old copy). To
   fetch again now, delete that folder.
2. The files are hashed on your PC and copied into the data folder (`toolspps\perplexity-desktop.package`, with
   `store-package.json`). Nothing is repacked, so the publisher's signature stays and Windows checks it as it would
   any Store package.
3. In the sandbox, every boot (its Windows is new each time), the files are checked against the hashes and installed
   with `Add-AppxPackage` (`sandbox\scripts\install-store-package.ps1`), frameworks first. The shortcut (desktop and
   **Start > Sandbox apps**) starts the app through `start-store-app.ps1` with its own profile
   (`%LOCALAPPDATA%\AgentSandbox\perplexity-app-profile`) and a DevTools port on `127.0.0.1`.

If winget or the Store is not available on your PC, the launch goes on: it prints what failed and the sandbox skips the
app. Windows does not let the signed package be exported from an already installed app, so the winget download is the
one route used; the fallback of copying the installed folder would lose the signature.

The fetch asks winget for the 64-bit build (`--architecture x64`) and keeps the app plus its frameworks (VCLibs,
WindowsAppRuntime ...) from winget's `Dependencies` folder; 32-bit and ARM frameworks are dropped. The sandbox hands the
frameworks to `Add-AppxPackage -DependencyPath`. When the app is not installed, you are told twice: the launch prints
`Perplexity (desktop app): NOT installed in this sandbox. <reason>. Fix: ...` in yellow, and the sandbox's boot summary
and log say `not installed - <reason>`. If **Perplexity app** is shared in Accounts (`accounts.perplexityapp.share`) but
the app itself is not ticked in Apps, the launch also says so: sharing a sign-in does not install the app. To check the
fetch by hand: `winget download --id 9P9XG917PWCJ --source msstore --architecture x64 --download-directory <empty folder>`.

**Your sign-in.** The app is an Electron program: its cookies are encrypted with a key that Windows (DPAPI) seals to your
PC account, so they cannot open in a sandbox, and reading them would be what password stealers do. So, as for Comet,
nothing is taken from this PC. Sign in once inside a sandbox and it is kept for the next ones. With
`accounts.perplexityapp.share` on, the sandbox asks the running app every 30 seconds for the cookies of `perplexity.ai`
only (the persistent, HttpOnly ones) and your PC seals them into its store; the next sandbox writes them back over
DevTools once the app is running (reload its window if it was already showing the sign-in page). The same rules as
Comet's apply: several sandboxes at once, the last hand-back wins, and nothing but those cookies travels.

**What is checked where.** The catalogue, the sign-in kind, the manifest, the fetch and staging (with a fake Store
tool), the hash check and the command lines are in the self-test (`npm test store-app`). Not tested on a machine
without the Store: the real `winget download` (needs your PC), the app starting with the DevTools port, and the cookie
round trip with the real app.

## Comet MCP, Chrome DevTools MCP, Browser Use MCP

- **Comet MCP** (`comet-mcp` 2.3.0, [hanzili/comet-mcp](https://github.com/hanzili/comet-mcp)) talks to Comet on
  DevTools port 9222. With it on, Comet's shortcut opens that port. **Start Comet from its shortcut first**: if
  comet-mcp has to start Comet itself, Comet runs with a fresh profile, without your sign-in.
- **Chrome DevTools MCP** (`chrome-devtools-mcp` 1.12.0) starts Microsoft Edge (already in the sandbox) with a
  throwaway profile. Google's usage statistics and CrUX lookups are off.
- **Browser Use MCP** (`browser-use` 0.13.14, `browser-use --mcp`) installs with uv from a hash-pinned
  `requirements.txt` (about 250 MB). It finds Edge in the sandbox. Its telemetry is off. Its own task agent needs an
  OpenAI or Anthropic API key in the agent's environment.

## Before you turn these on

- **The agent can use these accounts.** It can read the API key and spend your API credit, spend your Perplexity
  Computer credits, and act as you in Comet. Use a separate API key with a spending limit.
- **Agentic browsing is open to prompt injection.** A page Comet, Browser Use or DevTools reads can try to steer the
  agent. Browse only what you would let it act on.
- **Never import your PC's main browser profile** into a sandbox. Only the Comet sign-in described above travels.

## Not offered, and why

- **ChatGPT Atlas**: macOS only, and discontinued.
- **Claude desktop's Cowork**: needs the Virtual Machine Platform, which Windows Sandbox does not have.
- **Edge Copilot Mode, Gemini in Chrome**: tied to Microsoft or Google sign-in brokers, and US previews.
- **Codex app computer use**: Store-only, and not available in the UK or EEA.
- **Anthropic's computer-use reference**: runs in Docker, which Windows Sandbox cannot run.
- **Opera Neon, Manus, Dia, Skyvern**: maybe later; not verified enough yet.

## Updating the pinned versions (for contributors)

The versions are in `src/shared/apps/catalogue-agents-web.ts`, the lock files in `sandbox\addons\<id>`. Renew them as
for the other add-ons ([toolchains.md](toolchains.md#agent-add-ons)).
