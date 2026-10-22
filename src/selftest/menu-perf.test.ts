// The menu stays quick: no key or draw waits for a child process (tasklist is faked and counted), the first screen does
// not wait for the process list, a slow tab load shows "Loading…" instead of holding up the keys, a section seen before
// shows at once, a held key is drawn once, Esc is a key at once, an idle menu writes nothing, and the terminal writes
// only the rows that changed (the screen after the diffs is the same as a full draw, also after a resize). The process
// list is fetched only when it may have changed, and the settings file is read once for a whole list.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ConfigFile } from '../app/features/settings/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { sleep } from '../core/util/index.js';
import { Menu } from '../cli/menu/menu.js';
import { LiveStatus, listGap } from '../cli/menu/live.js';
import { ListPage, type Outcome } from '../cli/menu/pages/list-page.js';
import type { Context } from '../cli/commands/context.js';
import type { CliOptions } from '../cli/args.js';
import { App, Text, Terminal, type ListOptions, type Screen, type Size } from '../cli/tui/index.js';
import { ESCAPE_TIMEOUT_MS, supportsSyncUpdate } from '../cli/tui/terminal.js';
import {
  isSandboxRunning,
  readTasklist,
  sandboxPids,
  useTasklistCache,
  useTasklistRunners,
} from '../host/sandbox/index.js';
import { staleMountNote } from '../host/storage/index.js';
import type { Harness } from './support/harness.js';
import type { Suite } from './support/suite.js';

const TASKLIST = [
  '"System Idle Process","0","Services","0","8 K"',
  '"WindowsSandboxClient.exe","4242","Console","1","9,000 K"',
].join('\r\n');

const KEYS = { down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C', tab: '\t', ctrlC: '\x03' };

/** A terminal the test can type into and read: the keys go in as bytes, everything written is kept. */
class FakeTty {
  readonly stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (): void => undefined });
  readonly stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 30,
    write: (chunk: string): boolean => {
      this.writes.push(String(chunk));
      return true;
    },
  });
  readonly writes: string[] = [];

  terminal(): Terminal {
    return new Terminal(this.stdin as unknown as NodeJS.ReadStream, this.stdout as unknown as NodeJS.WriteStream);
  }
  type(bytes: string): void {
    this.stdin.write(bytes);
  }
}

