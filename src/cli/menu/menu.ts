// The interactive menu (`sandbox` with no arguments): a full-screen app with seven sections down the left (Agents,
// Sessions, Sandbox, Apps, Settings, Accounts, Maintenance). The sections are real screens fed by the services; only
// what needs the terminal (attach, a start, a log) leaves the menu for a moment, one keypress from its screen.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config/index.js';
import { errMsg } from '../../core/util/index.js';
import { SandboxChannel } from '../../host/channel/index.js';
import { isSandboxRunning } from '../../host/sandbox/index.js';
import type { Context } from '../commands/context.js';
import { lookAtSandbox } from '../commands/shared-use.js';
import { commandLine } from '../history.js';
import { commandSpec } from '../manifest.js';
import { AgentCommandsService, LogsService } from '../services/index.js';
import { App, ExitRequested, Frame, Terminal, Text, Theme } from '../tui/index.js';
import { AccountsPage } from './pages/accounts-page.js';
import { AgentsPage } from './pages/agents-page.js';
import { AppsPage } from './pages/apps-page.js';
import { MaintenancePage } from './pages/maintenance-page.js';
import { SandboxPage } from './pages/sandbox-page.js';
import { SessionsPage } from './pages/sessions-page.js';
import { SettingsPage } from './pages/settings-page.js';
import { ConfigFile } from '../../app/features/settings/index.js';
import { Draft, type DraftResult } from './settings/draft.js';
import { LiveStatus } from './live.js';
import { readMenuView, saveMenuView } from './memory.js';
import { SECTION_LABELS, Shell, type MenuView } from './shell.js';

/** Where the menu was last left: it opens there again (also in a later run, from menu-state.json). */
let lastView: MenuView | undefined;

/** What a test may replace: the terminal, the process list fetch and how often it is fetched. */
export interface MenuOptions {
  readonly terminal?: Terminal;
  readonly fetchTasklist?: () => Promise<string>;
  readonly refreshMs?: number;
}

export class Menu {
  private readonly app: App;
  private readonly live: LiveStatus;

  constructor(
    private readonly ctx: Context,
    private readonly runArgv: (argv: string[]) => Promise<number>,
    options: MenuOptions = {},
  ) {
    this.app = new App(options.terminal ?? new Terminal());
    this.live = new LiveStatus({
      fetch: options.fetchTasklist,
      derive: () => this.status(),
      onChange: () => this.app.requestRedraw(),
      intervalMs: options.refreshMs,
    });
    this.app.status = () => this.live.line();
    this.app.afterAction = () => this.live.refresh();
    try {
      Frame.version =
        (JSON.parse(fs.readFileSync(path.join(ctx.packageRoot, 'package.json'), 'utf8')) as { version?: string })
          .version ?? '';
    } catch {
      /* no version shown */
    }
  }

  /** The status line from the facts now: only ever called by the background refresh, never by a draw or a key. */
  private status(): string {
    const folder = Theme.muted(Text.middle(process.cwd(), 70));
    if (!isSandboxRunning()) return Theme.muted(Theme.glyph.off + ' No sandbox running') + '   ' + folder;
    const view = lookAtSandbox(this.ctx);
    if (view.line)
      return (
        Theme.ok(Theme.glyph.on + ' ' + view.line) +
        Theme.muted(
          view.limited
            ? '. You can use it when they share it, or start your own after it stops.'
            : '. Its window is on their desktop; use its agents here.',
        )
      );
    const n = new SandboxChannel(this.ctx.dataPath).runningSessions().length;
    return (
      Theme.ok(Theme.glyph.on + ' Sandbox running') +
      Theme.muted(' · ' + n + ' session' + (n === 1 ? '' : 's')) +
      '   ' +
      folder
    );
  }

