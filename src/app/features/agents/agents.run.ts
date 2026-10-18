// The agents feature's work: the list, starting an agent in a project of the running sandbox (the sharing rules as the
// web UI always applied them), and the agents in your settings (added, made default, removed). Talks only through io.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../../../core/config/index.js';
import { fail, safeText } from '../../../core/util/index.js';
import { SandboxChannel } from '../../../host/channel/index.js';
import { insideSandbox, isSandboxRunning } from '../../../host/sandbox/index.js';
import { ownerRule } from '../../../host/sharing/index.js';
import { hereDir } from '../../../cli/commands/projects/here.js';
import { lookAtSandbox } from '../../../cli/commands/shared-use.js';
import { runningProjects } from '../../../cli/services/web-service.js';
import { implement } from '../../context.js';
import { cancelled } from '../../kernel/index.js';
import { ConfigFile } from '../settings/settings-file.js';
import {
  addAgent,
  listAgents,
  makeDefaultAgent,
  removeAgent,
  startAgent,
  type AgentRow,
  type AgentsList,
} from './agents.def.js';
import {
  addedAgents,
  agentNameProblem,
  checkedAgent,
  commandFromPackage,
  newAgent,
  withAgent,
  withoutAgent,
  type AgentSource,
} from './agent-entry.js';

/** The longest a start waits for the agent to run (the first start installs it). */
const SESSION_START_MS = 15 * 60 * 1000;

/** Writes one setting; a value the config file would refuse is said with what is wrong. */
function save(file: ConfigFile, key: string[], value: unknown): void {
  const result = file.set(key, value);
  if (typeof result === 'object') fail('It could not be saved: ' + result.problems.join('; '));
}

/** Is this agent already in the sandbox's persistent storage (so starting it needs no install)? */
function installed(
  dataPath: string,
  name: string,
  harness: { hostExecutable?: string; npmBin?: string; uvBin?: string },
): boolean {
  const dir = path.join(dataPath, 'tools', 'agents', name);
  return [
    harness.hostExecutable,
    harness.npmBin && harness.npmBin + '.cmd',
    harness.uvBin && harness.uvBin + '.exe',
  ].some((f) => f && fs.existsSync(path.join(dir, f)));
}

export const listAgentsRun = implement(listAgents, async (ctx) => {
  const file = ConfigFile.user(ctx.loaded.configPath);
  const config = file.userConfig();
  const removable = addedAgents(Object.keys(config.harnesses));
  const agents: AgentRow[] = Object.entries(config.harnesses).map(([name, harness]) => ({
    name,
    ready: installed(ctx.dataPath, name, harness),
    isDefault: name === config.defaultHarness,
    removable: removable.includes(name),
  }));
  return { folder: hereDir(ctx), defaultAgent: config.defaultHarness, agents } satisfies AgentsList;
});

export const startAgentRun = implement(startAgent, async (ctx, input, io) => {
  if (insideSandbox() || !isSandboxRunning())
    fail('No Windows Sandbox is running.', 'Start one with sandbox claude, then try again.');
  const view = lookAtSandbox(ctx);
  if (view.owner && view.owner.kind !== 'none' && view.owner.kind !== 'mine') {
    const rule = ownerRule(view.owner, { kind: 'use' });
    if (rule.kind === 'refuse') fail(rule.reason, rule.fix);
  }
  const projects = runningProjects(view);
  const chosen =
    input.project ??
    (projects.length === 1
      ? projects[0].name
      : await io.choose({
          title: 'Which project?',
          choices: projects.map((p) => ({ value: p.name, label: p.name, description: p.guest })),
        }));
  if (chosen === undefined) cancelled();
  const project = projects.find((p) => p.name === chosen);
  if (!project) fail('The running sandbox has no project "' + chosen + '".');
  const harness = view.ctx.loaded.config.harnesses[input.agent];
  if (!harness) fail('There is no agent called "' + input.agent + '".');
  io.progress('Starting ' + input.agent + ' (the first time sets things up and can take a while)');
  const channel = new SandboxChannel(view.ctx.dataPath);
  const id = channel.requestSession(input.agent, [], project.guest, { harnessSpec: harness });
  const session = await channel.waitForSession(id, SESSION_START_MS, () => undefined);
  return {
    session: safeText(session.id),
    message: 'Started ' + input.agent + ' in ' + project.name + '.',
  };
});

