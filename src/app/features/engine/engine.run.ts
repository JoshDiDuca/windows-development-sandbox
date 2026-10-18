// The engine feature's work: looking for HCS systems this tool left running, and stopping them.
import { fail, safeText } from '../../../core/util/index.js';
import { lookForLeftovers, stopLeftovers } from '../../../host/engines/index.js';
import { implement } from '../../context.js';
import { cancelled, plural } from '../../kernel/index.js';
import { cleanEngine, engineLeftovers, type Leftovers } from './engine.def.js';

const NOT_AVAILABLE = ' Nothing to clean.';

export const engineLeftoversRun = implement(engineLeftovers, (ctx): Leftovers => {
  const look = lookForLeftovers(ctx.loaded.config.storage.root);
  if (!look.available) return { available: false, message: look.reason, systems: [] };
  const systems = look.systems.map((s) => ({
    id: s.id,
    kind: safeText(s.kind),
    state: safeText(s.state),
    since: s.since,
  }));
  return {
    available: true,
    message: systems.length
      ? plural(systems.length, 'HCS system') + ' of ours left running.'
      : 'No HCS system of ours is running.',
    systems,
  };
});

export const cleanEngineRun = implement(cleanEngine, async (ctx, _input, io) => {
  const root = ctx.loaded.config.storage.root;
  const look = lookForLeftovers(root);
  if (!look.available) return { available: false, stopped: 0, failed: 0, message: look.reason + NOT_AVAILABLE };
  if (!look.systems.length)
    return { available: true, stopped: 0, failed: 0, message: 'No HCS system of ours is running. Nothing to clean.' };
  const yes = await io.confirm({
    title: 'Stop ' + plural(look.systems.length, 'HCS system') + '?',
    lines: [
      ...look.systems.map((s) => s.id + '  (' + safeText(s.kind) + ', ' + safeText(s.state) + ')'),
      'They hold memory until stopped. Nothing is deleted.',
    ],
    yes: 'Stop them',
    danger: true,
  });
  if (!yes) cancelled();
  io.progress('Stopping HCS systems');
  const results = stopLeftovers(
    root,
    look.systems.map((s) => s.id),
  );
  for (const r of results)
    io.log(
      r.stopped ? 'Stopped ' + r.id : 'Could not stop ' + r.id + ': ' + safeText(r.problem ?? ''),
      r.stopped ? 'ok' : 'danger',
    );
  const stopped = results.filter((r) => r.stopped).length;
  const failed = results.length - stopped;
  if (failed)
    fail(
      plural(failed, 'HCS system') + ' could not be stopped.',
      'Run it again from an administrator terminal: sandbox engine clean',
    );
  return { available: true, stopped, failed, message: 'Stopped ' + plural(stopped, 'HCS system') + '.' };
});
