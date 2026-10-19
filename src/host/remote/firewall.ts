// The Windows Firewall rule of LAN mode and the network it runs on (docs/design/remote-access.md). The rule is added or
// removed by native\scripts\set-web-firewall.ps1, elevated (one Windows permission prompt), from a request file whose
// SHA-256 it checks; it checks every value again. get-network-profile.ps1 says whether the address is on a Private
// network. A test hands in a fake runner, or runs the script with -DryRun (no elevation, nothing changed).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { fail } from '../../core/util/index.js';
import { readValid } from '../../shared/io/index.js';
import { SYSTEM } from '../../shared/system.js';
import { nativeFile, nativeScript } from '../native.js';
import { refuseInSelfTest } from '../test-guard.js';
import { isPrivateIPv4 } from './lan.js';

export const FIREWALL_RULE_NAME = 'Agent Sandbox web UI (LAN)';
const SCRIPT_TIMEOUT_MS = 5 * 60_000;

export type FirewallRequest =
  | {
      readonly action: 'add';
      readonly ruleName: string;
      readonly port: number;
      readonly localAddress: string;
      readonly program: string;
    }
  | { readonly action: 'remove'; readonly ruleName: string };

/** The request for adding the rule (checked here first; the script checks it again). */
export function addRuleRequest(
  port: number,
  localAddress: string,
  program: string = process.execPath,
): FirewallRequest {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('The LAN port must be from 1024 to 65535.');
  if (!isPrivateIPv4(localAddress))
    fail(localAddress + ' is not a private address.', 'LAN mode is for your own network only.');
  if (path.basename(program).toLowerCase() !== 'node.exe' || !path.isAbsolute(program))
    fail('The web UI runs on node.exe, which the firewall rule names: ' + program + ' is not it.');
  return { action: 'add', ruleName: FIREWALL_RULE_NAME, port, localAddress, program };
}

export function removeRuleRequest(): FirewallRequest {
  return { action: 'remove', ruleName: FIREWALL_RULE_NAME };
}

export interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (exe: string, args: readonly string[], timeoutMs: number) => Promise<ScriptRun>;

/** The real runner: a process, its output collected. */
export const spawnRunner: Runner = (exe, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(exe, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => resolve({ status: null, stdout, stderr: stderr + e.message }));
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

const OutcomeSchema = z.object({
  ok: z.boolean(),
  message: z.string().max(2000),
  commands: z.array(z.string().max(1000)).max(4).optional(),
});
export type FirewallOutcome = z.output<typeof OutcomeSchema>;

/** Writes the request in a private temp folder and runs the script on it (elevated, or -DryRun). */
async function runScript(request: FirewallRequest, dryRun: boolean, run: Runner): Promise<FirewallOutcome> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sandbox-firewall-'));
  try {
    const file = path.join(dir, 'request.json');
    fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const script = nativeFile('scripts', 'set-web-firewall.ps1');
    const args = dryRun
      ? nativeScript('set-web-firewall.ps1', ['-Json', file, '-Sha256', sha, '-DryRun'])
      : nativeScript('run-elevated.ps1', ['-Script', script, '-Json', file, '-Sha256', sha]);
    const out = await run(SYSTEM.powershell(), args, SCRIPT_TIMEOUT_MS);
    if (dryRun) {
      const line = out.stdout.trim().split(/\r?\n/).pop() ?? '';
      const parsed = OutcomeSchema.safeParse(safeJson(line));
      return parsed.success ? parsed.data : { ok: false, message: (out.stderr || out.stdout || 'no answer').trim() };
    }
    const answer = readValid(OutcomeSchema, path.join(dir, 'result.json'));
    if (!answer)
      return fail(
        out.status === 1
          ? 'Windows did not give permission (the prompt was declined or closed).'
          : 'The firewall script gave no answer' + (out.stderr.trim() ? ': ' + out.stderr.trim() : '.'),
        'Run the command again and choose Yes in the Windows prompt.',
      );
    return answer;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Adds or removes the rule on this PC (one Windows permission prompt). Never in the self-test with the real runner. */
export async function applyFirewall(request: FirewallRequest, run: Runner = spawnRunner): Promise<FirewallOutcome> {
  if (run === spawnRunner) refuseInSelfTest('change the Windows Firewall');
  const outcome = await runScript(request, false, run);
  if (!outcome.ok) fail('The firewall rule was not changed: ' + outcome.message);
  return outcome;
}

/** Checks a request with the script itself and returns what it would run; nothing changes (no elevation). */
export function checkFirewall(request: unknown, run: Runner = spawnRunner): Promise<FirewallOutcome> {
  return runScript(request as FirewallRequest, true, run);
}

const ProfileSchema = z.object({ found: z.boolean(), category: z.string().max(64), name: z.string().max(256) });
export type NetworkProfile = z.output<typeof ProfileSchema>;

/** The network the address is on (category and name), from Windows. */
export async function networkProfile(address: string, run: Runner = spawnRunner): Promise<NetworkProfile> {
  if (!isPrivateIPv4(address)) return { found: false, category: '', name: '' };
  const out = await run(SYSTEM.powershell(), nativeScript('get-network-profile.ps1', ['-Address', address]), 30_000);
  const parsed = ProfileSchema.safeParse(safeJson(out.stdout.trim().split(/\r?\n/).pop() ?? ''));
  return parsed.success ? parsed.data : { found: false, category: '', name: '' };
}

/** Why LAN mode may not start on this network, or null. `expected`: the network it was turned on for. */
export function networkProblem(p: NetworkProfile, expected: string | null): string | null {
  if (!p.found) return 'Windows does not know the network of that address.';
  if (p.category !== 'Private')
    return (
      'The network "' + p.name + '" is marked ' + (p.category || 'unknown') + ', not Private, so LAN mode stays off.'
    );
  if (expected !== null && p.name !== expected)
    return 'LAN mode was turned on for the network "' + expected + '", not "' + p.name + '".';
  return null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
