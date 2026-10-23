// Live: the terminal path as you use it. An outer ptyhost stands in for Windows Terminal (it hosts the console, like
// Windows Terminal's own pseudo console) and runs the real viewer/attach client (runTerminalClient), which is attached
// to an inner ptyhost running a stand-in agent. The agent turns SGR mouse tracking on and echoes every byte it reads.
// Checks: clicks and the wheel reach the agent, Backspace stays Backspace, a split escape sequence arrives whole,
// 500 printed lines scroll through as lines (no alternate screen, no scrollback clear), a viewer that joins after
// a screen clear still gets mouse tracking, and drag and motion reports reach the agent only once it asked for them.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { encodeFrame, FrameType } from '../shared/pty/index.js';
import { SYSTEM } from '../shared/system.js';
import { CSC, openViewer, tail, WAIT, type Viewer } from './support/live.js';
import type { Suite } from './support/suite.js';

/**
 * The stand-in agent: VT input and SGR mouse tracking on, echoes what it reads ("got <1b>[<0;10;5M"). L prints 500
 * lines, K clears the screen, D turns drag reports on (1002), A every motion (1003), q quits.
 */
const AGENT_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
static class MouseAgent
{
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint m);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint m);
    [DllImport("kernel32.dll")] static extern bool ReadFile(IntPtr h, byte[] b, int n, out int read, IntPtr o);
    static void Say(string s) { Console.Out.Write(s); Console.Out.Flush(); }
    static int Main()
    {
        IntPtr input = GetStdHandle(-10), output = GetStdHandle(-11);
        uint mode;
        GetConsoleMode(output, out mode); SetConsoleMode(output, mode | 4);
        SetConsoleMode(input, 0x200);
        Say("\x1b[?1000h\x1b[?1006hAGENT-READY\r\n");
        var buffer = new byte[512];
        int n;
        while (ReadFile(input, buffer, buffer.Length, out n, IntPtr.Zero) && n > 0)
        {
            var text = new StringBuilder();
            for (int i = 0; i < n; i++) text.Append(buffer[i] < 32 || buffer[i] > 126 ? "<" + buffer[i].ToString("x2") + ">" : ((char)buffer[i]).ToString());
            string got = text.ToString();
            Say("got " + got + "\r\n");
            if (got == "L") { var lines = new StringBuilder(); for (int i = 1; i <= 500; i++) lines.Append("line " + i + "\r\n"); Say(lines.ToString() + "LINES-DONE\r\n"); }
            if (got == "K") Say("\x1b[2J\x1b[HCLEARED\r\n");
            if (got == "D") Say("\x1b[?1002hDRAG-ON\r\n");
            if (got == "A") Say("\x1b[?1003hMOVE-ON\r\n");
            if (got == "q") break;
        }
        // Exits with mouse tracking still on (like a crash): the client must turn it off.
        return 0;
    }
}
`;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

const compile = (source: string, exe: string): string => {
  const result = spawnSync(CSC, ['/nologo', '/optimize', '/target:exe', '/out:' + exe, source], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0
    ? ''
    : ((result.stdout ?? '') + (result.stderr ?? '')).trim().slice(0, 1500) || 'csc failed';
};

/**
 * conpty.dll as a sandbox has it (C:\AgentData\tools\conpty), when this machine has one; else only Windows' own is
 * tested.
 */
const conptyDll = (): string | null => {
  const dll = path.join(process.env.AGENT_DATA_DIR ?? 'C:\\AgentData', 'tools', 'conpty', 'conpty.dll');
  return fs.existsSync(dll) && fs.existsSync(path.join(path.dirname(dll), 'OpenConsole.exe')) ? dll : null;
};

export const liveTerminalSuite: Suite = {
  name: 'live-terminal',
  title: 'live: the viewer/attach client in a terminal (mouse clicks and wheel, keys, scrolling lines, late viewers)',
  live: true,
  timeoutMs: 300000,
  run: async (t) => {
    const ptyhost = t.at('ptyhost.exe');
    const agent = t.at('mouse-agent.exe');
    fs.writeFileSync(t.at('mouse-agent.cs'), AGENT_CS);
    const errors =
      compile(path.join(t.packageRoot, 'sandbox', 'csharp', 'PtyHost.cs'), ptyhost) ||
      compile(t.at('mouse-agent.cs'), agent);
    t.check(!errors, 'ptyhost and the stand-in agent compile', errors);
    if (errors) return;

    t.section('what a program leaves running ends with it (no leftover processes)');
    {
      // A copy of PING with a name of its own, started detached and hidden (its own console, so closing the pseudo
      // console does not end it), by a program that then exits.
      const probe = t.at('leftover-probe.exe');
      fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE'), probe);
      const starter =
        '"' +
        SYSTEM.powershell() +
        '" -NoProfile -Command "Start-Process -WindowStyle Hidden -FilePath \'' +
        probe +
        "' -ArgumentList '-n','120','127.0.0.1'; Start-Sleep -Seconds 5\"";
      const host = spawn(ptyhost, [String(await freePort()), 'tok', '80', '24', t.at('leftover.log'), starter], {
        env: { ...process.env, PTYHOST_BIND: 'loopback' },
        stdio: 'ignore',
        windowsHide: true,
      });
      const probeRunning = (): boolean =>
        spawnSync(SYSTEM.tasklist(), ['/FI', 'IMAGENAME eq leftover-probe.exe', '/NH'], { encoding: 'utf8' })
          .stdout.toLowerCase()
          .includes('leftover-probe.exe');
      await t.waitFor(probeRunning, WAIT.screen);
      t.check(probeRunning(), 'the program started a background process of its own');
      await t.waitFor(() => host.exitCode !== null, 30000);
      await t.waitFor(() => !probeRunning(), 5000);
      const log = fs.existsSync(t.at('leftover.log')) ? fs.readFileSync(t.at('leftover.log'), 'utf8') : '';
      t.check(
        !probeRunning() && /ended [1-9]\d* process\(es\) the program left running/.test(log),
        'when the program exits, the background process it left running is ended too',
        log.slice(-400),
      );
      if (probeRunning())
        spawnSync(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/F', '/IM', 'leftover-probe.exe'],
          {
            stdio: 'ignore',
          },
        );
    }

    t.section('a ptyhost ended from outside: what it recorded is ended, and nothing else');
    {
      // ptyhost records its program's process tree (PTYHOST_TREE_FILE); --end-tree ends it once ptyhost is gone,
      // checking every process by id and start time.
      const record = t.at('tree.json');
      const ping = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE');
      const holder = '"' + SYSTEM.cmd() + '" /c "' + ping + '" -n 120 127.0.0.1 >nul';
      const host = spawn(ptyhost, [String(await freePort()), 'tok', '80', '24', t.at('tree.log'), holder], {
        env: { ...process.env, PTYHOST_BIND: 'loopback', PTYHOST_TREE_FILE: record },
        stdio: 'ignore',
        windowsHide: true,
      });
      interface TreeRecord {
        ptyhost: { pid: number; start: string };
        processes: { pid: number; start: string }[];
      }
      const read = (file: string): TreeRecord | null => {
        try {
          return JSON.parse(fs.readFileSync(file, 'utf8')) as TreeRecord;
        } catch {
          return null;
        }
      };
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // The program (cmd) and the PING it started, once ptyhost has followed the tree (every 3 s).
      const recorded = await t.waitFor(() => {
        const r = read(record);
        return r && r.ptyhost.pid === host.pid && r.processes.length >= 2 ? r : null;
      }, WAIT.screen);
      t.check(recorded !== null, 'ptyhost records its program and what it started', JSON.stringify(read(record)));
      if (recorded) {
        const endTree = (file: string): { status: number | null; stdout: string } => {
          const r = spawnSync(ptyhost, ['--end-tree', file], { encoding: 'utf8', windowsHide: true });
          return { status: r.status, stdout: (r.stdout ?? '').trim() };
        };
        const copy = t.at('tree-copy.json');
        fs.writeFileSync(copy, JSON.stringify(recorded));
        const whileRunning = endTree(copy);
        // The same ids with other start times: what a reused id looks like.
        const forged = t.at('tree-forged.json');
        fs.writeFileSync(
          forged,
          JSON.stringify({
            ptyhost: { pid: recorded.ptyhost.pid, start: '1' },
            processes: recorded.processes.map((p) => ({ pid: p.pid, start: String(BigInt(p.start) + 1n) })),
          }),
        );
        const reused = endTree(forged);
        t.check(
          whileRunning.status === 3 &&
            reused.status === 0 &&
            reused.stdout === 'ended 0 process(es)' &&
            recorded.processes.every((p) => alive(p.pid)),
          'nothing is ended while the ptyhost that recorded it runs, nor a process whose id was reused (start time)',
          JSON.stringify({ whileRunning, reused }),
        );
        host.kill();
        await t.waitFor(() => host.exitCode !== null, 10000);
        const left = fs.existsSync(record);
        const ended = endTree(record);
        await t.waitFor(() => recorded.processes.every((p) => !alive(p.pid)), 10000);
        t.check(
          left && ended.status === 0 && recorded.processes.every((p) => !alive(p.pid)),
          'a ptyhost ended from outside leaves its record, and --end-tree ends the processes in it',
          JSON.stringify({ left, ended, alive: recorded.processes.filter((p) => alive(p.pid)) }),
        );
      }
      try {
        if (host.exitCode === null) host.kill();
      } catch {
        /* it ended between the check and the kill: nothing left to stop */
      }
    }

    t.section("the agents' job: a last-resort backstop, set once");
    {
      // A job of the test's own (PTYHOST_JOB_NAME), never the agents' real one.
      const jobName = 'Local\\AgentSandboxAgentsJobTest' + process.pid + '-' + Date.now();
      const ping = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE');
      const holder = '"' + SYSTEM.cmd() + '" /c "' + ping + '" -n 6 127.0.0.1 >nul';
      const startHost = async (backstop: string, log: string): Promise<ChildProcess> =>
        spawn(ptyhost, [String(await freePort()), 'tok', '80', '24', t.at(log), holder], {
          env: { ...process.env, PTYHOST_BIND: 'loopback', PTYHOST_BACKSTOP_MB: backstop, PTYHOST_JOB_NAME: jobName },
          stdio: 'ignore',
          windowsHide: true,
        });
      const read = (log: string): string => (fs.existsSync(t.at(log)) ? fs.readFileSync(t.at(log), 'utf8') : '');
      const first = await startHost('auto', 'job-first.log');
      await t.waitFor(() => read('job-first.log').includes('agent job:'), WAIT.screen);
      const second = await startHost('500000', 'job-second.log');
      await t.waitFor(() => read('job-second.log').includes('agent job:'), WAIT.screen);

      // The governor's hands on the same test job (MEMGOV_JOB_NAME): it sees the job's processes, and the dial's
      // commands (memory priority, the throttle job and its CPU cap, trimming) leave them running.
      const memgovExe = t.at('memgov.exe');
      const memgovErrors = compile(path.join(t.packageRoot, 'sandbox', 'csharp', 'MemGov.cs'), memgovExe);
      t.check(!memgovErrors, 'memgov compiles', memgovErrors);
      if (!memgovErrors) {
        const memgov = spawn(memgovExe, ['serve', '--interval', '1'], {
          env: { ...process.env, MEMGOV_JOB_NAME: jobName },
          stdio: ['pipe', 'pipe', 'ignore'],
          windowsHide: true,
        });
        let lines = '';
        memgov.stdout.on('data', (chunk: Buffer) => (lines += chunk.toString('utf8')));
        const procsSeen = (): { pid: number; name: string }[] => {
          const last = lines.trim().split(/\r?\n/).pop() ?? '';
          try {
            return (JSON.parse(last) as { procs: { pid: number; name: string }[] }).procs;
          } catch {
            return [];
          }
        };
        await t.waitFor(() => procsSeen().length > 0, WAIT.screen);
        const target = procsSeen().find((p) => /ping|cmd/i.test(p.name));
        t.check(target !== undefined, "memgov sees the processes in the agents' job", lines.slice(-300));
        if (target) {
          for (const command of [
            'memprio ' + target.pid + ' low',
            'throttle ' + target.pid,
            'cpurate 20',
            'trim ' + target.pid,
          ])
            memgov.stdin.write(command + '\n');
          await new Promise((r) => setTimeout(r, 1500));
          memgov.stdin.write('cpurate 100\n');
          await new Promise((r) => setTimeout(r, 1200));
          t.check(
            memgov.exitCode === null && procsSeen().some((p) => p.pid === target.pid),
            'memory priority, the throttle job, a CPU cap and trimming leave the process running (and memgov too)',
          );
        }
        memgov.stdin.end();
        await t.waitFor(() => memgov.exitCode !== null, 5000);
        t.check(memgov.exitCode === 0, 'memgov ends cleanly when the daemon goes away (and lifts the cap)');
      }

      for (const c of [first, second]) {
        try {
          if (c.exitCode === null) c.kill();
        } catch {
          /* it ended between the check and the kill: nothing left to stop */
        }
      }
      const set = /backstop at (\d+) MB committed \(the sandbox's commit limit is (\d+) MB\)/.exec(
        read('job-first.log'),
      );
      const commit = Number(set?.[2] ?? 0);
      t.check(
        set !== null &&
          Number(set[1]) === Math.max(Math.floor(commit / 2), commit - Math.max(1536, Math.floor((commit * 3) / 100))),
        'the ptyhost that creates the job sets the backstop just below the commit limit (auto: 3 %, at least 1.5 GB)',
        read('job-first.log'),
      );
      t.check(
        read('job-second.log').includes('joined the existing one'),
        'a ptyhost that joins the job never changes its backstop',
        read('job-second.log'),
      );
    }
    const client = t.at('client.mjs');
    fs.writeFileSync(
      client,
      [
        'import { connect, runTerminalClient } from ' +
          JSON.stringify(pathToFileURL(path.join(t.packageRoot, 'dist', 'shared', 'pty', 'index.js')).href) +
          ';',
        'const socket = await connect({ addresses: ["127.0.0.1"], port: Number(process.argv[2]), token: "tok" });',
        'const result = await runTerminalClient(socket, "tok");',
        'console.log("CLIENT-DONE " + result.reason);',
      ].join('\n'),
    );

    const dll = conptyDll();
    const kinds: (string | null)[] = dll ? [dll, null] : [null];
    if (!dll) t.skip("conpty.dll not found on this machine: only Windows' own pseudo console is tested");
    for (const kind of kinds) {
      const label = kind ? 'conpty.dll' : "Windows' pseudo console";
      t.section('live terminal (' + label + ')');
      const children: ChildProcess[] = [];
      const viewers: Viewer[] = [];
      const start = (port: number, command: string, log: string): void => {
        const env: NodeJS.ProcessEnv = { ...process.env, PTYHOST_BIND: 'loopback' };
        delete env.PTYHOST_CONPTY;
        if (kind) env.PTYHOST_CONPTY = kind;
        children.push(
          spawn(ptyhost, [String(port), 'tok', '100', '30', t.at(log), command], {
            env,
            stdio: 'ignore',
            windowsHide: true,
          }),
        );
      };
      try {
        const innerPort = await freePort();
        start(innerPort, '"' + agent + '"', 'inner-' + kinds.indexOf(kind) + '.log');
        const outerPort = await freePort();
        start(
          outerPort,
          '"' + process.execPath + '" "' + client + '" ' + innerPort,
          'outer-' + kinds.indexOf(kind) + '.log',
        );
        // The terminal: what it shows is what the client wrote; what it types goes to the client's console.
        const terminal = await openViewer({ addresses: ['127.0.0.1'], port: outerPort, token: 'tok' });
        viewers.push(terminal);
        const screen = (): string => terminal.output();
        const send = (text: string): void => {
          terminal.socket.write(encodeFrame(FrameType.Input, Buffer.from(text, 'latin1')));
        };
        const ready = await t.waitFor(() => screen().includes('AGENT-READY'), WAIT.screen);
        t.check(Boolean(ready), 'the client shows the agent', 'screen: ' + tail(screen()));
        if (!ready) continue;

        // The client switches its console to pass the terminal's input through as it is; until then clicks are lost.
        const click = '\x1b[<0;10;5M\x1b[<0;10;5m';
        const clicked = await t.waitFor(
          () => {
            if (!screen().includes('got <1b>[<0;10;5M')) send(click);
            return screen().includes('got <1b>[<0;10;5M');
          },
          WAIT.screen,
          1000,
        );
        t.check(
          Boolean(clicked),
          'a mouse click in the terminal reaches the agent (SGR mouse report)',
          'screen: ' + tail(screen(), 800),
        );
        const mark = screen().length;
        const after = (): string => screen().slice(mark);
        const lost: string[] = [];
        const expectKey = async (what: string, expected: string): Promise<void> => {
          if (!(await t.waitFor(() => after().includes(expected), WAIT.screen))) lost.push(what);
        };
        send('\x1b[<64;10;5M');
        await expectKey('mouse wheel', 'got <1b>[<64;10;5M');
        send('\x7f');
        await expectKey('Backspace as DEL', 'got <7f>');
        send('\x08');
        await expectKey('Ctrl+Backspace as ^H', 'got <08>');
        send('\x1b[');
        await new Promise((r) => setTimeout(r, 5));
        send('C');
        await expectKey('Right arrow sent in two pieces', 'got <1b>[C');
        t.check(
          lost.length === 0,
          'the mouse wheel, Backspace (DEL), Ctrl+Backspace (^H) and a Right arrow split in two pieces (no stray "C") reach the agent',
          'lost: ' + lost.join(', ') + '\nscreen: ' + tail(after(), 800),
        );

        const before = screen().length;
        send('L');
        const done = await t.waitFor(() => screen().includes('LINES-DONE'), WAIT.screen);
        const printed = screen().slice(before);
        const seen = new Set([...printed.matchAll(/line (\d+)\b/g)].map((m) => Number(m[1])));
        const missing = Array.from({ length: 500 }, (_, i) => i + 1)
          .filter((n) => !seen.has(n))
          .map((n) => 'line ' + n);
        t.check(
          Boolean(done) && missing.length === 0,
          'all 500 printed lines reach the terminal as lines',
          'missing: ' + missing.slice(0, 10).join(', ') + '\n' + tail(printed),
        );
        // (The client clears the tab once when it starts; from then on nothing may take the scrollback away.)
        const session = screen().slice(screen().indexOf('AGENT-READY'));
        const sent = ['\x1b[?1049h', '\x1b[?47h', '\x1b[?1047h', '\x1b[3J'].filter((s) => session.includes(s));
        t.check(
          sent.length === 0,
          'the terminal is never sent an alternate screen (1049, 47, 1047) or a clear of its scrollback',
          'sent: ' + JSON.stringify(sent),
        );

        if (kind) {
          // A viewer that joins after the agent cleared its screen: the replay starts at the clear, the modes come
          // first.
          send('K');
          await t.waitFor(() => screen().includes('CLEARED'), WAIT.screen);
          const late = await openViewer({ addresses: ['127.0.0.1'], port: innerPort, token: 'tok' });
          viewers.push(late);
          await t.waitFor(() => late.output().includes('CLEARED'), WAIT.screen);
          const head = late.output().slice(0, late.output().indexOf('CLEARED'));
          t.check(
            head.includes('\x1b[?1000h') && head.includes('\x1b[?1006h'),
            "a viewer joining after a screen clear gets the agent's mouse tracking before the replay",
            'late viewer: ' + JSON.stringify(late.output().slice(0, 300)),
          );
          late.close();
        }

        if (kind) {
          // Raw mouse input (passed through, the client sees the agent's modes): a drag and a move are dropped while
          // the agent tracks clicks only (1000), the drag passes with 1002, every move with 1003.
          const drag = '\x1b[<32;11;5M';
          const move = '\x1b[<35;12;6M';
          const round = async (setup: string, ready: string, marker: string): Promise<string> => {
            if (setup) {
              send(setup);
              await t.waitFor(() => screen().includes(ready), WAIT.screen);
            }
            const from = screen().length;
            send(drag);
            await new Promise((r) => setTimeout(r, 50));
            send(move);
            await new Promise((r) => setTimeout(r, 50));
            send(marker);
            await t.waitFor(
              () =>
                screen()
                  .slice(from)
                  .includes('got ' + marker),
              WAIT.screen,
            );
            return screen().slice(from);
          };
          const clicksOnly = await round('', '', 'y');
          const drags = await round('D', 'DRAG-ON', 'z');
          const moves = await round('A', 'MOVE-ON', 'w');
          // (Two reports read at once are echoed on one line.)
          const has = (text: string, report: string): boolean => text.includes('<1b>' + report.slice(1));
          t.check(
            clicksOnly.includes('got y') &&
              !has(clicksOnly, drag) &&
              !has(clicksOnly, move) &&
              drags.includes('got z') &&
              has(drags, drag) &&
              !has(drags, move) &&
              has(moves, drag) &&
              has(moves, move),
            'drag and motion reports reach the agent only once it asked for them (1002 drags, 1003 every move)',
            JSON.stringify({ clicksOnly: tail(clicksOnly, 200), drags: tail(drags, 200), moves: tail(moves, 200) }),
          );
        }

        send('q');
        const ended = await t.waitFor(() => screen().includes('CLIENT-DONE'), WAIT.exit);
        const last = screen().slice(screen().lastIndexOf('got q'));
        t.check(
          Boolean(ended) && (!kind || (last.includes('\x1b[?1000l') && last.includes('\x1b[?1003l'))),
          'the client ends with the agent' +
            (kind ? ' and turns mouse tracking (clicks, drags, motion) off in the terminal again' : ''),
          'screen: ' + tail(screen()),
        );
      } finally {
        for (const v of viewers) v.close();
        for (const c of children) {
          try {
            if (c.exitCode === null) c.kill();
          } catch {
            /* it exited between the check and the kill (Windows says EPERM): nothing left to stop */
          }
        }
      }
    }
  },
};
