// The storage area's work: where the saved data is, moving it (size, time and a warning first) or switching folders,
// and contained storage (beta: the disk image, which Windows asks permission to mount). Talks only through io.
// Every run is on this PC only (requireOnPc). The web's folder picker gives full paths. A relative path typed on the
// web is resolved against the web server's folder (as the command line does against the current folder); the move
// and switch questions then show the full path before anything changes, so the person still sees where it goes.
import fs from 'node:fs';
import path from 'node:path';
import { userConfigPath, userDir } from '../../../core/config/index.js';
import { humanBytes } from '../../../core/disk.js';
import { expandPath, fail } from '../../../core/util/index.js';
import { requireOnPc, type Context } from '../../../cli/commands/context.js';
import { StorageService } from '../../../cli/services/index.js';
import { isSandboxRunning, realContainedDeps } from '../../../host/sandbox/index.js';
import {
  assertTargetsFree,
  containedAvailability,
  ContainedStorage,
  describeDuration,
  describeSize,
  estimate,
  holdsData,
  measureFolder,
  moveProblem,
  moveWarning,
  otherDataFolders,
  planTransfer,
  runTransfer,
  setStateOf,
  sharedDefaultRoot,
  StateFile,
  StorageHistory,
  writeContainedSetting,
  type Measured,
  type MoveResult,
  type TransferPlan,
} from '../../../host/storage/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import {
  changeDataFolder,
  containedOff,
  containedOn,
  containedStatus,
  moveStorage,
  showStorage,
  useStorage,
  type StorageShow,
} from './storage.def.js';

const BETA = 'Beta, and not yet tested on a real PC. ';
/** The menu's change of folder measures for at most this long (the size then reads "at least"). */
const MEASURE_MS = 8000;
const NO_TERMINAL = 'Cannot ask here (no terminal).';

function requireAvailable(): void {
  const check = containedAvailability();
  if (!check.available) fail('Contained storage cannot be used: ' + check.reasons.join(' '), check.fixes.join(' '));
}

function requireNoSandbox(): void {
  if (isSandboxRunning())
    fail('A sandbox is running.', 'Close it (sandbox stop) first: the folders in the image are in use.');
}

function storageFor(ctx: Context): ContainedStorage {
  const { config } = ctx.loaded;
  return new ContainedStorage(
    realContainedDeps(ctx.storageRoot, config.storage.containedMaxGb),
    config.storage.dataName,
  );
}

/** The folder a move or a switch goes to: picked from the known folders, or typed (expanded like the command line). */
async function chooseFolder(
  io: OperationIO,
  service: StorageService,
  what: 'move' | 'use',
  cancelMessage: string,
): Promise<string> {
  const typed = '@type';
  const fix = 'Use: sandbox storage ' + what + ' <folder>';
  const picked = await io.choose({
    title: 'Which folder?',
    choices: [
      ...service.knownFolders().map((f) => ({ value: f, label: f })),
      { value: typed, label: 'Type a path...' },
    ],
    noTerminal: { message: NO_TERMINAL, fix },
  });
  if (picked === undefined) cancelled(cancelMessage);
  if (picked !== typed) return picked;
  const answer = await io.path({
    title: 'Folder:',
    pathKind: 'dir',
    validate: (v) => v.length > 0 || 'Type a folder path.',
    noTerminal: { message: NO_TERMINAL, fix },
  });
  if (answer === undefined) cancelled(cancelMessage);
  return expandPath(answer, process.cwd());
}

/**
 * Moves the data to `to`: the plan is written out first (size, time, a warning, room on the drive). Asks first when
 * `ask` (the command asks, the menu has asked already). Returns the move's result with its message.
 */
