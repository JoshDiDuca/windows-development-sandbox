// Service sign-ins a sandbox can keep (accounts.<kind>.share): what each one is, which toolchains use it, where it can
// come from, and the rules for handing it over (one sandbox at a time, handed back when renewed). Pure, web-safe: no
// Node built-ins. The payload shapes are in payloads.ts, the host side in host/accounts, the sandbox side in
// guest/accounts.

export const SERVICE_KINDS = ['epic', 'steam', 'unity', 'cfx', 'keystore', 'play', 'expo', 'appstore'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** The toolchains a sign-in serves (it is handed over only when one of them is on for the boot). */
export type UsedBy =
  'unreal' | 'steam' | 'unity' | 'fivem' | 'android' | 'flutter' | 'reactNative' | 'godot' | 'dotnet';
export const USED_BY: readonly UsedBy[] = [
  'unreal',
  'steam',
  'unity',
  'fivem',
  'android',
  'flutter',
  'reactNative',
  'godot',
  'dotnet',
];

/** Where a saved sign-in came from: this PC's program, a file you gave, values you typed, or a sandbox. */
export type AccountSource = 'pc' | 'file' | 'typed' | 'sandbox';
export const ACCOUNT_SOURCES: readonly AccountSource[] = ['pc', 'file', 'typed', 'sandbox'];

/** One value `sandbox account login` asks for (or `import --from` needs besides the file). */
export interface ServiceField {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly optional?: boolean;
  readonly pattern?: RegExp;
}

export interface ServiceSpec<K extends ServiceKind = ServiceKind> {
  readonly kind: K;
  readonly label: string;
  /** Handed over only when one of these is on for this boot. */
  readonly usedBy: readonly UsedBy[];
  readonly sources: readonly AccountSource[];
  /** Works in one sandbox at a time (a lease on this PC). */
  readonly singleHolder: boolean;
  /** The sandbox may hand a renewed one back. */
  readonly returns: boolean;
  /** The largest payload (its JSON) accepted from a file or a sandbox. */
  readonly maxBytes: number;
  /** Shown on every surface. */
  readonly warnings: readonly string[];
  /** What `login` asks for, or what `import --from` needs besides the file. */
  readonly fields: readonly ServiceField[];
}

const AGENT_CAN_USE = 'The agent in the sandbox can use this sign-in while it is there.';
const ONE_PLACE = 'It works in one sandbox at a time: a second sandbox starts without it while the first one runs.';

export const SERVICE_SPECS: { readonly [K in ServiceKind]: ServiceSpec<K> } = {
  epic: {
    kind: 'epic',
    label: 'Epic Games',
    usedBy: ['unreal'],
    sources: ['pc', 'sandbox'],
    singleHolder: true,
    returns: true,
    maxBytes: 64 * 1024,
    warnings: [
      AGENT_CAN_USE,
      "A sign-in works in one place at a time: taking this PC's signs the launcher on this PC out the first time a sandbox uses it.",
    ],
    fields: [],
  },
  steam: {
    kind: 'steam',
    label: 'Steam (SteamCMD)',
    usedBy: ['steam'],
    sources: ['file', 'sandbox'],
    singleHolder: true,
    returns: true,
    maxBytes: 768 * 1024,
    warnings: [
      AGENT_CAN_USE + ' It can upload builds and workshop items to your Steam apps.',
      ONE_PLACE,
      'No password is kept: sign in once with sbx-steam login in a sandbox (Steam Guard asks there).',
    ],
    fields: [],
  },
  unity: {
    kind: 'unity',
    label: 'Unity',
    usedBy: ['unity'],
    sources: ['pc', 'file', 'typed', 'sandbox'],
    singleHolder: true,
    returns: true,
    maxBytes: 256 * 1024,
    warnings: [
      AGENT_CAN_USE,
      ONE_PLACE,
      'A Pro seat is handed back when the sandbox stops cleanly; a sandbox closed abruptly may keep it until you return it.',
    ],
    fields: [
      { name: 'email', label: 'Unity ID email', secret: false, optional: true },
      { name: 'password', label: 'Unity ID password', secret: true, optional: true },
      { name: 'serial', label: 'Serial (Plus or Pro; empty for Personal)', secret: true, optional: true },
    ],
  },
  cfx: {
    kind: 'cfx',
    label: 'Cfx.re (FiveM / RedM server key)',
    usedBy: ['fivem'],
    sources: ['typed'],
    singleHolder: false,
    returns: false,
    maxBytes: 4 * 1024,
    warnings: [AGENT_CAN_USE + ' Anyone with the key can run a server under your Cfx.re account.'],
    fields: [
      { name: 'licenseKey', label: 'Server licence key (cfxk_...)', secret: true, pattern: /^cfxk_[A-Za-z0-9_]+$/ },
      {
        name: 'steamWebApiKey',
        label: 'Steam Web API key (optional)',
        secret: true,
        optional: true,
        pattern: /^[A-F0-9]{32}$/,
      },
    ],
  },
  keystore: {
    kind: 'keystore',
    label: 'Android upload keystore',
    usedBy: ['android'],
    sources: ['file'],
    singleHolder: false,
    returns: false,
    maxBytes: 512 * 1024,
    warnings: [AGENT_CAN_USE + ' It can sign app updates as you; keep a backup of the keystore elsewhere.'],
    fields: [
      { name: 'storePassword', label: 'Keystore password', secret: true },
      { name: 'keyAlias', label: 'Key alias', secret: false },
      { name: 'keyPassword', label: 'Key password', secret: true },
    ],
  },
  play: {
    kind: 'play',
    label: 'Google Play (service account)',
    usedBy: ['android'],
    sources: ['file'],
    singleHolder: false,
    returns: false,
    maxBytes: 128 * 1024,
    warnings: [AGENT_CAN_USE + ' It can publish to Google Play with what the service account is allowed.'],
    fields: [],
  },
  expo: {
    kind: 'expo',
    label: 'Expo (EAS)',
    usedBy: ['reactNative'],
    sources: ['typed'],
    singleHolder: false,
    returns: false,
    maxBytes: 4 * 1024,
    warnings: [AGENT_CAN_USE + ' It can start EAS builds and submissions on your Expo account.'],
    fields: [{ name: 'token', label: 'Expo access token', secret: true }],
  },
  appstore: {
    kind: 'appstore',
    label: 'App Store Connect API key',
    usedBy: ['reactNative', 'flutter'],
    sources: ['file', 'typed'],
    singleHolder: false,
    returns: false,
    maxBytes: 16 * 1024,
    warnings: [AGENT_CAN_USE + ' It can upload and submit apps with what the key is allowed.'],
    fields: [
      { name: 'issuerId', label: 'Issuer ID', secret: false },
      { name: 'keyId', label: 'Key ID', secret: false, pattern: /^[A-Z0-9]{10}$/ },
    ],
  },
};

/** Where a sandbox leaves a renewed sign-in, under the data folder: state\accounts\<kind>.json. */
export const HANDOFF_PARTS = ['state', 'accounts'] as const;

/** The toolchains that build for Android and so want its signing keys (they turn the Android toolchain on). */
const ANDROID_USERS: readonly UsedBy[] = ['flutter', 'reactNative', 'godot', 'unity'];

export function isServiceKind(value: string): value is ServiceKind {
  return (SERVICE_KINDS as readonly string[]).includes(value);
}

/** Whether a sign-in is wanted when these toolchains are on. */
export function serviceWanted(kind: ServiceKind, on: ReadonlySet<UsedBy>): boolean {
  const spec: ServiceSpec = SERVICE_SPECS[kind];
  if (spec.usedBy.some((u) => on.has(u))) return true;
  return spec.usedBy.includes('android') && ANDROID_USERS.some((u) => on.has(u));
}
