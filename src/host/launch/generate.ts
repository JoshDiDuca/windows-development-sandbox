// Writes a launch folder for one sandbox: session.json (what the guest needs to know), the bundled runtime, hooks, the
// staged Claude settings and the .wsb file that starts Windows Sandbox. The pieces live in the sibling files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { GenerateOptions, Generated, ProfileResult } from '../../core/types.js';
import { widenForProjects } from '../../core/local-config/index.js';
import { dirExists, ensureDir, fail, writeJson } from '../../core/util/index.js';
import { engineFor, type EnginePlan, type SandboxEngine } from '../engines/index.js';
import { capturePersonalization, stageClaudeProfile } from '../profile/index.js';
import { clearSecrets, writeSecrets } from '../secrets/index.js';
import { githubTokenAllowed } from '../github/index.js';
import { folderAttachment } from '../storage/providers/index.js';
import { assertTestWritable } from '../test-guard.js';
import { writeLoadSettings } from '../life/watchdog.js';
import { loadProfileOf } from './risk-notes.js';
import { planBootProjects } from './boot-projects.js';
import { planDatabases } from './database-plan.js';
import { collectMappings } from './mappings.js';
import { guestSession, logonEnv } from './session-file.js';
import { copyRuntime, stageGitIdentity, stageHooks } from './stage.js';
import { decideProjectToolchains } from './toolchains.js';
import { buildLaunchPlan } from './launch-plan.js';
import { cappedMemoryMb, decideMemory, GUEST, memoryNote, residentNote, resolveMemoryMb } from './wsb-file.js';

const NO_PROFILE: ProfileResult = { hostDir: null, staged: [], skipped: [], credentials: false, secretsRemoved: [] };