  /** The sections, in order. */
  private shell(): Shell {
    const files = {
      user: ConfigFile.user(this.ctx.loaded.configPath),
      project: ConfigFile.project(process.cwd()),
    };
    const draft = new Draft();
    const { app, ctx } = this;
    return new Shell(
      app,
      [
        new AgentsPage(app, ctx, files.user, draft),
        new SessionsPage(app, ctx),
        new SandboxPage(app, ctx),
        new AppsPage(app, ctx, files, draft),
        new SettingsPage(app, files, draft, ctx),
        new AccountsPage(app, ctx),
        new MaintenancePage(app, ctx),
      ],
      draft,
      (saved) => this.applyAgentCommands(saved),
    );
  }

  /** Runs the menu until you leave it, or until a command that takes over the terminal (attach) has run. */
  async start(): Promise<number> {
    if (!this.app.terminal.interactive) {
      console.log('The menu needs an interactive terminal. Run sandbox --help for the commands.');
      return 1;
    }
    try {
      const shell = this.shell();
      await this.live.start();
      await shell.restore(lastView ?? readMenuView(SECTION_LABELS) ?? { section: 0, screens: {} });
      for (;;) {
        const exit = await this.app.show(shell);
        lastView = shell.view();
        saveMenuView(lastView, SECTION_LABELS);
        if (exit.kind === 'quit') return 0;
        // A command (or a log) runs on its own facts, not on the menu's copy.
        this.live.stop();
        if (exit.kind === 'view') await this.view(exit.file);
        else {
          const code = await this.execute(exit.argv);
          if (code !== undefined) return code;
        }
        await this.live.start();
        await shell.reload();
      }
    } catch (e) {
      // Ctrl+C anywhere: leave quietly.
      if (e instanceof ExitRequested || (e instanceof Error && e.name === 'ExitPromptError')) return 130;
      throw e;
    } finally {
      this.live.stop();
      this.app.close();
    }
  }

  /** Runs an argv like typing it, on the normal screen; the menu comes back afterwards unless it attached. */
  private async execute(argv: string[]): Promise<number | undefined> {
    const code = await this.app.suspend(async () => {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + Theme.muted('$ ' + commandLine(argv)) + '\n\n');
      return this.runArgv(argv);
    });
    const attaches = argv[0] === 'attach' || argv[0] === 'host' || argv.includes('--terminal') || argv.includes('-t');
    if (commandSpec(argv[0])?.interactive && attaches) return code;
    await pressAnyKey(
      (code === 0 ? Theme.ok('Done.') : Theme.warn('Exit code ' + code + '.')) +
        Theme.muted(' Press any key for the menu…'),
    );
    return undefined;
  }

  /** Shows the end of a log on the normal screen. */
  private async view(file: string): Promise<void> {
    await this.app.suspend(async () => {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + Theme.muted('== ' + file + ' ==') + '\n\n');
      try {
        const chunk = new LogsService(this.ctx).read(file, 0);
        process.stdout.write(chunk ? chunk.text.split('\n').slice(-120).join('\n') : '(empty)');
      } catch (e) {
        process.stdout.write(Theme.error(errMsg(e)));
      }
      await pressAnyKey(Theme.muted('Press any key for the menu…'));
    });
  }

  /** After a save: agent commands (Beta) may have been switched, which changes this PC. */
  private applyAgentCommands(saved: DraftResult): string | undefined {
    if (!saved.files.some((f) => !f.isProject)) return undefined;
    try {
      const result = new AgentCommandsService(this.ctx).reconcile(
        loadConfig(this.ctx.loaded.configPath ?? undefined).config,
      );
      if (!result?.changed) return undefined;
      return result.on
        ? 'Agent commands (Beta) are on: open a new terminal.'
        : 'Agent commands are off: claude, codex ... run on this PC again (open a new terminal).';
    } catch (e) {
      return 'Agent commands (Beta): ' + errMsg(e);
    }
  }
}

/** Waits for one key on the normal screen, so a command's output stays until you have read it. Ctrl+C leaves. */
function pressAnyKey(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write('\n' + message);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (key: Buffer) => {
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (key[0] === 3) reject(new ExitRequested());
      else resolve();
    });
  });
}
