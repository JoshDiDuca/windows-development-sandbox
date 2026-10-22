// At the start of an interactive command: makes sure the storage folder exists (private when it should be) and, once,
// offers to move saved data from another folder to where it belongs. Never asks without a terminal.
import { select } from '@inquirer/prompts';
import { userDir } from '../../../core/config/index.js';
import { errMsg } from '../../../core/util/index.js';
import { isSandboxRunning, insideSandbox } from '../../../host/sandbox/index.js';
import { protectPrivateFolder } from '../../../host/sharing/index.js';
import {
  describeDuration,
  describeSize,
  ensureStorageRoot,
  estimate,
  measureFolder,
  moveWarning,
  planOffer,
  staleMountNote,
  StorageHistory,
  type MoveOffer,
} from '../../../host/storage/index.js';
import { humanBytes } from '../../../core/disk.js';
import { StorageService } from '../../services/index.js';
import { c, working } from '../../output/index.js';
import { refreshStorage, type Context } from '../context.js';

/** Commands that do not touch the storage folder, or must work whatever state it is in. */
const NO_STORAGE: readonly string[] = ['self-test', '_watch', '_web', 'update', 'storage', 'migrate', 'repair'];
/** Commands that start something the user is sitting in front of: the offer is shown before them. */
const OFFERS: readonly string[] = ['menu', 'launch'];

type Answer = 'now' | 'later' | 'never';

async function ask(text: string): Promise<Answer> {
  console.error('\n' + text + '\n');
  return select<Answer>({
    message: 'Move it now?',
    choices: [
      { name: 'Move now', value: 'now' },
      { name: 'Not now', value: 'later' },
      { name: "Don't ask again", value: 'never' },
    ],
    default: 'now',
  });
}

function offerText(offer: MoveOffer, size: string, time: string, warning: string | null): string {
  const where = offer.toIsDefault
    ? 'The default folder is now ' + offer.to + ', which works for both kinds of install.'
    : 'Your folder is ' + offer.to + '.';
  return (
    'Your saved data (' +
    size +
    ') is in ' +
    offer.from +
    '. ' +
    where +
    ' Move it there now? ' +
    time +
    '.' +
    (warning ? '\n' + warning : '')
  );
}

async function offerMove(ctx: Context, history: StorageHistory): Promise<void> {
  const offer = planOffer(ctx.storageRoot, history);
  if (!offer || isSandboxRunning()) return;
  const measured = await working('Looking at your saved data', () => measureFolder(offer.from));
  const est = estimate(offer.from, offer.to, measured);
  const spoken = est.sameVolume ? 'a few seconds' : describeDuration(est.seconds);
  const time = spoken.charAt(0).toUpperCase() + spoken.slice(1);
  if (!est.fits) {
    console.error(c.dim(moveWarning(measured, est) ?? ''));
    return;
  }
  const answer = await ask(offerText(offer, describeSize(measured), time, moveWarning(measured, est)));
  if (answer === 'never') history.setDontAsk();
  else if (answer === 'later') history.setNotNow();
  if (answer !== 'now') return;
  let line = 'Moving your data';
  const result = await working(
    () => line,
    () =>
      new StorageService({ ...ctx, storageRoot: offer.from }).move(offer.to, false, (p) => {
        line = 'Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes);
      }),
  );
  console.error('Moved. Your data is now in ' + result.to + '.');
  for (const note of result.notes) console.error(c.dim(note));
  refreshStorage(ctx);
}

/** Before a command (after the saved settings are up to date). A failed move never stops the command. */
export async function storageBeforeCommand(ctx: Context, command: string): Promise<void> {
  if (insideSandbox() || NO_STORAGE.includes(command)) return;
  if (
    OFFERS.includes(command) &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !ctx.options.json &&
    !ctx.options.unattended
  ) {
    try {
      await offerMove(ctx, new StorageHistory(userDir()));
    } catch (e) {
      console.error(c.red('Could not move your data: ') + errMsg(e));
    }
  }
  ensureStorageRoot(ctx.storageRoot, protectPrivateFolder);
  // Contained storage (beta): a mount an earlier sandbox left behind is only mentioned here; repair fixes it.
  if (command !== 'launch' && !ctx.options.json) {
    const stale = staleMountNote(ctx.storageRoot, ctx.loaded.config.storage.dataName, isSandboxRunning);
    if (stale) console.error(c.yellow(stale));
  }
}