/** What the screen shows after a stream of writes: rows set by "ESC[r;1H", wiped by "ESC[H ESC[2J". */
function replay(writes: readonly string[], height: number): string[] {
  const rows = Array.from({ length: height }, () => '');
  for (const write of writes) {
    const body = write.replace(/\x1b\[\?2026[hl]/g, '');
    if (body.startsWith('\x1b[?1049h')) continue;
    for (const part of body.split(/(?=\x1b\[(?:\d+;1H|H))/)) {
      const clear = /^\x1b\[H\x1b\[2J/.exec(part);
      if (clear) rows.fill('');
      const at = /^\x1b\[(\d+);1H([\s\S]*?)\x1b\[0m/.exec(part.slice(clear ? clear[0].length : 0));
      if (at) rows[Number(at[1]) - 1] = at[2];
    }
  }
  return rows;
}

function context(t: Harness): Context {
  const root = t.dir('menu-perf');
  return {
    packageRoot: t.packageRoot,
    entry: 'sandbox.js',
    options: {} as CliOptions,
    loaded: {
      config: structuredClone(DEFAULTS),
      configPath: null,
      base: root,
      layers: { machine: null, user: null },
    },
    storageRoot: root,
    dataPath: t.dir('menu-perf', 'data'),
  };
}

export const menuPerfSuite: Suite = {
  name: 'menu-perf',
  title: 'menu speed: no child process on a key or a draw, diff rendering, slow loads',
  run: async (t) => {
    t.section('the terminal writes only what changed');
    {
      const tty = new FakeTty();
      const term = tty.terminal();
      const height = term.height;
      const frame = (mark: string): string[] =>
        Array.from({ length: height }, (_, i) => 'row ' + i + (i === 7 ? mark : ''));
      term.start();
      tty.writes.length = 0;
      term.render(frame('a'));
      const first = tty.writes.join('');
      term.render(frame('a'));
      const unchanged = tty.writes.length;
      term.render(frame('b'));
      const diff = tty.writes.slice(1).join('');
      t.check(
        unchanged === 1 && diff.includes('row 7b') && !diff.includes('row 6') && diff.length < first.length / 5,
        'an identical frame writes nothing and a change writes only its rows, in one write',
        diff,
      );
      t.equal(
        replay(tty.writes, height).map((r) => r.trimEnd()),
        frame('b').map((r) => Text.fit(r, term.width - 1).trimEnd()),
        'the screen after the diffs equals a full draw',
      );
      tty.stdout.rows = height + 5;
      tty.stdout.emit('resize');
      tty.writes.length = 0;
      const bigger = Array.from({ length: height + 5 }, (_, i) => 'big ' + i);
      term.render(bigger);
      t.check(
        tty.writes.length === 1 && tty.writes[0].includes('\x1b[2J'),
        'a resize repaints everything in one write',
      );
      t.equal(
        replay(tty.writes, height + 5).map((r) => r.trimEnd()),
        bigger.map((r) => Text.fit(r, term.width - 1).trimEnd()),
        'the screen after a resize equals a full draw',
      );
      term.stop();
      t.check(
        supportsSyncUpdate({ WT_SESSION: 'x' }) &&
          !supportsSyncUpdate({}) &&
          !supportsSyncUpdate({ WT_SESSION: 'x', AGENT_SANDBOX_SYNC_UPDATE: '0' }) &&
          supportsSyncUpdate({ AGENT_SANDBOX_SYNC_UPDATE: '1' }),
        'synchronized updates are used where the terminal is known to take them, and can be forced on or off',
      );
    }

    t.section('a held key is drawn once');
    {
      const tty = new FakeTty();
      const app = new App(tty.terminal());
      let renders = 0;
      let handled = 0;
      const screen: Screen<string> = {
        render: (_size: Size) => {
          renders++;
          return { path: [], body: ['x'], keys: [] };
        },
        handle: (key) => {
          handled++;
          return key.text === 'q' ? { done: 'bye' } : undefined;
        },
      };
      // Thirty keys arrive together (a held arrow, a paste).
      tty.type(KEYS.down.repeat(30) + 'q');
      const result = await app.show(screen);
      app.close();
      t.check(
        result === 'bye' && handled === 31 && renders < 10,
        'keys that are already waiting are handled first and drawn once, not once each',
        'handled ' + handled + ', drawn ' + renders,
      );
    }

    t.section('Esc is a key at once');
    {
      const tty = new FakeTty();
      const term = tty.terminal();
      term.start();
      const times: number[] = [];
      for (let i = 0; i < 3; i++) {
        const at = Date.now();
        tty.type('\x1b');
        const key = await term.key();
        times.push(Date.now() - at);
        if (key.name !== 'escape') times.push(9999);
      }
      tty.type('\x1b[B');
      const arrow = await term.key();
      term.stop();
      t.check(
        Math.max(...times) < 250 && ESCAPE_TIMEOUT_MS <= 50,
        'Esc arrives in ' + times.join(', ') + ' ms (Node waits 500 ms for the rest of a sequence by default)',
        times.join(', '),
      );
      t.check(arrow.name === 'down', 'an arrow key is still one key, not Esc and letters');
    }

    t.section('a slow load does not hold up the keys');
    {
      const tty = new FakeTty();
      const app = new App(tty.terminal());
      class Slow extends ListPage<string> {
        readonly label = 'Slow';
        private rows: string[] = [];
        next = ['alpha', 'beta'];
        protected async load(): Promise<void> {
          await sleep(500);
          this.rows = this.next;
        }
        protected options(): ListOptions<string> {
          return { path: [], items: this.rows.map((r) => ({ value: r, label: r })) };
        }
        protected act(): Promise<Outcome<string>> {
          return Promise.resolve({});
        }
      }
      const page = new Slow(app);
      const started = Date.now();
      await page.open();
      const waited = Date.now() - started;
      const text = (): string => Text.strip(page.render({ width: 80, height: 14 }).body.join('\n'));
      t.check(
        waited < 400 && page.loading && text().includes('Loading'),
        'the tab opens at once and says Loading… while the data comes',
        'waited ' + waited + ' ms',
      );
      const arrived = await t.waitFor(() => (text().includes('beta') ? true : null), 5000, 20);
      t.check(arrived === true && !page.loading, 'the list is built when the data arrives');

      // Back on the section later: what it had shows at once, the fresh data replaces it when it is there.
      page.next = ['alpha', 'gamma'];
      const again = Date.now();
      await page.show();
      const shownIn = Date.now() - again;
      t.check(
        shownIn < 100 && text().includes('beta'),
        'a section seen before shows its last data at once (in ' + shownIn + ' ms), not Loading…',
        text(),
      );
      const fresh = await t.waitFor(() => (text().includes('gamma') ? true : null), 5000, 20);
      t.check(fresh === true && !text().includes('beta'), 'and its fresh data when it has loaded');
    }

    t.section('no child process on a key or a draw');
    const saved = { hostOnly: process.env.AGENT_SANDBOX_HOST_ONLY };
    process.env.AGENT_SANDBOX_HOST_ONLY = '1';
    const calls = { sync: 0, async: 0 };
    useTasklistRunners({
      sync: () => {
        calls.sync++;
        return TASKLIST;
      },
      async: async () => {
        calls.async++;
        // A busy PC: every look at the process list takes a second and a half.
        await sleep(1500);
        return TASKLIST;
      },
    });
    try {
      const tty = new FakeTty();
      const menu = new Menu(context(t), () => Promise.resolve(0), {
        terminal: tty.terminal(),
        fetchTasklist: async () => {
          calls.async++;
          await sleep(1500);
          return TASKLIST;
        },
        refreshMs: 100,
        // The sandbox's process is gone at every look: the list is fetched again on every tick.
        processAlive: () => false,
      });
      const startedAt = Date.now();
      const done = menu.start();
      const shown = await t.waitFor(() => tty.writes.length > 0, 20000, 5);
      const firstPaint = Date.now() - startedAt;
      t.check(shown === true, 'the menu draws its first screen');
      t.check(
        firstPaint < 1000,
        'the first screen does not wait for a 1.5 second process list (drawn after ' + firstPaint + ' ms)',
      );
      const slowest = { ms: 0, key: '' };
      const took: number[] = [];
      const press = async (name: string, bytes: string): Promise<void> => {
        const before = tty.writes.length;
        const at = Date.now();
        tty.type(bytes);
        // Not every key changes the screen: give the ones that do a chance, and measure those.
        await t.waitFor(() => tty.writes.length > before, 400, 2);
        const ms = Date.now() - at;
        if (tty.writes.length > before) took.push(ms);
        if (tty.writes.length > before && ms > slowest.ms) {
          slowest.ms = ms;
          slowest.key = name;
        }
        await sleep(15);
      };
      // The pages have their data (the first process list came after 1.5 s).
      await sleep(1700);
      const syncBefore = calls.sync;
      for (const section of ['2', '3', '4', '5', '6', '7', '1']) await press('section ' + section, section);
      for (const k of ['down', 'down', 'up', 'left', 'down', 'down', 'right', 'down', 'down', 'tab'] as const)
        await press(k, KEYS[k]);
      for (const section of ['5', '4', '2', '1']) await press('section ' + section, section);
      t.check(
        calls.sync === syncBefore,
        'no key or draw ran tasklist (' + (calls.sync - syncBefore) + ' calls in 21 keys and every draw)',
        String(calls.sync - syncBefore),
      );
      t.check(calls.async >= 2, 'the process list is refreshed in the background (' + calls.async + ' times)');
      t.check(
        slowest.ms < 1000,
        'with a 1.5 second tasklist, no key took a second to show its result (slowest: ' +
          slowest.key +
          ' ' +
          slowest.ms +
          ' ms)',
      );
      const median = [...took].sort((a, b) => a - b)[Math.floor(took.length / 2)] ?? 9999;
      t.check(median < 100, 'a key is usually drawn at once (median ' + median + ' ms over ' + took.length + ' keys)');

      // Left alone, the menu writes nothing: the process list keeps coming (every tick here), but nothing on the
      // screen changes, so nothing is drawn.
      await sleep(300);
      const idleFrom = tty.writes.length;
      const fetchesFrom = calls.async;
      await sleep(3000);
      const idleWrites = tty.writes.slice(idleFrom);
      const idleBytes = idleWrites.join('').length;
      t.check(
        idleWrites.length <= 1 && idleBytes < 4000 && calls.async > fetchesFrom,
        'an idle menu writes nothing for 3 s (' +
          idleWrites.length +
          ' writes, ' +
          idleBytes +
          ' bytes) while the process list is looked at in the background',
        Text.strip(idleWrites.join('')).slice(0, 300),
      );
      tty.type(KEYS.ctrlC);
      const code = await Promise.race([done, sleep(5000).then(() => -1)]);
      t.check(code === 130, 'Ctrl+C leaves the menu');
      const after = calls.sync;
      isSandboxRunning();
      t.check(calls.sync === after + 1, 'after the menu, "is the sandbox running?" runs tasklist again');
    } finally {
      useTasklistRunners();
      useTasklistCache(null);
      if (saved.hostOnly === undefined) delete process.env.AGENT_SANDBOX_HOST_ONLY;
      else process.env.AGENT_SANDBOX_HOST_ONLY = saved.hostOnly;
    }

    t.section('the status line');
    {
      let facts = 'a';
      let changes = 0;
      const live = new LiveStatus({
        fetch: () => Promise.resolve(facts),
        derive: () => 'status ' + facts,
        onChange: () => changes++,
        intervalMs: 20,
      });
      await live.start();
      t.equal([live.line(), changes], ['status a', 1], 'the first look sets the line');
      facts = 'b';
      const changed = await t.waitFor(() => live.line() === 'status b', 3000, 10);
      t.check(changed === true && changes === 2, 'a change is picked up in the background and announced');
      live.stop();
      facts = 'c';
      await sleep(80);
      t.check(live.line() === 'status b' && changes === 2, 'a stopped status looks at nothing');
    }

    t.section('the process list is fetched only when it may have changed');
    {
      t.equal(
        [0, 1, 2, 3, 4, 10, -1].map((n) => listGap(n, 2500, 30000)),
        [2500, 5000, 10000, 20000, 30000, 30000, 2500],
        'while nothing changes, the gap between two lists doubles up to the longest',
      );
      t.equal(
        sandboxPids(TASKLIST + '\r\n"WindowsSandbox.exe","77","Console","1","5 K"'),
        [4242, 77],
        'the ids of the sandbox programs are read from the list',
      );

      // A sandbox runs: its programs are checked by id, and the list is fetched again only when one has ended.
      let fetches = 0;
      let derived = 0;
      let alive = true;
      const running = new LiveStatus({
        fetch: () => {
          fetches++;
          return Promise.resolve(TASKLIST);
        },
        derive: () => String(++derived),
        onChange: () => undefined,
        intervalMs: 20,
        alive: () => alive,
        needsList: () => true,
      });
      await running.start();
      await sleep(400);
      t.check(
        fetches === 1 && derived > 5,
        'while the sandbox runs, its programs are checked by id: no new list (' +
          fetches +
          ' fetched), the line is still derived (' +
          derived +
          ' times)',
      );
      alive = false;
      const refetched = await t.waitFor(() => fetches > 1, 3000, 10);
      running.stop();
      t.check(refetched === true, 'when one of them has ended, the list is fetched again');

      // None runs: fewer and fewer lists, one at once after a key press or when the data folder changes.
      fetches = 0;
      let signal = 'a';
      const idle = new LiveStatus({
        fetch: () => {
          fetches++;
          return Promise.resolve('"System Idle Process","0","Services","0","8 K"');
        },
        derive: () => 'none',
        onChange: () => undefined,
        intervalMs: 20,
        idleMaxMs: 100000,
        needsList: () => true,
        signal: () => signal,
      });
      await idle.start();
      await sleep(1000);
      const quiet = fetches;
      t.check(
        quiet >= 2 && quiet <= 8,
        'with nothing running, a second of 20 ms ticks fetched the list ' + quiet + ' times (not 50)',
      );
      signal = 'b';
      const onSignal = await t.waitFor(() => fetches > quiet, 1000, 5);
      t.check(onSignal === true, 'a change in the data folder fetches the list at once');
      await sleep(100);
      const beforeKey = fetches;
      idle.touch();
      const onKey = await t.waitFor(() => fetches > beforeKey, 1000, 5);
      idle.stop();
      t.check(onKey === true, 'so does a key press (someone is looking)');

      // Inside a sandbox the list is never needed: nothing runs tasklist, not even a question asked meanwhile.
      fetches = 0;
      let syncRuns = 0;
      useTasklistRunners({
        sync: () => {
          syncRuns++;
          return '';
        },
        async: () => Promise.resolve(''),
      });
      try {
        const inside = new LiveStatus({
          fetch: () => {
            fetches++;
            return Promise.resolve('');
          },
          derive: () => 'inside',
          onChange: () => undefined,
          intervalMs: 20,
          needsList: () => false,
        });
        await inside.start();
        await sleep(200);
        const list = readTasklist();
        inside.stop();
        t.check(
          fetches === 0 && syncRuns === 0 && list === '',
          'when the list is not needed, it is never fetched and nothing asks tasklist meanwhile',
        );
      } finally {
        useTasklistRunners();
      }
    }

    t.section('nothing before the menu waits for tasklist');
    {
      let asked = 0;
      const note = staleMountNote(t.dir('no-mounts'), 'main', () => {
        asked++;
        return false;
      });
      t.check(note === null && asked === 0, 'with no image mounted, "is a sandbox running?" is not even asked');
    }

    t.section('the settings file is read once for a whole list');
    {
      const file = t.write(
        t.at('settings', 'config.json'),
        JSON.stringify({ defaultHarness: 'codex', workspaceFilter: { exclude: ['a', 'b'] } }),
      );
      const config = new ConfigFile('user', file);
      const reads = { count: 0 };
      const original = fs.readFileSync;
      const counting = ((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === file) reads.count++;
        return original(...args);
      }) as typeof fs.readFileSync;
      fs.readFileSync = counting;
      let first: unknown[];
      try {
        first = Array.from({ length: 200 }, () => config.valueInFile(['defaultHarness']));
      } finally {
        fs.readFileSync = original;
      }
      t.check(
        reads.count === 1 && first.every((v) => v === 'codex'),
        '200 values in one run read the file once (' + reads.count + ' reads)',
      );
      const exclude = ['workspaceFilter', 'exclude'];
      (config.valueInFile(exclude) as string[]).push('c');
      t.equal(config.valueInFile(exclude), ['a', 'b'], 'a value handed out is a copy (changing it changes nothing)');
      fs.writeFileSync(file, JSON.stringify({ defaultHarness: 'gemini' }));
      await Promise.resolve();
      t.equal(config.valueInFile(['defaultHarness']), 'gemini', 'the next run reads the file again (a change outside)');
      const result = config.set(['defaultHarness'], 'opencode');
      t.equal([result, config.valueInFile(['defaultHarness'])], ['saved', 'opencode'], 'a save is seen at once');
    }
  },
};
