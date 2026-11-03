// Agents whose login lives in the sandbox's user profile (~/.qwen ...): link those folders into the persistent state.
import type { Harness } from '../../core/types.js';
import { profileLinkPairs, type ProfileLink } from '../../shared/paths/index.js';
import { dryRun, isWin, testMode } from '../runtime/paths.js';
import { runScriptWithJson, runScriptWithJsonAsync } from '../runtime/process.js';
import { stateDir } from '../runtime/session.js';
import { log, warn } from '../runtime/log.js';
import { errMsg } from '../../core/util/errors.js';

/** The sandbox's own user profile folder (not a setting: the guest's account). */
const profileRoot = (): string => process.env.USERPROFILE ?? '';

const linkPairs = (agents: Readonly<Record<string, readonly string[] | undefined>>): ProfileLink[] =>
  !isWin || dryRun || testMode || !profileRoot()
    ? []
    : Object.entries(agents).flatMap(([agent, dirs]) =>
        dirs?.length ? profileLinkPairs(agent, dirs, profileRoot(), stateDir) : [],
      );

/** The boot's linkProfileDirs without blocking the event loop. */
export async function linkProfileDirsAsync(
  agents: Readonly<Record<string, readonly string[] | undefined>>,
): Promise<void> {
  const pairs = linkPairs(agents);
  if (!pairs.length) return;
  try {
    await runScriptWithJsonAsync('link-profile-dirs.ps1', 'PairsFile', pairs);
    log('Agent logins kept: ' + pairs.length + ' profile folder(s) linked into persistent storage.');
  } catch (e) {
    warn('Could not link the agent profile folders (their logins will not be kept): ' + errMsg(e));
  }
}

/** Makes the profile folders of these agents junctions into state\<agent>\profile; one failure never stops the boot. */
export function linkProfileDirs(agents: Readonly<Record<string, readonly string[] | undefined>>): void {
  const pairs = linkPairs(agents);
  if (!pairs.length) return;
  try {
    runScriptWithJson('link-profile-dirs.ps1', 'PairsFile', pairs);
    log('Agent logins kept: ' + pairs.length + ' profile folder(s) linked into persistent storage.');
  } catch (e) {
    warn('Could not link the agent profile folders (their logins will not be kept): ' + errMsg(e));
  }
}

/** The same for one agent, when it is installed (the daemon starts agents the boot did not know). */
export function linkHarnessProfile(name: string, harness: Harness): void {
  linkProfileDirs({ [name]: harness.home?.profileDirs });
}