export const addAgentRun = implement(addAgent, async (ctx, _input, io) => {
  const file = ConfigFile.user(ctx.loaded.configPath);
  const taken = Object.keys(file.userConfig().harnesses);
  const source = await io.choose({
    title: 'How does the agent get into the sandbox?',
    choices: [
      {
        value: 'npm',
        label: 'An npm package',
        description: 'Installed inside the sandbox with npm once and kept (e.g. @openai/codex).',
      },
      {
        value: 'uv',
        label: 'A Python package',
        description: 'Installed inside the sandbox with uv once and kept (e.g. aider-chat).',
      },
      {
        value: 'host',
        label: 'A program on this PC',
        description: 'An .exe copied from this PC into the sandbox (looked up on PATH and in ~/.local/bin).',
      },
    ],
  });
  if (source === undefined) cancelled();
  const kind = source as AgentSource;
  const name = await io.text({
    title: 'Name of the agent',
    lines: ['What you type after "sandbox", e.g. sandbox <name>. Letters, numbers, - and _.'],
    validate: (v) => agentNameProblem(v, taken),
  });
  if (name === undefined) cancelled();
  const agent = name.trim();
  if (kind === 'host') {
    const exe = await io.path({
      title: 'Choose the program (.exe)',
      lines: ['The agent program on this PC. It is copied into the sandbox. A bare file name is looked up on PATH.'],
      pathKind: 'file',
      validate: (v) => (v.trim() ? true : 'Choose a file.'),
    });
    if (exe === undefined) cancelled();
    const slash = Math.max(exe.lastIndexOf('\\'), exe.lastIndexOf('/'));
    const dir = slash > 0 ? exe.slice(0, slash) : 'auto';
    return saveAgent(file, agent, newAgent('host', exe.slice(slash + 1), '', dir));
  }
  const what = await io.text({
    title: kind === 'npm' ? 'npm package' : 'Python package',
    lines: [
      kind === 'npm'
        ? 'The package to install, optionally with a version: @scope/name or name@latest.'
        : 'The package for `uv tool install`.',
    ],
    validate: (v) => (v.trim() ? true : 'Type it.'),
  });
  if (what === undefined) cancelled();
  const command = await io.text({
    title: 'Command',
    lines: ['The command the package provides; it is what runs inside the sandbox.'],
    initial: commandFromPackage(what.trim()),
    validate: (v) => (/^[A-Za-z0-9._-]+$/.test(v.trim()) ? true : 'Letters, numbers, . - and _ only.'),
  });
  if (command === undefined) cancelled();
  return saveAgent(file, agent, newAgent(kind, what.trim(), command.trim()));
});

/** Checks the entry and writes it into your settings. */
function saveAgent(
  file: ConfigFile,
  name: string,
  harness: ReturnType<typeof newAgent>,
): { name: string; message: string } {
  const checked = checkedAgent(harness);
  if (typeof checked === 'string') fail('That agent is not valid: ' + checked);
  save(file, ['harnesses'], withAgent(file.valueInFile(['harnesses']), name, harness));
  return { name, message: 'Added ' + name + '.' };
}

/** The agent must be one of your settings' agents (built in or added). */
function knownAgent(file: ConfigFile, name: string): void {
  if (!(name in file.userConfig().harnesses)) fail('There is no agent called "' + name + '".');
}

export const makeDefaultAgentRun = implement(makeDefaultAgent, async (ctx, input) => {
  const file = ConfigFile.user(ctx.loaded.configPath);
  knownAgent(file, input.name);
  save(file, ['defaultHarness'], input.name);
  return { message: input.name + ' is the default agent.' };
});

export const removeAgentRun = implement(removeAgent, async (ctx, input, io) => {
  const name = input.name;
  if (name in DEFAULTS.harnesses) fail(name + ' is built in, so it cannot be removed.');
  const file = ConfigFile.user(ctx.loaded.configPath);
  knownAgent(file, name);
  if (file.userConfig().defaultHarness === name)
    fail(name + ' is the default agent.', 'Make another agent the default first.');
  const yes = await io.confirm({
    title: 'Remove ' + name + '?',
    lines: ['It is taken out of your settings. Its files in the sandbox stay until you clean them up.'],
    yes: 'Remove',
    danger: true,
    implied: true,
  });
  if (!yes) cancelled();
  const rest = withoutAgent(file.valueInFile(['harnesses']), name);
  // Nothing of your own left: the setting goes (the built-in agents need no line).
  save(file, ['harnesses'], Object.keys(rest).length ? rest : undefined);
  return { message: 'Removed ' + name + '.' };
});
