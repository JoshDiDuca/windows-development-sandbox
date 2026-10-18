// `sandbox engine`: the engine in use and what each engine can do. The bare command is `sandbox engine show`; `check`
// is the other action. Both are definitions of the shared core (src/app/features/engine).
import { engineStatus } from '../../app/features/engine/index.js';
import { definitionHandler } from '../operations/index.js';
import type { Context } from './context.js';

export async function engine(ctx: Context): Promise<number> {
  return (await definitionHandler(engineStatus)(ctx)) ?? 0;
}
