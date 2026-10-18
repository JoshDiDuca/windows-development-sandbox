import path from 'node:path';
import { buildProgram, parseCli } from './args.js';
import { COMMANDS, commandSpec } from './manifest.js';
import { recordHistory } from './history.js';
import { menu } from './menu/index.js';
import { closest, validateOptions } from './validate.js';
import { loadConfig } from '../core/config/index.js';
import * as commands from './commands/index.js';
import { fail } from '../core/util/index.js';
import { PACKAGE_ROOT, packageVersion } from '../core/package-info.js';
import { takeHiddenInstallNotice } from '../host/install/index.js';
import { c } from './output/index.js';
import { dropInheritedModulePath } from '../shared/system.js';
import { withConfig, hoistConfig, withoutConfig } from './argv.js';
import { report } from './report.js';
import { versionText } from './version.js';
import { HANDLERS } from './commands/index.js';
import { definitionHandler, operationHandler } from './operations/index.js';
import { runUpdate } from '../app/features/updates/index.js';

const entry = path.join(PACKAGE_ROOT, 'dist', 'bin', 'agent-sandbox.js');

export interface Preset {
  harness?: string;
  command?: string;
}

/** A first word that is no command and no agent, but close to one: "Did you mean: sandbox status?". */
function failOnTypo(word: string, agents: readonly string[]): void {
  const names = [...COMMANDS.filter((c) => !c.hidden).map((c) => c.name), ...agents];
  const hint = closest(word, names);
  if (hint)
    fail(
      'Unknown command "' + word + '". Did you mean: sandbox ' + hint + '?',
      'Run sandbox --help for the list of commands, or sandbox for the menu.',
    );
}

/** One yellow line, once per version, when this is not the managed install but one exists (it is hidden). */
function hiddenInstallNotice(storageRoot: string): void {
  try {
    const line = takeHiddenInstallNotice(storageRoot, PACKAGE_ROOT, packageVersion());
    if (line) console.log(c.yellow(line));
  } catch {
    // A note that cannot be saved is not worth stopping a start for.
  }
}

/** Runs an argv from the menu exactly as if it had been typed, reporting errors instead of throwing. */
const runFromMenu =
  (config: string | undefined) =>
  (argv: string[]): Promise<number> =>
    main(withConfig(argv, config)).catch((e: unknown) => report(e));

/**
 * CLI entry. `preset` lets wrapper binaries fix the command/agent (sandbox claude = launch --harness claude). No
 * arguments opens the menu; `sandbox <agent> [agent args]` starts that agent.
 */
export async function main(rawArgv: string[], preset: Preset = {}): Promise<number> {
  const argv = preset.command || preset.harness ? rawArgv : hoistConfig(rawArgv);
  const isAgent = (name: string | undefined): name is string => {
    if (!name || name.startsWith('-') || commandSpec(name)) return false;
    const at = argv.indexOf('--config');
    try {
      return Boolean(loadConfig(at >= 0 ? argv[at + 1] : undefined).config.harnesses[name]);
    } catch {
      return false;
    }
  };
  if (!preset.command && !preset.harness) {
    const version = versionText(withoutConfig(argv), PACKAGE_ROOT);
    if (version !== null) {
      console.log(version);
      return 0;
    }
    if (argv.length === 0)
      return process.stdin.isTTY ? main(['menu']) : (buildProgram(() => undefined).outputHelp(), 0);
    if (isAgent(argv[0])) return main(argv.slice(1), { harness: argv[0] });
    const first = argv.slice(0, 1)[0] as string | undefined;
    if (first && !first.startsWith('-') && !commandSpec(first) && first !== 'help') {
      const at = argv.indexOf('--config');
      let agents: string[] = [];
      try {
        agents = Object.keys(loadConfig(at >= 0 ? argv[at + 1] : undefined).config.harnesses);
      } catch {
        // A broken settings file: the commands alone are suggested.
      }
      failOnTypo(first, agents);
    }
  }
  const options = parseCli(preset.command ? [preset.command, ...argv] : argv, Boolean(preset.harness));
  if (preset.harness) options.harness = preset.harness;
  const typed = preset.harness
    ? ['launch', '--harness', preset.harness, ...argv]
    : preset.command
      ? [preset.command, ...argv]
      : argv;
  if (options.command === 'menu') {
    const menuCtx = commands.createContext(PACKAGE_ROOT, entry, options);
    hiddenInstallNotice(menuCtx.storageRoot);
    await commands.migrateBeforeCommand(menuCtx, options.command);
    commands.updatesBeforeCommand(entry, options.command);
    await commands.storageBeforeCommand(menuCtx, options.command);
    return menu(menuCtx, runFromMenu(options.config));
  }
  // Loaded only when asked for: normal commands never load test code.
  if (options.command === 'self-test')
    return (await import('../selftest/index.js')).selfTest(PACKAGE_ROOT, options.positionals);
  // repair must run even when the config file is broken (createContext would refuse it).
  if (options.command === 'repair') {
    recordHistory(withoutConfig(typed));
    return commands.repairCommand(PACKAGE_ROOT, entry, options);
  }
  // update works on the install, not on a sandbox: it needs no settings (and a broken file must not stop it).
  if (options.command === 'update')
    return (await definitionHandler(runUpdate)(commands.contextOrDefaults(PACKAGE_ROOT, entry, options))) ?? 0;
  const handler = operationHandler(options.command, options.positionals) ?? HANDLERS[options.command];
  if (!handler)
    return fail(
      'Unknown command "' + options.command + '".',
      'Run sandbox --help for the list of commands, or sandbox for the menu.',
    );
  const ctx = commands.createContext(PACKAGE_ROOT, entry, options);
  validateOptions(ctx);
  if (options.command === 'launch') hiddenInstallNotice(ctx.storageRoot);
  await commands.migrateBeforeCommand(ctx, options.command);
  commands.updatesBeforeCommand(entry, options.command);
  await commands.storageBeforeCommand(ctx, options.command);
  // Only what parsed and validated is offered again by the menu, without the --config (it is the same every time).
  recordHistory(withoutConfig(typed));
  return (await handler(ctx)) ?? 0;
}

export function run(argv: string[], preset?: Preset): void {
  dropInheritedModulePath();
  main(argv, preset).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.exitCode = report(e);
    },
  );
}