/** Moves the staged copy of this PC's Claude login out of the launch folder; its text goes in the one-shot file. */
function takeStagedCredentials(launchPath: string): string | undefined {
  const file = path.join(launchPath, 'claude-profile', '.credentials.json');
  if (!fs.existsSync(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  fs.rmSync(file, { force: true });
  return text;
}

export function generateSandbox(
  given: GenerateOptions,
  /** The engine launch.ts opened (hcs needs a look at this PC first); Windows Sandbox when left out. */
  opened?: SandboxEngine,
): Generated & { personalization: string; enginePlan: EnginePlan } {
  // Several projects at boot: the sandbox also gets what the others want and you allowed (core/local-config).
  const others = given.bootWants?.projects ?? [];
  const boot = planBootProjects({
    run: given.run,
    packageRoot: given.packageRoot,
    extraProjects: given.extraProjects,
    knownProjects: given.knownProjects,
  });
  const wide = widenForProjects(given.run.config, others, { keepOff: given.bootWants?.keepOff, exists: dirExists });
  const o: GenerateOptions = { ...given, run: { ...given.run, config: wide.config } };
  const { config, dataPath, workspaceHost, harnessName, storageRoot } = o.run;
  const harness =
    harnessName === 'none'
      ? null
      : (config.harnesses[harnessName] ??
        fail('Unknown agent: ' + harnessName, 'Configured agents: ' + Object.keys(config.harnesses).join(', ')));
  if (!dirExists(workspaceHost))
    fail('The workspace folder does not exist: ' + workspaceHost, 'cd into the project first.');
  // An engine or storage kind that cannot work yet stops the launch here, before anything is written.
  const engine = opened ?? engineFor(config);
  if (config.storage.contained !== 'off' && !o.dataMappings)
    fail(
      'Contained storage was not prepared for this launch.',
      'Launch with sandbox launch (it mounts the image first).',
    );
  assertTestWritable(storageRoot);
  assertTestWritable(dataPath);

  // Checked before anything is written, so a refusal leaves nothing behind.
  const commitAvailableMb = o.commitAvailableMb ?? null;
  const askedMb = Math.max(
    resolveMemoryMb(config.sandbox, o.freeMemoryBytes, undefined, commitAvailableMb),
    ...others.map((p) => (typeof p.config.sandbox.memoryMb === 'number' ? p.config.sandbox.memoryMb : 0)),
  );
  // Never more than this PC can keep in RAM for it, whatever was asked.
  const memoryMb = cappedMemoryMb(askedMb, config.sandbox, Math.floor(os.totalmem() / 1048576));
  const launchId = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  const launchPath = path.join(storageRoot, 'launches', launchId);
  // Whatever must stay secret goes in a one-shot file in the data folder, never into the launch folder (the sandbox
  // maps it read-only and it is kept for days). Leftovers of earlier launches go first.
  ensureDir(dataPath);
  clearSecrets(storageRoot, dataPath);
  ensureDir(launchPath);
  const mappingNotes: string[] = [];
  const mappings = collectMappings(o, launchPath, boot, mappingNotes);

  const profile =
    harnessName === 'claude'
      ? stageClaudeProfile(config.claudeProfile, launchPath, workspaceHost, config.secrets)
      : NO_PROFILE;
  // This PC's Claude login leaves the launch folder for the one-shot file (with the agent environment and VPN login).
  const claudeCredentials = takeStagedCredentials(launchPath);
  stageGitIdentity(launchPath);
  const personalization = config.personalization.enabled ? capturePersonalization(launchPath) : 'disabled';
  const databases = o.databases ?? planDatabases(config.databases, workspaceHost);
  const toolchains = decideProjectToolchains(o);

  if (o.vpn?.profile) {
    ensureDir(path.join(launchPath, 'vpn'));
    fs.writeFileSync(path.join(launchPath, 'vpn', 'server.ovpn'), o.vpn.profile, 'utf8');
  }
  const session = guestSession(o, {
    launchId,
    launchPath,
    harness,
    boot,
    mappings,
    profile,
    databases,
    toolchains,
    memoryMb,
  });
  const sessionPath = path.join(launchPath, 'session.json');
  writeJson(sessionPath, session);
  writeLoadSettings(storageRoot, dataPath, {
    profile: loadProfileOf(config),
    reserveHostMb: config.sandbox.reserveHostMb,
  });
  writeSecrets(dataPath, launchId, {
    ...(harness && Object.keys(harness.environment).length ? { harnessEnvironment: harness.environment } : {}),
    ...(claudeCredentials ? { claudeCredentials } : {}),
    ...(o.vpn?.credentials ? { vpn: o.vpn.credentials } : {}),
    ...(o.vpn?.wireguardConfig ? { wireguardConfig: o.vpn.wireguardConfig } : {}),
    // Checked again on the configs the sandbox boots with: never when a project in it has git access below "full".
    ...(o.githubToken && githubTokenAllowed(config, others) ? { githubToken: o.githubToken } : {}),
  });
  fs.writeFileSync(path.join(launchPath, 'env.cmd'), logonEnv(session.workspace), 'utf8');
  copyRuntime(o.packageRoot, launchPath);
  stageHooks(o.packageRoot, launchPath, o.run.scripts);

  const enginePlan = engine.plan(
    buildLaunchPlan({
      config,
      memoryMb,
      mappings,
      launchPath,
      storage: o.dataMappings
        ? o.dataMappings.map((m) => ({ kind: 'folder' as const, host: m.host, guest: m.guest, readOnly: m.readOnly }))
        : [folderAttachment({ dataPath, guest: GUEST.data })],
    }),
  );
  for (const file of enginePlan.files) fs.writeFileSync(file.path, file.text, 'utf8');
  const wsbPath = enginePlan.entry;
  return {
    wsbPath,
    enginePlan,
    launchPath,
    launchId,
    sessionPath,
    memoryMb,
    memoryNote:
      residentNote(askedMb, memoryMb) ??
      (config.sandbox.memoryMb === 'auto'
        ? memoryNote(
            decideMemory(
              config.sandbox,
              Math.floor((o.freeMemoryBytes ?? os.freemem()) / 1048576),
              Math.floor(os.totalmem() / 1048576),
              commitAvailableMb,
            ),
          )
        : null),
    bootConfig: config,
    widened: wide.widened,
    mappings,
    profile,
    personalization,
    databases,
    toolchains,
    projects: { ...boot, notes: [...boot.notes, ...wide.notes] },
    mappingNotes,
  };
}