async function moveData(
  io: OperationIO,
  service: StorageService,
  from: string,
  to: string,
  keepOld: boolean,
  ask: boolean,
): Promise<MoveOutcome> {
  service.validate(to);
  io.progress('Measuring your saved data');
  const measured = measureFolder(from);
  const est = estimate(from, to, measured, keepOld);
  const time = est.sameVolume
    ? 'a few seconds (same drive, nothing is copied)'
    : describeDuration(est.seconds) + ' (copied to another drive)';
  io.log('Move from: ' + from);
  io.log('       to: ' + to);
  io.log('     size: ' + describeSize(measured));
  io.log('     time: ' + time);
  const warning = moveWarning(measured, est);
  if (warning) io.log('Warning: ' + warning, 'warn');
  if (!est.fits) fail('Not enough free space on the target drive.', 'Free some space or pick another drive.');
  if (ask) {
    const yes = await io.confirm({
      title: 'Move your data to ' + to + '?',
      yes: 'Move',
      noTerminal: { message: NO_TERMINAL, fix: 'Add --yes to move without asking.' },
    });
    if (!yes) cancelled('Nothing was moved.');
  }
  io.progress('Moving your data');
  const result = await service.move(to, keepOld, (p) =>
    io.progress('Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes)),
  );
  for (const note of result.notes) io.log(note);
  io.log('Your settings now point to ' + result.pinned + ', so older versions find the data too.');
  const left = result.removedOld ? '' : '; the old folder is still at ' + result.from;
  return {
    ...result,
    notes: [...result.notes],
    message: 'Moved ' + result.files.toLocaleString('en-US') + ' files. Your data is now in ' + result.to + left + '.',
  };
}

/** What a move did, for the output (the notes as a plain list). */
type MoveOutcome = Omit<MoveResult, 'notes'> & { notes: string[]; message: string };

/** Looks for the data in `to` from now on, without moving it. Asks first when `ask`. Returns the message. */
async function useData(
  io: OperationIO,
  service: StorageService,
  from: string,
  to: string,
  ask: boolean,
): Promise<string> {
  // A relative folder would be pinned as it is (and resolved against another folder later): refuse it.
  if (!path.isAbsolute(to)) fail(to + ' is not a full path.', 'Give a path like D:\\Sandbox.');
  const busy = service.busy();
  if (busy) fail(busy, 'Wait a minute, then try again.');
  const state = holdsData(to)
    ? to + ' is used as it is.'
    : to + ' starts empty: tools, logins and history are set up again.';
  io.log('Warning: your data stays in ' + from + '. ' + state, 'warn');
  if (ask) {
    const yes = await io.confirm({
      title: 'Use ' + to + ' from now on, without moving your data?',
      yes: 'Use',
      noTerminal: { message: NO_TERMINAL, fix: 'Add --yes to switch without asking.' },
    });
    if (!yes) cancelled('Nothing was changed.');
  }
  service.use(to);
  return 'Your data is now looked for in ' + to + '. Move it later with: sandbox storage move <folder>';
}

export const showStorageRun = implement(showStorage, async (ctx, input, io) => {
  requireOnPc('storage');
  const root = ctx.storageRoot;
  if (input.measure) io.progress('Measuring your saved data (big folders take a moment)');
  const measured: Measured | null = input.measure ? measureFolder(root) : null;
  const has = holdsData(root);
  const shared = sharedDefaultRoot();
  const size = !has ? 'nothing in it yet' : measured ? describeSize(measured) : 'not measured yet';
  const answer: StorageShow = {
    root,
    exists: fs.existsSync(root),
    holdsData: has,
    measured: measured ? { bytes: measured.bytes, files: measured.files, partial: measured.partial } : null,
    size,
    defaultRoot: shared,
    defaultInUse: shared.toLowerCase() === root.toLowerCase(),
    otherFoldersWithData: otherDataFolders(root, new StorageHistory(userDir())),
  };
  return answer;
});

export const moveStorageRun = implement(moveStorage, async (ctx, input, io) => {
  requireOnPc('storage');
  const service = new StorageService(ctx);
  const from = ctx.storageRoot;
  const to = input.folder
    ? expandPath(input.folder, process.cwd())
    : await chooseFolder(io, service, 'move', 'Nothing was moved.');
  if (!fs.existsSync(from))
    fail('There is nothing to move: ' + from + ' does not exist.', 'Use sandbox storage use ' + to + ' to switch.');
  return moveData(io, service, from, to, input.keepOld, true);
});

export const useStorageRun = implement(useStorage, async (ctx, input, io) => {
  requireOnPc('storage');
  const service = new StorageService(ctx);
  const to = input.folder
    ? expandPath(input.folder, process.cwd())
    : await chooseFolder(io, service, 'use', 'Nothing was changed.');
  if (to.toLowerCase() === ctx.storageRoot.toLowerCase()) return { message: 'That folder is in use already.' };
  return { message: await useData(io, service, ctx.storageRoot, to, true) };
});

export const changeDataFolderRun = implement(changeDataFolder, async (ctx, _input, io) => {
  requireOnPc('storage');
  const service = new StorageService(ctx);
  const from = ctx.storageRoot;
  const exists = fs.existsSync(from);
  if (exists) io.progress('Measuring your saved data');
  const measured: Measured = exists ? measureFolder(from, MEASURE_MS) : { bytes: 0, files: 0, partial: false };
  const size = exists && holdsData(from) ? describeSize(measured) : 'nothing in it yet';
  const to = await io.path({
    title: 'Choose the folder for your saved data',
    lines: [
      'Now: ' + from + ' (' + size + ').',
      'Pick a new or empty folder to move your data there, or a folder that already holds data to use it.',
    ],
    pathKind: 'dir',
    initial: from.replace(/[\\/][^\\/]*$/, '\\'),
    validate: (picked) => moveProblem(from, picked, true)?.message ?? true,
  });
  if (to === undefined || path.resolve(to).toLowerCase() === path.resolve(from).toLowerCase()) cancelled();
  // The folder is stored as a full, normalised path (no trailing separator or `..` left in storage.root).
  const dest = path.resolve(to);
  const target = holdsData(dest);
  const lines: string[] = [];
  let canMove = exists && holdsData(from) && !target;
  if (canMove) {
    const est = estimate(from, dest, measured);
    lines.push('From: ' + from, 'To:   ' + dest, 'Size: ' + describeSize(measured));
    lines.push(
      est.sameVolume
        ? 'Time: a few seconds (same drive, nothing is copied)'
        : 'Time: ' + describeDuration(est.seconds) + ' (copied to another drive)',
    );
    if (est.freeBytes !== null) lines.push('Free space on the target drive: ' + humanBytes(est.freeBytes));
    const warning = moveWarning(measured, est);
    if (warning) lines.push('', warning);
    if (!est.fits) canMove = false;
  } else
    lines.push(
      target ? dest + ' already holds data, so it is used as it is.' : 'There is nothing in ' + from + ' to move.',
      'Your data stays where it is.',
    );
  lines.push('', 'Use without moving: the new folder is used from now on and your old data is left behind.');
  const choice = await io.choose({
    title: canMove ? 'Move your data to ' + dest + '?' : 'Use ' + dest + '?',
    lines,
    choices: [
      ...(canMove ? [{ value: 'move', label: 'Move data' }] : []),
      { value: 'use', label: 'Switch without moving' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (choice === 'move') return { message: (await moveData(io, service, from, dest, false, false)).message };
  if (choice === 'use') return { message: await useData(io, service, from, dest, false) };
  return cancelled();
});

export const containedStatusRun = implement(containedStatus, async (ctx) => {
  requireOnPc('storage');
  const storage = storageFor(ctx);
  const check = containedAvailability();
  const record = setStateOf(new StateFile(storage.paths).read(), storage.set);
  const reality = check.available && storage.imageExists() ? await storage.reality() : null;
  return {
    setting: ctx.loaded.config.storage.contained,
    maxGb: ctx.loaded.config.storage.containedMaxGb,
    available: check.available,
    reasons: [...check.reasons],
    fixes: [...check.fixes],
    image: storage.paths.image,
    imageExists: storage.imageExists(),
    imageBytes: reality?.imageBytes ?? null,
    mountFolder: storage.paths.mount,
    recordedMounted: record.mounted,
    holders: record.holders.length,
    mountedNow: reality?.mountIsMountPoint ?? null,
  };
});

/** Writes the plan's sizes and time as lines; a plan that does not fit stops here. */
function planLines(io: OperationIO, plan: TransferPlan, to: string): void {
  for (const f of plan.folders) io.log('  ' + f.name + ': ' + describeSize(f.measured));
  io.log('  total: ' + describeSize(plan.total) + ' to ' + to);
  io.log('  time:  about ' + describeDuration(plan.estimate.seconds) + ' (copied, then the originals are removed)');
  if (!plan.estimate.fits) fail('Not enough free space for the copy.', 'Free some space on that drive and try again.');
}

export const containedOnRun = implement(containedOn, async (ctx, _input, io) => {
  requireOnPc('storage');
  requireAvailable();
  requireNoSandbox();
  const storage = storageFor(ctx);
  const { config } = ctx.loaded;
  const configFile = ctx.loaded.configPath ?? userConfigPath();
  io.log(BETA + 'Contained storage keeps the sandbox tools, state and logs in one disk image file.', 'warn');
  io.log('  image:  ' + storage.paths.image + (storage.imageExists() ? ' (exists, it is used as it is)' : ''));
  io.log(
    '  limit:  ' + config.storage.containedMaxGb + ' GB (storage.containedMaxGb; the file grows only as it fills)',
  );
  io.log('  Windows asks for permission to mount it each time a sandbox starts (and once when it closes).');
  const turnOn = await io.confirm({
    title: 'Turn contained storage on?',
    yes: 'Turn on',
    noTerminal: { message: NO_TERMINAL, fix: 'Add --yes to turn it on without asking.' },
  });
  if (!turnOn) fail('Nothing was changed.', 'Run sandbox storage contained on when you want it.');
  io.progress('Making and mounting the image (Windows asks for permission)');
  const mount = await storage.acquire({ id: 'cli', pid: process.pid }, { create: true });
  try {
    const plan = planTransfer(ctx.dataPath, mount, ctx.storageRoot);
    if (plan.folders.length > 0) {
      io.log('These folders hold your tools, state and logs now:');
      planLines(io, plan, 'the image');
      assertTargetsFree(plan);
      const move = await io.confirm({
        title: 'Move them into the image?',
        yes: 'Move',
        noTerminal: { message: NO_TERMINAL, fix: 'Add --yes to move without asking.' },
      });
      if (move) {
        io.progress('Copying');
        const result = await runTransfer(plan, ctx.dataPath, (p) =>
          io.progress('Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes)),
        );
        io.log('Moved ' + result.files.toLocaleString('en-US') + ' files into the image.');
        for (const note of result.notes) io.log(note, 'warn');
      } else
        io.log(
          'They stay where they are and are not used: tools are downloaded again into the image. Delete them later with sandbox data clean.',
        );
    }
    writeContainedSetting(configFile, 'vhdx');
  } finally {
    io.progress('Dismounting the image (Windows asks for permission)');
    const done = await storage.release('cli');
    if (!done.dismounted)
      io.log('The image stays mounted (' + (done.note ?? '') + '). sandbox repair dismounts it.', 'warn');
  }
  return { message: 'Contained storage is on. sandbox launch mounts the image first.' };
});

export const containedOffRun = implement(containedOff, async (ctx, _input, io) => {
  requireOnPc('storage');
  requireAvailable();
  requireNoSandbox();
  const storage = storageFor(ctx);
  const configFile = ctx.loaded.configPath ?? userConfigPath();
  io.log(BETA + 'Turning contained storage off moves the files back into plain folders.', 'warn');
  if (!storage.imageExists()) {
    writeContainedSetting(configFile, 'off');
    return { message: 'There is no image, so there was nothing to move. Contained storage is off.' };
  }
  io.progress('Mounting the image (Windows asks for permission)');
  const mount = await storage.acquire({ id: 'cli', pid: process.pid });
  let moved = false;
  try {
    const plan = planTransfer(mount, ctx.dataPath, ctx.dataPath);
    if (plan.folders.length > 0) {
      io.log('In the image:');
      planLines(io, plan, ctx.dataPath);
      assertTargetsFree(plan);
      const back = await io.confirm({
        title: 'Move them back out of the image?',
        yes: 'Move',
        noTerminal: { message: NO_TERMINAL, fix: 'Add --yes to move without asking.' },
      });
      if (!back) fail('Nothing was moved.', 'Contained storage is still on.');
      io.progress('Copying');
      const result = await runTransfer(plan, mount, (p) =>
        io.progress('Copying: ' + p.files.toLocaleString('en-US') + ' files, ' + humanBytes(p.bytes)),
      );
      io.log('Moved ' + result.files.toLocaleString('en-US') + ' files back.');
      for (const note of result.notes) io.log(note, 'warn');
    }
    writeContainedSetting(configFile, 'off');
    moved = true;
  } finally {
    io.progress('Dismounting the image (Windows asks for permission)');
    const done = await storage.release('cli');
    if (!done.dismounted)
      io.log('The image stays mounted (' + (done.note ?? '') + '). sandbox repair dismounts it.', 'warn');
    else if (!moved) io.log('The image was dismounted; contained storage is still on.');
  }
  // The image is removed only when the person says so; a command line with --yes keeps it (skipWithYes).
  const bytes = fs.statSync(storage.paths.image).size;
  const remove = await io.confirm({
    title: 'Delete the image file now (' + humanBytes(bytes) + ')? Everything in it was moved out.',
    yes: 'Delete',
    danger: true,
    skipWithYes: true,
    noTerminal: { message: NO_TERMINAL, fix: 'Answer no to keep it.' },
  });
  if (remove) {
    await storage.deleteImage();
    io.log('Deleted ' + storage.paths.image + '.');
  } else io.log('The image file is kept: ' + storage.paths.image + ' (delete it yourself when you are sure).');
  return {
    message: 'Contained storage is off: tools, state and logs are plain folders in ' + ctx.dataPath + '.',
  };
});
