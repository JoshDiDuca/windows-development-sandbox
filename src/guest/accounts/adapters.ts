// Every kind's sandbox side (adapter.ts says what each part does).
import type { ServiceKind } from '../../shared/accounts/index.js';
import type { GuestAdapter } from './adapter.js';
import { appstoreAdapter } from './kinds/appstore.js';
import { cfxAdapter } from './kinds/cfx.js';
import { cometAdapter } from './kinds/comet.js';
import { epicAdapter } from './kinds/epic.js';
import { expoAdapter } from './kinds/expo.js';
import { keystoreAdapter } from './kinds/keystore.js';
import { perplexityAdapter } from './kinds/perplexity.js';
import { perplexityAppAdapter } from './kinds/perplexityapp.js';
import { playAdapter } from './kinds/play.js';
import { steamAdapter } from './kinds/steam.js';
import { unityAdapter } from './kinds/unity.js';

export const ADAPTERS: { readonly [K in ServiceKind]: GuestAdapter<K> } = {
  epic: epicAdapter,
  steam: steamAdapter,
  unity: unityAdapter,
  cfx: cfxAdapter,
  keystore: keystoreAdapter,
  play: playAdapter,
  expo: expoAdapter,
  appstore: appstoreAdapter,
  perplexity: perplexityAdapter,
  comet: cometAdapter,
  perplexityapp: perplexityAppAdapter,
};
