// Dart (toolchains.dart): the SDK from dart-archive with its .sha256sum. Not available yet.
import type { Toolchains } from '../../../core/types.js';
import { notAvailableYet } from '../not-yet.js';
import type { ToolCtx } from '../step.js';
import type { ToolEnv } from '../tool-env.js';

export async function setupDart(env: ToolEnv, _config: Toolchains['dart'], _ctx: ToolCtx): Promise<void> {
  notAvailableYet(env, 'Dart');
}
