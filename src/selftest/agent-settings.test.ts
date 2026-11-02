// Codex settings (launch flags, config.toml), the Claude environment editor and the one Anthropic key pattern.
import fs from 'node:fs';
import { DEFAULTS } from '../core/config/index.js';
import { CodexSchema } from '../core/schema/index.js';
import { agentEnv, agentsEnvSet } from '../app/features/agents/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { runDefinition } from '../app/registry.js';
import { agentArguments, agentShims, codexArguments, codexConfigOwned, shimText } from '../guest/agents/agent-files.js';
import { ANTHROPIC_KEY_PATTERN, anthropicKeyProblem } from '../shared/accounts/index.js';
import { CLAUDE_ENV, ENV_GROUPS } from '../shared/agents/claude-env.js';
import type { AppContext } from '../app/context.js';
import type { Suite } from './support/suite.js';

const CODEX = DEFAULTS.codex;

export const agentSettingsSuite: Suite = {
  name: 'agent-settings',
  title: 'Codex settings, Claude environment editor, Anthropic key pattern',
  run: async (t) => {
    t.section('codex launch flags');
    t.equal(
      codexArguments(CODEX),
      ['--dangerously-bypass-approvals-and-sandbox'],
      'full access + never = the bypass flag',
    );
    t.equal(
      codexArguments({ ...CODEX, sandboxMode: 'workspace-write', approvalPolicy: 'on-request' }),
      ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
      'another mode gets explicit flags',
    );
    t.equal(
      codexArguments({ ...CODEX, sandboxMode: 'danger-full-access', approvalPolicy: 'on-failure' }),
      ['--sandbox', 'danger-full-access', '--ask-for-approval', 'on-failure'],
      'the bypass flag is only for full access with no questions',
    );
    t.equal(
      codexArguments({ ...CODEX, model: 'gpt-5', reasoningEffort: 'high' }).slice(1),
      ['-c', 'model="gpt-5"', '-c', 'model_reasoning_effort="high"'],
      'model and reasoning effort follow as -c overrides',
    );
    t.check(
      CodexSchema.safeParse({ ...CODEX, model: 'x"; evil' }).success === false,
      'a model name cannot carry quotes',
    );
    const codex = DEFAULTS.harnesses.codex;
    t.equal(
      agentArguments('codex', codex, CODEX),
      [...codex.arguments, '--dangerously-bypass-approvals-and-sandbox'],
      "codex's launch arguments carry the flags",
    );
    t.equal(
      agentArguments('claude', DEFAULTS.harnesses.claude, CODEX),
      [...DEFAULTS.harnesses.claude.arguments],
      'other agents do not',
    );
    const shim = agentShims('C:\\AgentData\\tools', DEFAULTS.harnesses, { codex: codexArguments(CODEX) }).find(
      (s) => s.name === 'codex',
    );
    const text = shim ? shimText(shim, { node: 'node.exe', script: 'agent.js' }) : '';
    t.includes(text, '"%SBX_REAL%" --dangerously-bypass-approvals-and-sandbox %*', 'the codex.cmd shim adds the flags');
    t.excludes(
      shimText(
        agentShims('C:\\AgentData\\tools', DEFAULTS.harnesses).find((s) => s.name === 'codex')!,
        { node: 'node.exe', script: 'agent.js' },
      ),
      'dangerously',
      'a shim without flags passes only %*',
    );

    t.section('codex config.toml');
    const old =
      '# Set by the sandbox: x\nsandbox_mode = "danger-full-access"\n\n[tui]\nscreen_reader_detection_done = true\n\n[windows]\nsandbox = "elevated"\n';
    const owned = codexConfigOwned(old, CODEX);
    t.check(
      !owned.includes('sandbox_mode') && !owned.includes('Set by the sandbox') && !owned.includes('sandbox = '),
      'the old sandbox_mode lines and [windows] sandbox are removed',
      owned,
    );
    t.check(
      owned.includes('mcp_oauth_credentials_store = "file"') &&
        owned.includes('[tui]\nscreen_reader_detection_done = true\n') &&
        owned.includes('[windows]'),
      'MCP logins go to a file; every other line stays',
      owned,
    );
    t.equal(codexConfigOwned(owned, CODEX), owned, 'running it again changes nothing');
    t.includes(
      codexConfigOwned(old, { ...CODEX, windowsSandbox: 'unelevated' }),
      '[windows]\nsandbox = "unelevated"',
      'a Windows sandbox mode is written when asked for',
    );
    t.includes(
      codexConfigOwned('mcp_oauth_credentials_store = "keyring"\n', CODEX),
      'mcp_oauth_credentials_store = "keyring"',
      "a user's own mcp_oauth_credentials_store is kept",
    );
    t.equal(
      codexConfigOwned('', { ...CODEX, mcpLoginsInFile: false }),
      '',
      'an empty file stays empty when nothing is owned',
    );

    t.section('Anthropic key pattern');
    const body = 'a'.repeat(60);
    t.check(
      ANTHROPIC_KEY_PATTERN.test('sk-ant-usr01-' + body) && ANTHROPIC_KEY_PATTERN.test('sk-ant-api03-' + body),
      'sk-ant-api03- and sk-ant-usr01- keys are accepted',
    );
    t.check(
      !ANTHROPIC_KEY_PATTERN.test('sk-ant-usr1-x') && anthropicKeyProblem('sk-ant-usr1-x') !== null,
      'a short or malformed key is refused',
    );
    t.check(anthropicKeyProblem('sk-ant-usr01-' + body) === null, 'no problem for a user-workspace key');

    t.section('Claude environment catalogue');
    const names = CLAUDE_ENV.map((s) => s.name);
    t.check(new Set(names).size === names.length, 'names are unique');
    t.check(
      names.every((n) => /^[A-Z][A-Z0-9_]+$/.test(n)) && CLAUDE_ENV.every((s) => ENV_GROUPS.includes(s.group)),
      'names and groups are valid',
    );
    t.check(names.includes('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'), 'the subagent limit is there');

    t.section('Claude environment operations');
    const configPath = t.at('agent-env', 'config.json');
    t.write(configPath, '{}\n');
    const ctx = {
      packageRoot: t.dir('agent-env', 'package'),
      options: {},
      loaded: { config: structuredClone(DEFAULTS), configPath, base: t.temp },
      storageRoot: t.dir('agent-env', 'storage'),
      dataPath: t.dir('agent-env', 'storage', 'data', 'o'),
    } as unknown as AppContext;
    const io = fakeIO([]).io;
    const set = (name: string, value: string | null): Promise<unknown> =>
      runDefinition(agentsEnvSet.id, ctx, { agent: 'claude', name, value }, io);
    const read = async (): Promise<{ rows: { name: string; value: string | null; set: boolean }[] }> =>
      (await runDefinition(agentEnv.id, ctx, { agent: 'claude' }, io)) as never;
    await set('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', '40');
    let row = (await read()).rows.find((r) => r.name === 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS');
    t.check(row?.set === true && row.value === '40', 'a number is saved and read back');
    t.includes(
      fs.readFileSync(configPath, 'utf8'),
      '"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "40"',
      'it is in the settings file',
    );
    await t.throws(
      () => set('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', 'many'),
      'whole number',
      'a word is refused for a number',
    );
    await t.throws(() => set('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', '0'), 'Use a number', 'zero is refused');
    await set('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS', null);
    row = (await read()).rows.find((r) => r.name === 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS');
    t.check(row?.set === false, 'an empty value removes it');
    await t.throws(
      () => set('ANTHROPIC_API_KEY', 'sk-ant-usr1-x'),
      'API key',
      'the environment editor refuses a bad key',
    );
    const key = 'sk-ant-usr01-' + 'k'.repeat(60);
    await set('ANTHROPIC_API_KEY', key);
    const shown = JSON.stringify(await read());
    t.check(!shown.includes(key.slice(13)), 'a secret value is never returned');
    t.check((await read()).rows.find((r) => r.name === 'ANTHROPIC_API_KEY')?.set === true, 'but it says it is set');
    await t.throws(() => set('bad name', '1'), '', 'a bad variable name is refused');
  },
};
