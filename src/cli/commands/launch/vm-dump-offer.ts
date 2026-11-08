// After the sandbox's VM program (vmwp.exe) crashed: the next interactive launch offers, once, to keep a crash dump of
// it, so the next crash says which part of Windows failed. Windows asks for administrator permission. Never in
// --auto, --yes, unattended or piped runs: nobody could answer, and nothing on this PC is changed without a yes.
import { askYesNo } from '../../../core/prompt.js';
import { errMsg } from '../../../core/util/index.js';
import {
  isVmwpCrash,
  recordVmDumpsAnswer,
  shouldOfferVmDumps,
  vmDumpsAsked,
  type StopCause,
} from '../../../host/life/index.js';
import { readVmDumps, setVmDumps } from '../../../host/sandbox/index.js';
import { c } from '../../output/index.js';
import type { Context } from '../context.js';

/** Asks (once) whether to keep the VM's crash dump; `cause` is how the last sandbox ended. */
export async function offerVmDumps(ctx: Context, cause: StopCause | null): Promise<void> {
  if (!isVmwpCrash(cause)) return;
  const { options, storageRoot } = ctx;
  const interactive =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !options.auto && !options.unattended && !options.yes;
  try {
    const facts = {
      cause,
      interactive,
      asked: vmDumpsAsked(storageRoot),
      dumpsOn: interactive ? readVmDumps()?.on === true : false,
    };
    if (!shouldOfferVmDumps(facts)) return;
    console.log(
      "The sandbox's VM (vmwp.exe) crashed last time. Windows can keep a crash dump of it, so the next crash says which part of Windows failed.",
    );
    const yes = await askYesNo("Keep a crash dump of the sandbox's VM? (Windows asks for permission)", true);
    recordVmDumpsAnswer(storageRoot, yes);
    if (!yes) {
      console.log('Not turned on. Later: sandbox vm-dumps on');
      return;
    }
    const after = setVmDumps('on');
    console.log(
      after?.on
        ? "Crash dumps of the sandbox's VM go to " + after.folder + '.'
        : c.yellow('Not turned on (the permission was declined, or Windows refused). Later: sandbox vm-dumps on'),
    );
  } catch (e) {
    // Never keeps a sandbox from starting.
    console.warn(c.yellow('Could not set up the VM crash dump: ' + errMsg(e)));
  }
}
