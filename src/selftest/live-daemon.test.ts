// Live: the real guest session daemon + ptyhost (ConPTY), driven through the run folder exactly like the host does,
// with cmd.exe standing in for the agent. One daemon serves all the checks below, in order (compiling ptyhost is slow).
import fs from 'node:fs';
import path from 'node:path';
import { queryViewers } from '../shared/pty/index.js';
import { copyCmdAsFakeAgent, openViewer, sees, startDaemon, tail, viewersWhen, WAIT } from './support/live.js';
import type { Suite } from './support/suite.js';

export const liveDaemonSuite: Suite = {
  name: 'live-daemon',
  title: 'live: session daemon + ptyhost (start, attach, viewers, exec, restart, exit)',
  live: true,
  timeoutMs: 360000,
  run: async (t, f) => {
    const gen = await f.launch();
    const data = t.at('live-data');
    const workspace = f.workA;
    copyCmdAsFakeAgent(data);
    const session = f.readJson(gen.sessionPath);
    Object.assign(session, { workspace, attach: { enabled: true } });
    Object.assign(session.harness, {
      arguments: ['/d', '/k', 'echo LIVE-AGENT-READY'],
      resumeArguments: ['/d', '/k', 'echo LIVE-AGENT-RESUMED'],
      // The agent's own environment (where its keys live): a shell session must not get it.
      environment: { LIVE_AGENT_KEY: 'sk-live-agent' },
    });
    t.writeJson(gen.sessionPath, session);
    const daemon = startDaemon(t, f, { launchPath: gen.launchPath, data, workspace });
    const viewers = [] as { close: () => void }[];
    try {
      t.section('live: starting a session');
      daemon.request({ kind: 'session', id: 'live1', harness: 'claude', args: [], cwd: workspace });
      const started = await daemon.started('live1');
      const running = started?.phase === 'running' && Boolean(started.attach?.port);
      t.check(
        running,
        'the daemon compiles ptyhost and starts a session on request',
        'phase: ' + started?.phase + ' ' + (started?.message ?? '(no status written)') + '\n' + daemon.diagnostics(),
      );
      if (!started?.attach) return;
      const attach = started.attach;
      const local = { ...attach, addresses: ['127.0.0.1'] };

      t.section('live: attached clients');
      const viewer = await openViewer(attach);
      viewers.push(viewer);
      const sawReady = await sees(t, viewer, 'LIVE-AGENT-READY');
      viewer.type('echo TYPED-%USERNAME:~0,0%OK');
      const sawTyped = await sees(t, viewer, 'TYPED-OK');
      t.check(
        Boolean(sawReady && sawTyped),
        "an attached client sees the agent's screen, and its keystrokes reach the agent",
        'screen so far: ' + tail(viewer.output()) + '\n' + daemon.diagnostics(),
      );

      const intruder = await openViewer(attach, { token: 'wrong-token', cols: 80, rows: 24 });
      viewers.push(intruder);
      const denied = await t.waitFor(() => intruder.error(), WAIT.viewers);
      t.check(
        Boolean(denied) && denied!.includes('denied') && !intruder.output().includes('LIVE-AGENT'),
        'a client with the wrong token is refused and sees nothing of the session',
        'error frame: ' +
          JSON.stringify(denied) +
          ', connection closed: ' +
          intruder.closed() +
          '\n' +
          tail(intruder.output()),
      );

      t.section('live: counting viewers');
      // Each count is polled: a query that gets no answer yet is asked again, and the number must settle on the
      // expected value.
      const one = await viewersWhen(t, attach, (v) => v.viewers === 1);
      t.check(
        one !== null && one.remote === 0,
        'a single attached terminal is counted as one viewer; one on loopback (inside the sandbox) is not remote',
        'last answer: ' + JSON.stringify(await queryViewers(local, 5000)),
      );
      const second = await openViewer(attach, { cols: 60, rows: 20 });
      viewers.push(second);
      const two = await viewersWhen(t, attach, (v) => v.viewers === 2);
      t.check(
        two !== null,
        'a second attached terminal is counted too',
        'last answer: ' + JSON.stringify(await queryViewers(local, 5000)),
      );
      second.close();
      const backToOne = await viewersWhen(t, attach, (v) => v.viewers === 1);
      t.check(
        backToOne !== null && backToOne.remote === 0 && daemon.status('live1')?.phase === 'running',
        'a closed terminal stops counting at once, the remaining viewer is still not remote, and the session keeps running',
        'last answer: ' + JSON.stringify(await queryViewers(local, 5000)),
      );
      t.equal(
        await queryViewers({ ...local, token: 'wrong-token' }, 10000),
        null,
        'the viewer query needs the session token too',
      );

      t.section('live: exec and requests');
      daemon.request({
        kind: 'exec',
        id: 'exec1',
        command: ['echo', 'hello from exec'],
        cwd: workspace,
        timeoutSeconds: 30,
      });
      const exec = await daemon.response('exec1');
      t.check(
        Boolean(exec?.ok && exec.stdout?.includes('hello from exec')),
        'exec runs a command in the sandbox and returns its output',
        JSON.stringify(exec),
      );
      daemon.request({ kind: 'exec', id: 'exec2', command: ['dir'], cwd: 'C:\\Windows', timeoutSeconds: 30 });
      const outside = await daemon.response('exec2');
      t.check(
        outside?.ok === false && outside.message.includes('not inside the sandbox workspace'),
        'exec refuses folders outside the workspace',
        JSON.stringify(outside),
      );
      daemon.request({ kind: 'shell', id: 'evil', command: 'calc' });
      daemon.request({ kind: 'ping', id: 'ping1' });
      const ping = await daemon.response('ping1');
      // Requests are handled in order, so by the time the ping is answered the unknown one has been dealt with.
      t.check(
        Boolean(ping?.ok) &&
          !fs.existsSync(path.join(daemon.run, 'responses', 'evil.json')) &&
          !fs.existsSync(path.join(daemon.run, 'requests', 'evil.json')),
        'ping is answered; an unknown request kind gets no answer and is deleted',
        JSON.stringify(ping),
      );

      t.section('live: a plain shell session');
      daemon.request({ kind: 'session', id: 'shell1', harness: 'shell', args: [], cwd: workspace, shell: 'cmd' });
      const shell = await daemon.started('shell1');
      t.check(
        shell?.phase === 'running' && shell.harness === 'cmd' && shell.kind === 'shell' && Boolean(shell.attach),
        'a shell session runs through ptyhost and is listed by its shell, marked as a shell',
        JSON.stringify(shell) + '\n' + daemon.diagnostics(),
      );
      if (shell?.attach) {
        const shellView = await openViewer(shell.attach);
        viewers.push(shellView);
        // Typing before cmd has drawn its prompt can lose the keystrokes: wait for the prompt first.
        await sees(t, shellView, '>');
        shellView.type('echo SHELL-[%LIVE_AGENT_KEY%]-%USERNAME:~0,0%OK');
        const sawShell = await sees(t, shellView, 'SHELL-[%LIVE_AGENT_KEY%]-OK');
        t.check(
          Boolean(sawShell),
          "keystrokes reach the shell, and it has none of the agent's own environment",
          'screen so far: ' + tail(shellView.output()) + '\n' + daemon.diagnostics(),
        );
        daemon.request({ kind: 'close', id: 'close1', session: 'shell1' });
        const closed = await daemon.response('close1');
        const shellEnded = await t.waitFor(() => {
          const s = daemon.status('shell1');
          return s?.phase === 'exited' ? s : null;
        }, WAIT.exit);
        t.check(
          Boolean(closed?.ok) && shellEnded !== null && shellView.exitCode() !== null,
          'close ends the shell: the sandbox answers, the status says exited and the attached client gets the exit',
          JSON.stringify(closed) + ' ' + JSON.stringify(daemon.status('shell1')),
        );
        daemon.request({ kind: 'close', id: 'close2', session: 'shell1' });
        const again = await daemon.response('close2');
        t.check(again?.ok === false, 'closing a session that has ended says it is not running', JSON.stringify(again));
      }

      t.section('live: restart and exit');
      daemon.request({ kind: 'restart', id: 'restart1', harness: 'claude' });
      const sawResumed = await sees(t, viewer, 'LIVE-AGENT-RESUMED');
      t.check(
        Boolean(sawResumed),
        'restart relaunches the agent with its resume arguments while attached',
        'screen so far: ' + tail(viewer.output()) + '\n' + daemon.diagnostics(),
      );
      viewer.type('exit 3');
      const gotExit = await t.waitFor(() => viewer.exitCode() !== null, WAIT.exit);
      const ended = await t.waitFor(() => {
        const s = daemon.status('live1');
        return s?.phase === 'exited' ? s : null;
      }, WAIT.exit);
      t.equal(
        [gotExit ? viewer.exitCode() : null, ended?.exitCode],
        [3, 3],
        "the agent's exit code reaches the attached client and the session status",
      );
    } finally {
      for (const v of viewers) v.close();
      await daemon.stop();
    }
  },
};
