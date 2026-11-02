# Perplexity, Comet and computer-use tools

Tools that let the agents search the web, hand work to a cloud agent, or drive a browser. All of them are in **Apps**
(off by default, and only in your own settings: a project's `.sandbox-config.json` cannot turn them on). The two
Perplexity sign-ins live in **Accounts**, like every other [service sign-in](accounts.md).

| App (`apps.install` id)                           | What it does                                                                                     | Sign-in                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Perplexity Computer MCP (`perplexity-computer-mcp`) | Hands tasks to Perplexity Computer, Perplexity's cloud agent, from Claude Code and Codex        | your Perplexity account (OAuth), kept with the agent login |
| Perplexity MCP (`perplexity-mcp`)                 | Web search, answers, deep research and reasoning from Perplexity's API                            | a Perplexity API key (`accounts.perplexity`)     |
| Comet (`comet`)                                   | Perplexity's agentic browser (Chromium), portable                                                 | your perplexity.ai sign-in (`accounts.comet`)    |
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

- **The Perplexity desktop app ("Personal Computer")**: it is only in the Microsoft Store (MSIX), Windows Sandbox has
  no Store, and it would be a 767 MB reinstall every boot. Perplexity Computer MCP gives the agents the same.
- **ChatGPT Atlas**: macOS only, and discontinued.
- **Claude desktop's Cowork**: needs the Virtual Machine Platform, which Windows Sandbox does not have.
- **Edge Copilot Mode, Gemini in Chrome**: tied to Microsoft or Google sign-in brokers, and US previews.
- **Codex app computer use**: Store-only, and not available in the UK or EEA.
- **Anthropic's computer-use reference**: runs in Docker, which Windows Sandbox cannot run.
- **Opera Neon, Manus, Dia, Skyvern**: maybe later; not verified enough yet.

## Updating the pinned versions (for contributors)

The versions are in `src/shared/apps/catalogue-agents-web.ts`, the lock files in `sandbox\addons\<id>`. Renew them as
for the other add-ons ([toolchains.md](toolchains.md#agent-add-ons)).
