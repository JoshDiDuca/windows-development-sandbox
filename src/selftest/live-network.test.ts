// Live: the sandbox's allowOnly proxy (the real bundled runtime\netproxy.js) and the PC-side port forwarder, on
// loopback only; and that the cargo shim compiles with the compiler that ships with Windows.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startPortForwards } from '../host/network/index.js';
import { PROXY_PORT, relayPort } from '../shared/network/index.js';
import { CSC } from './support/live.js';
import type { Suite } from './support/suite.js';

/** A TCP server that answers every line with "echo:<line>". */
const echoServer = (port = 0): Promise<net.Server> =>
  new Promise((resolve) => {
    const server = net.createServer((s) => s.on('data', (d) => s.write('echo:' + d.toString())));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const portOf = (server: net.Server): number => (server.address() as net.AddressInfo).port;

/** Sends `text` after `preamble` (a CONNECT) and resolves with everything received within a short while. */
const talk = (port: number, preamble: string, text: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let got = '';
    socket.on('data', (d) => {
      got += d.toString();
      if (preamble && got.includes('\r\n\r\n') && got.startsWith('HTTP/1.1 200') && !got.includes('echo:'))
        socket.write(text);
    });
    socket.on('error', () => resolve(got));
    socket.on('connect', () => socket.write(preamble || text));
    setTimeout(() => {
      socket.destroy();
      resolve(got);
    }, 1500);
  });

export const liveNetworkSuite: Suite = {
  name: 'live-network',
  title: 'live: allowOnly proxy, port forwarding, cargo shim',
  live: true,
  run: async (t, f) => {
    t.section('allowOnly proxy');
    const gen = await f.launch(
      {},
      { config: { ...f.baseConfig, network: { ...f.baseConfig.network, allowOnly: ['localhost'] } } },
    );
    const echo = await echoServer();
    const proxy = spawn(process.execPath, [path.join(gen.launchPath, 'runtime', 'netproxy.js')], {
      env: { ...process.env, AGENT_LAUNCH_DIR: gen.launchPath, AGENT_DATA_DIR: t.dir('netproxy-data') },
      stdio: 'ignore',
    });
    try {
      const up = await t.waitFor(
        () =>
          new Promise<boolean>((resolve) => {
            const s = net.connect(PROXY_PORT, '127.0.0.1', () => {
              s.destroy();
              resolve(true);
            });
            s.on('error', () => resolve(false));
          }),
        10000,
        200,
      );
      t.check(Boolean(up), 'the proxy listens on localhost');
      const allowed = await talk(
        PROXY_PORT,
        'CONNECT localhost:' + portOf(echo) + ' HTTP/1.1\r\nHost: localhost\r\n\r\n',
        'hi',
      );
      t.check(
        allowed.startsWith('HTTP/1.1 200') && allowed.includes('echo:hi'),
        'an allowed host is tunnelled through',
        allowed,
      );
      const blocked = await talk(PROXY_PORT, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n', '');
      t.check(blocked.startsWith('HTTP/1.1 403'), 'any other host is refused (403)', blocked);
    } finally {
      proxy.kill();
      echo.close();
    }

    t.section('port forwarding');
    const relay = await echoServer(relayPort(0));
    const free = await echoServer();
    const pcPort = portOf(free);
    free.close();
    await new Promise((r) => setTimeout(r, 200));
    const stop = startPortForwards([{ pc: pcPort, sandbox: 3000 }], () => '127.0.0.1');
    await new Promise((r) => setTimeout(r, 300));
    const forwarded = await talk(pcPort, '', 'ping');
    stop();
    relay.close();
    t.equal(forwarded, 'echo:ping', "localhost:<pc> on this PC reaches the sandbox's relay");

    t.section('cargo shim');
    const out = path.join(t.dir('cargoshim'), 'cargo.exe');
    const compiled = spawnSync(
      CSC,
      ['/nologo', '/optimize', '/out:' + out, path.join(gen.launchPath, 'sandbox', 'csharp', 'CargoShim.cs')],
      { encoding: 'utf8' },
    );
    t.check(
      compiled.status === 0,
      'CargoShim.cs compiles with the .NET Framework compiler (C# 5)',
      compiled.stdout + compiled.stderr,
    );

    t.section('SandboxTools and HostTools');
    const csharp = (...parts: string[]): string[] => {
      const dir = path.join(...parts);
      return fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.cs'))
        .map((n) => path.join(dir, n));
    };
    const sandboxTools = path.join(t.dir('sandbox-tools'), 'SandboxTools.exe');
    const builtTools = spawnSync(
      CSC,
      [
        '/nologo',
        '/optimize',
        '/target:winexe',
        '/out:' + sandboxTools,
        ...csharp(gen.launchPath, 'sandbox', 'csharp', 'SandboxTools'),
      ],
      { encoding: 'utf8' },
    );
    t.check(builtTools.status === 0, 'SandboxTools compiles (C# 5)', builtTools.stdout + builtTools.stderr);
    const memoryDir = t.dir('memory-log');
    spawnSync(sandboxTools, ['memory-log', '--once', '--dir', memoryDir], { timeout: 60000 });
    const logs = fs.readdirSync(memoryDir).filter((n) => /^memory-\d{8}-\d{6}\.log$/.test(n));
    const lines = logs.length ? fs.readFileSync(path.join(memoryDir, logs[0]), 'utf8').trim().split(/\r?\n/) : [];
    t.check(
      lines.length === 2 &&
        lines[0].startsWith('time     | RAM used/total MB') &&
        /^\d\d:\d\d:\d\d \| \d+\/\d+ \| \d+\/\d+ \| \d+ processes; /.test(lines[1]),
      'memory-log --once writes the header and one sample',
      lines.join('\n'),
    );
    const pressure = fs.existsSync(path.join(memoryDir, 'memory-pressure.txt'))
      ? fs.readFileSync(path.join(memoryDir, 'memory-pressure.txt'), 'utf8')
      : '';
    t.check(
      /^(ok|high|critical) \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d RAM \d+\/\d+ MB, commit \d+\/\d+ MB/.test(pressure),
      'memory-pressure.txt holds the level and the numbers',
      pressure,
    );
    const hostTools = path.join(t.dir('host-tools'), 'HostTools.exe');
    const builtHost = spawnSync(
      CSC,
      ['/nologo', '/optimize', '/out:' + hostTools, ...csharp(t.packageRoot, 'native', 'csharp', 'HostTools')],
      { encoding: 'utf8' },
    );
    t.check(builtHost.status === 0, 'HostTools compiles (C# 5)', builtHost.stdout + builtHost.stderr);
    const events = spawnSync(hostTools, ['stop-events', '--since', new Date(Date.now() - 86400000).toISOString()], {
      encoding: 'utf8',
      timeout: 60000,
    });
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(events.stdout);
    } catch {
      /* checked below */
    }
    t.check(
      Array.isArray(parsed) &&
        parsed.every(
          (e) =>
            typeof e.at === 'string' &&
            typeof e.id === 'number' &&
            typeof e.provider === 'string' &&
            typeof e.process === 'string',
        ),
      'HostTools stop-events prints a JSON list of { at, id, provider, process }',
      events.stdout.slice(0, 500) + events.stderr,
    );
    const plain = Buffer.from('a saved login').toString('base64');
    const sealed = spawnSync(hostTools, ['protect'], { encoding: 'utf8', input: plain });
    const opened = spawnSync(hostTools, ['unprotect'], { encoding: 'utf8', input: sealed.stdout });
    t.check(
      sealed.status === 0 && sealed.stdout !== plain && opened.status === 0 && opened.stdout === plain,
      'HostTools protect and unprotect round-trip through DPAPI',
      sealed.stderr + opened.stderr,
    );
    t.equal(
      spawnSync(hostTools, ['unprotect'], { encoding: 'utf8', input: 'not base64!' }).status,
      1,
      'HostTools unprotect refuses bad input',
    );
    t.equal(
      spawnSync(hostTools, ['stop-events'], { encoding: 'utf8' }).status,
      2,
      'HostTools without --since prints its usage',
    );
  },
};
