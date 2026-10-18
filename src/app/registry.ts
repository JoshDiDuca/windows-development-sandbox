// Every feature's implementation, by id (Node side; features/defs.ts is the pure half the browser uses). Surfaces run
// definitions only through here, so input and output are checked the same way everywhere.
import type { AppContext } from './context.js';
import {
  invoke,
  NO_QUESTIONS,
  onSurface,
  type AnyDefinition,
  type Implementation,
  type OperationIO,
  type OutputOf,
  type QueryDef,
  type RpcHost,
} from './kernel/index.js';
import { hideWindowRun, sandboxStatusRun, showWindowRun, stopSandboxRun } from './features/sandbox/index.js';
import { cleanEngineRun, engineLeftoversRun } from './features/engine/index.js';
import { listSessionsRun, restartSessionsRun } from './features/sessions/index.js';
import { getSettingRun, listSettingsRun, resetSettingRun, setSettingRun } from './features/settings/index.js';

export const IMPLEMENTATIONS: readonly Implementation<AnyDefinition, AppContext>[] = [
  sandboxStatusRun,
  showWindowRun,
  hideWindowRun,
  stopSandboxRun,
  listSessionsRun,
  restartSessionsRun,
  listSettingsRun,
  getSettingRun,
  setSettingRun,
  resetSettingRun,
  engineLeftoversRun,
  cleanEngineRun,
];

export function implementationOf(id: string): Implementation<AnyDefinition, AppContext> | undefined {
  return IMPLEMENTATIONS.find((i) => i.def.id === id);
}

/** Runs a definition by id: input checked before, output checked after. */
export function runDefinition(id: string, ctx: AppContext, input: unknown, io: OperationIO): Promise<unknown> {
  const impl = implementationOf(id);
  if (!impl) throw new Error('No implementation for ' + id);
  return invoke(impl, ctx, input, io);
}

/** Reads a query in-process (the menu): typed output, and no questions. */
export async function readQuery<D extends QueryDef>(
  def: D,
  ctx: AppContext,
  input: unknown = {},
): Promise<OutputOf<D>> {
  return (await runDefinition(def.id, ctx, input, NO_QUESTIONS)) as OutputOf<D>;
}

/** What the web server may run: the registered definitions whose surfaces include the web. */
export function createRpcHost(ctx: AppContext): RpcHost {
  const allowed = (id: string): Implementation<AnyDefinition, AppContext> | undefined => {
    const impl = implementationOf(id);
    return impl && onSurface(impl.def, 'web') ? impl : undefined;
  };
  return {
    kind: (id) => allowed(id)?.def.kind,
    liveMs: (id) => {
      const def = allowed(id)?.def;
      return def?.kind === 'query' ? def.live?.everyMs : undefined;
    },
    run: (id, input, io) => {
      const impl = allowed(id);
      if (!impl) throw new Error('Not allowed on the web: ' + id);
      return invoke(impl, ctx, input, io);
    },
  };
}
