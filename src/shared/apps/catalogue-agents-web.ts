// Perplexity and the computer-use tools agents drive a browser with (P8): Perplexity's API MCP server and its remote
// Computer MCP server, the Comet browser, comet-mcp, Chrome DevTools MCP and Browser Use. Entries of the apps
// catalogue, pure data like catalogue.ts (which lists them). All yours only: they change what the agents can reach.
// Not offered, and why: docs/agents-web.md.
import type { AppEntry } from './catalogue.js';
import type { AppSigner } from '../signer.js';

/** Pinned packages, installed from the lock files in sandbox\addons\<id> (renewing them: docs/toolchains.md). */
export const PERPLEXITY_MCP_VERSION = '1.3.0';
export const COMET_MCP_VERSION = '2.3.0';
export const CHROME_DEVTOOLS_MCP_VERSION = '1.12.0';
export const BROWSER_USE_VERSION = '0.13.14';

/** Perplexity Computer's official MCP server (HTTP; OAuth with your Perplexity account; uses Computer credits). */
export const PERPLEXITY_COMPUTER_MCP_URL = 'https://www.perplexity.ai/rest/computer/mcp';
/** Comet's Windows installer: a redirect to the current release (no checksum is published; its signer is checked). */
export const COMET_DOWNLOAD_URL = 'https://www.perplexity.ai/rest/browser/download?platform=win_x64&channel=stable';
/** Who signs Comet: Perplexity AI, Inc., with an EV code-signing certificate from GlobalSign. */
export const COMET_SIGNER: AppSigner = {
  subject: ['^CN="?PERPLEXITY AI, INC\\.?"?(,|$)', '(^|, )O="?PERPLEXITY AI, INC\\.?"?(,|$)'],
  issuer: ['^CN=GlobalSign GCC R45 EV CodeSigning CA 2020(,|$)'],
};
/** Microsoft Edge, already in every sandbox: the browser Chrome DevTools MCP starts. */
const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export const AGENTS_WEB_APPS: readonly AppEntry[] = [
  {
    id: 'perplexity-mcp',
    name: 'Perplexity MCP (API)',
    category: 'agents',
    about:
      "Web search, answers and deep research from Perplexity's API in Claude Code and Codex (perplexity_search, perplexity_ask, perplexity_research, perplexity_reason): Perplexity's own @perplexity-ai/mcp-server. Needs your Perplexity API key in Accounts; API use is billed separately from Perplexity Pro.",
    size: '30 MB',
    source: { locked: 'npm', package: '@perplexity-ai/mcp-server', version: PERPLEXITY_MCP_VERSION },
    exe: 'perplexity-mcp.cmd',
    service: true,
    mcp: {
      name: 'sbx-perplexity',
      script: 'node_modules/@perplexity-ai/mcp-server/dist/index.js',
      envVars: ['PERPLEXITY_API_KEY'],
      codex: true,
    },
    plugsInto:
      'Claude Code and Codex as the MCP server sbx-perplexity; the key comes from Accounts as PERPLEXITY_API_KEY, never from a file',
    userOnly: true,
  },
  {
    id: 'perplexity-computer-mcp',
    name: 'Perplexity Computer MCP',
    category: 'agents',
    about:
      "Hands tasks to Perplexity Computer, Perplexity's cloud agent (it browses and works in its own cloud computer), from Claude Code and Codex: Perplexity's official remote MCP server. Nothing is installed. Sign in with your Perplexity account the first time (Claude Code: /mcp; Codex: codex mcp login sbx-perplexity-computer); tasks spend your Computer credits.",
    size: '0 MB',
    source: { remote: true },
    exe: '',
    service: true,
    mcp: { name: 'sbx-perplexity-computer', url: PERPLEXITY_COMPUTER_MCP_URL, codex: true },
    plugsInto:
      'Claude Code and Codex as the remote MCP server sbx-perplexity-computer; its sign-in is kept with your agent login',
    userOnly: true,
  },
  {
    id: 'comet',
    name: 'Comet (Perplexity browser)',
    category: 'browsers',
    about:
      "Perplexity's agentic browser (Chromium), unpacked to run portable with its own profile on the sandbox's disk. With accounts.comet.share on, your perplexity.ai sign-in is kept for the next sandboxes. Its assistant acts on the pages it reads, so a page can try to steer it: browse only what you would let it act on.",
    size: '600 MB',
    source: { resolve: 'comet' },
    unpack: 'chromium',
    exe: 'comet.exe',
    needs: ['7zip'],
    signer: COMET_SIGNER,
    userOnly: true,
  },
  {
    id: 'comet-mcp',
    name: 'Comet MCP',
    category: 'agents',
    about:
      "Lets Claude Code and Codex hand web tasks to Comet's own assistant and read its answers (hanzili/comet-mcp). Needs the Comet app: start Comet from its shortcut first, so the agent uses the sandbox's Comet profile and your sign-in.",
    size: '15 MB',
    source: { locked: 'npm', package: 'comet-mcp', version: COMET_MCP_VERSION },
    exe: 'comet-mcp.cmd',
    service: true,
    mcp: { name: 'sbx-comet', script: 'node_modules/comet-mcp/dist/index.js', codex: true },
    plugsInto: "Claude Code and Codex as the MCP server sbx-comet, talking to Comet's DevTools on 127.0.0.1:9222",
    userOnly: true,
  },
  {
    id: 'chrome-devtools-mcp',
    name: 'Chrome DevTools MCP',
    category: 'agents',
    about:
      "Lets Claude Code and Codex drive and inspect a browser with DevTools: navigate, click, read the console and network, record performance traces (ChromeDevTools/chrome-devtools-mcp). It starts Microsoft Edge with a throwaway profile; Google's usage statistics and CrUX lookups are off.",
    size: '40 MB',
    source: { locked: 'npm', package: 'chrome-devtools-mcp', version: CHROME_DEVTOOLS_MCP_VERSION },
    exe: 'chrome-devtools-mcp.cmd',
    service: true,
    mcp: {
      name: 'sbx-chrome-devtools',
      script: 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
      args: ['--executablePath', EDGE_EXE, '--isolated', '--no-usage-statistics', '--no-performance-crux'],
      codex: true,
    },
    plugsInto: 'Claude Code and Codex as the MCP server sbx-chrome-devtools (with Edge)',
    userOnly: true,
  },
  {
    id: 'browser-use-mcp',
    name: 'Browser Use MCP',
    category: 'agents',
    about:
      "Browser automation for agents from Browser Use (browser-use --mcp): open pages, click, type, read them, and hand a whole task to Browser Use's own agent (that one needs an OpenAI or Anthropic API key). It finds Edge in the sandbox; its telemetry is off.",
    size: '250 MB',
    source: { locked: 'uv', package: 'browser-use', version: BROWSER_USE_VERSION },
    exe: 'browser-use.exe',
    service: true,
    mcp: {
      name: 'sbx-browser-use',
      program: true,
      args: ['--mcp'],
      env: { ANONYMIZED_TELEMETRY: 'false' },
      codex: true,
    },
    plugsInto: 'Claude Code and Codex as the MCP server sbx-browser-use',
    userOnly: true,
  },
];
