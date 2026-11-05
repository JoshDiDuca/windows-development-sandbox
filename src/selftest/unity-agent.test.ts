// Unity agent tools: sbx-unity in Claude Code's and Codex's MCP settings, the Apps add-ons (MCP for Unity, openupm-cli)
// and their lock files. Pure: nothing is installed or run.
import fs from 'node:fs';
import path from 'node:path';
import {
  addonMcpServer,
  APPS,
  codexWithAddonMcpServers,
  type McpServerConfig,
  withAddonMcpServers,
} from '../shared/apps/index.js';
import { UNITY_MCP_NAME, unityCliMcpServer } from '../shared/unity/index.js';
import type { Suite } from './support/suite.js';

export const unityAgentSuite: Suite = {
  name: 'unity-agent',
  title: 'Unity agent tools: MCP, guide, Apps add-ons',
  run: (t) => {
    t.section('sbx-unity in the agents');
    const server: McpServerConfig = unityCliMcpServer(
      'C:\\AgentData\\tools\\unity\\cli\\1.0.0\\unity.exe',
      'C:\\Workspace\\game',
    );
    const mine = { mine: { type: 'stdio', command: 'mine.exe', args: [], env: {} } };
    // The guest's ENGINE_MCP_NAMES (guest/setup/addon-mcp.ts) cannot be imported here: it loads the guest runtime.
    const engineNames = ['sbx-unreal-editor', UNITY_MCP_NAME];
    const names = [...APPS.flatMap((a) => (a.mcp ? [a.mcp.name] : [])), ...engineNames];
    const on = withAddonMcpServers(mine, { [UNITY_MCP_NAME]: server }, names);
    t.check('mine' in on && UNITY_MCP_NAME in on, 'your own servers are kept and sbx-unity is added');
    const off = withAddonMcpServers(on, {}, names);
    t.check('mine' in off && !(UNITY_MCP_NAME in off), 'sbx-unity is removed when it is off; your servers stay');

    const codex = codexWithAddonMcpServers('', { [UNITY_MCP_NAME]: server }, engineNames);
    t.check(
      codex.toml.includes('[mcp_servers.sbx-unity]') && codex.toml.includes('args = ["mcp", "--cli-tools"]'),
      'Codex gets [mcp_servers.sbx-unity] with args = ["mcp", "--cli-tools"]',
    );

    t.section('Apps add-ons');
    const unity = APPS.find((a) => a.id === 'unity-mcp')!;
    const built = addonMcpServer('C:\\x', unity.mcp!, { exe: 'C:\\x\\venv\\Scripts\\mcp-for-unity.exe' });
    t.check(
      built?.type === 'stdio' &&
        built.command === 'C:\\x\\venv\\Scripts\\mcp-for-unity.exe' &&
        built.args.join(' ') === '--transport stdio' &&
        built.env.DISABLE_TELEMETRY === '1' &&
        built.env.UNITY_MCP_DISABLE_TELEMETRY === '1' &&
        built.env.MCP_DISABLE_TELEMETRY === '1' &&
        unity.mcp?.name === 'sbx-unity-mcp' &&
        unity.mcp.codex === true,
      'MCP for Unity runs mcp-for-unity.exe --transport stdio with telemetry off, for Claude Code and Codex',
    );
    const openupm = APPS.find((a) => a.id === 'openupm-cli');
    t.check(
      openupm?.exe === 'openupm.cmd' && openupm.category === 'gamedev' && !openupm.mcp,
      'openupm-cli is a game-development app',
    );
    const addons = path.join(process.cwd(), 'sandbox', 'addons');
    const reqs = fs.readFileSync(path.join(addons, 'unity-mcp', 'requirements.txt'), 'utf8');
    t.check(
      fs
        .readFileSync(path.join(addons, 'unity-mcp', 'requirements.in'), 'utf8')
        .includes('mcpforunityserver==10.3.0') &&
        /^mcpforunityserver==10\.3\.0 \\\r?\n\s+--hash=sha256:[0-9a-f]{64}/m.test(reqs),
      'the MCP for Unity lock file pins mcpforunityserver 10.3.0 with hashes',
    );
    const lock = fs.readFileSync(path.join(addons, 'openupm-cli', 'package-lock.json'), 'utf8');
    t.check(
      fs.existsSync(path.join(addons, 'openupm-cli', 'package.json')) &&
        lock.includes('"node_modules/openupm-cli"') &&
        lock.includes('"version": "4.5.3"'),
      'the openupm-cli lock file pins 4.5.3',
    );
  },
};
