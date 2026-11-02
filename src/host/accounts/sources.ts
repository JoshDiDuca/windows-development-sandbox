// Every kind's way onto this PC's store (source.ts says what each part does).
import type { ServiceKind } from '../../shared/accounts/index.js';
import { appstoreSource } from './kinds/appstore.js';
import { cfxSource } from './kinds/cfx.js';
import { epicSource } from './kinds/epic.js';
import { expoSource } from './kinds/expo.js';
import { keystoreSource } from './kinds/keystore.js';
import { playSource } from './kinds/play.js';
import { steamSource } from './kinds/steam.js';
import { unitySource } from './kinds/unity.js';
import type { HostSource } from './source.js';

export const HOST_SOURCES: { readonly [K in ServiceKind]: HostSource<K> } = {
  epic: epicSource,
  steam: steamSource,
  unity: unitySource,
  cfx: cfxSource,
  keystore: keystoreSource,
  play: playSource,
  expo: expoSource,
  appstore: appstoreSource,
};
