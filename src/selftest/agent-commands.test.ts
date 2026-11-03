// Agent commands: which agents get a forwarding command, what the files contain, and that "off" changes nothing.
// Everything happens in the test's temp folder with a made-up PATH; your real PATH is never read or written.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '../core/config/index.js';
import { agentCommands, commandsDir, realAgent } from '../host/agent-commands/index.js';
import { forwardingCmd, forwardingSh } from '../host/agent-commands/index.js';
import { forwardTarget, reconcileAgentCommands } from '../host/agent-commands/index.js';
import { agentCommandsSection } from '../app/features/agent-commands/agent-commands.def.js';
import { applyAgentCommandsChange } from '../app/features/settings/settings.run.js';
import type { AppContext } from '../app/context.js';
import { fakeIO } from '../app/kernel/index.js';
import { runDefinition } from '../app/registry.js';
import type { Suite } from './support/suite.js';

export const agentCommandsSuite: Suite = {
  name: 'agent-commands',
  title: 'agent commands: claude, codex ... forwarded into a hidden sandbox',
  run: async (t) => {
    const storage = t.at('agent-cmd-storage');
    const npmDir = t.at('agent-cmd-npm');
    const localBin = t.at('agent-cmd-local');
    t.write(path.join(npmDir, 'codex.cmd'), '@echo codex');
    t.write(path.join(npmDir, 'gemini.cmd'), '@echo gemini');
    t.write(path.join(localBin, 'claude.exe'), 'MZ');
    // A forwarding file of our own, first on PATH, must never count as the real agent.
    t.write(path.join(commandsDir(storage), 'claude.cmd'), '@rem windows-development-sandbox agent command');
    const PATH = [commandsDir(storage), npmDir, localBin].join(path.delimiter);
    const on = { ...DEFAULTS, agentCommands: { enabled: true, agents: 'auto' as const } };

    t.section('finding agents');
    t.check(
      realAgent('claude', commandsDir(storage), PATH) === path.join(localBin, 'claude.exe') &&
        realAgent('nope', commandsDir(storage), PATH) === null,
      "the real agent is found on PATH, skipping this tool's own forwarding files; one not installed is not found",
    );
    const commandsOf = (config: typeof DEFAULTS, searchPath: string): string[] =>
      agentCommands(config, storage, searchPath)
        .map((a) => a.command)
        .sort();
    t.equal(
      commandsOf(on, PATH),
      ['claude', 'codex', 'gemini'],
      '"auto": every agent installed on this PC gets a command, agents not installed none',
    );
    t.equal(
      commandsOf({ ...on, agentCommands: { enabled: true, agents: ['codex'] } }, PATH),
      ['codex'],
      'a list limits it to the named agents',
    );
    const unsafeDir = t.at('agent%cmd^dir');
    t.write(path.join(unsafeDir, 'aider.cmd'), '@echo');
    t.check(
      !agentCommands(on, storage, unsafeDir).some((a) => a.command === 'aider'),
      'an agent in a folder whose path has % or ^ (which cmd.exe would expand) is left alone',
    );

    t.section('the forwarding files');
    const claude = { harness: 'claude', command: 'claude', real: path.join(localBin, 'claude.exe') };
    const direct = { node: 'C:\\node\\node.exe', entry: 'C:\\tool\\dist\\bin\\sandbox.js' };
    const cmd = forwardingCmd(claude, direct);
    t.check(
      cmd.includes(
        '"C:\\node\\node.exe" "C:\\tool\\dist\\bin\\sandbox.js" launch --harness claude --headless --terminal -- %*',
      ) &&
        cmd.includes('if "%SANDBOX_AGENT_DIRECT%"=="1" goto direct') &&
        cmd.includes('call "' + claude.real + '" %*'),
      'the .cmd starts the agent in a hidden sandbox attached to this terminal, unless SANDBOX_AGENT_DIRECT=1 (real agent)',
    );
    t.check(
      cmd.includes('if not exist "C:\\node\\node.exe" goto direct') &&
        cmd.includes('if not exist "C:\\tool\\dist\\bin\\sandbox.js" goto direct') &&
        cmd.indexOf('if not exist') < cmd.indexOf('launch --harness'),
      'the .cmd runs the real agent when the tool was uninstalled or moved, instead of failing',
    );
    const managed = forwardTarget('C:\\tool\\versions\\1.0\\package', 'C:\\tool', 'C:\\node\\node.exe');
    const viaLauncher = forwardingCmd(claude, managed);
    t.check(
      managed.launcher === 'C:\\tool\\bin\\sandbox.cmd' &&
        forwardTarget('C:\\src\\repo', null, 'C:\\node\\node.exe').launcher === undefined &&
        viaLauncher.includes('call "C:\\tool\\bin\\sandbox.cmd" launch --harness claude --headless --terminal -- %*') &&
        !viaLauncher.includes('versions') &&
        forwardingSh(claude, managed).includes("[ -f '/c/tool/bin/sandbox' ] || exec "),
      'under a managed install the files call its launcher (it survives updates), else node and the entry file',
    );
    const sh = forwardingSh(
      { ...claude, real: "C:\\Users\\me\\it's\\claude.exe" },
      {
        node: 'C:\\node\\node.exe',
        entry: 'C:\\tool\\sandbox.js',
      },
    );
    t.check(
      sh.startsWith('#!/bin/sh') &&
        sh.includes(
          "exec '/c/node/node.exe' '/c/tool/sandbox.js' launch --harness claude --headless --terminal -- \"$@\"",
        ) &&
        sh.includes("'/c/Users/me/it'\\''s/claude.exe'"),
      'Git Bash gets a shell script with POSIX paths, quoted safely',
    );

    t.section('off changes nothing');
    // Off with nothing set up: nothing to do, no PATH edit (which would be refused during the self-test anyway).
    const fresh = t.at('agent-cmd-fresh');
    const target = { node: 'C:\\node\\node.exe', entry: 'C:\\tool\\sandbox.js' };
    const off = reconcileAgentCommands(DEFAULTS, fresh, target);
    t.equal(
      { on: off.on, changed: off.changed, wrote: fs.existsSync(commandsDir(fresh)) },
      { on: false, changed: false, wrote: false },
      'off (the default) writes nothing and leaves your PATH alone',
    );
    await t.throws(
      () => reconcileAgentCommands(on, t.at('agent-cmd-on'), target),
      /self-test|PATH/i,
      'turning it on edits your PATH, which the self-test refuses (it never changes this PC)',
    );

    t.section('every surface');
    await t.throws(
      () => runDefinition('agentCommands.on', {} as unknown as AppContext, {}, fakeIO().io),
      /self-test|PATH|inside the sandbox/i,
      'agentCommands.on refuses in the self-test (it would change this PC)',
    );
    const reconciled: unknown[] = [];
    const fakeService = { reconcile: (c: unknown): unknown => reconciled.push(c) };
    const ctx = { loaded: { configPath: undefined } } as unknown as AppContext;
    applyAgentCommandsChange(ctx, 'user', 'agentCommands.enabled', fakeService);
    applyAgentCommandsChange(ctx, 'user', 'defaultHarness', fakeService);
    applyAgentCommandsChange(ctx, 'project', 'agentCommands.enabled', fakeService);
    t.equal(reconciled.length, 1, 'changing agentCommands.* in your settings (any surface) brings this PC in line');
    const section = agentCommandsSection({
      enabled: false,
      dir: 'C:\\x',
      found: [{ command: 'claude', harness: 'claude', real: 'C:\\r\\claude.exe' }],
    });
    const toggle = section.items?.[0].primary;
    t.check(
      section.items?.map((i) => i.id).join() === 'agentCommands,agentCommand:claude' &&
        toggle?.kind === 'operation' &&
        toggle.op === 'agentCommands.on' &&
        !JSON.stringify(section).includes('sandbox agent-commands'),
      'the Agents page offers the switch as an action and lists each agent found, naming no command',
    );
  },
};
