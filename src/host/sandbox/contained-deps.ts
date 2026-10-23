// The real wiring of contained storage on this PC: the storage helper when an all-users install added it, else the
// permission-prompt scripts, protectPrivateFolder for new
// folders, your SID, and whether a sandbox runs. Lives here (not in host/storage) so storage never imports the
// sandbox or sharing folders, which import storage. The self-test never reaches a disk through it: the disk port
// refuses there.
import { HelperDiskPort, helperApplies, ScriptDiskPort, type ContainedDeps } from '../storage/index.js';
import { currentUserSid, protectPrivateFolder } from '../sharing/index.js';
import { isSandboxRunning } from './platform.js';

/** `configOverridden`: the command runs with --config (the helper reads only your usual settings: it is not asked). */
export function realContainedDeps(storageRoot: string, maxGb: number, configOverridden = false): ContainedDeps {
  return {
    storageRoot,
    maxGb,
    protect: (dir) => protectPrivateFolder(dir),
    userSid: currentUserSid,
    port: new HelperDiskPort(new ScriptDiskPort(), helperApplies(process.env, configOverridden)),
    sandboxRunning: isSandboxRunning,
  };
}
