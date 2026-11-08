// Service sign-ins a sandbox can keep (accounts.<kind>.share): what each one is, which toolchains use it, where it can
// come from, and the rules for handing it over (one sandbox at a time, handed back when renewed). Pure, web-safe: no
// Node built-ins. The payload shapes are in payloads.ts, the host side in host/accounts, the sandbox side in
// guest/accounts.

export const SERVICE_KINDS = [
  'epic',
  'steam',
  'unity',
  'cfx',
  'keystore',
  'play',
  'expo',
  'appstore',
  'perplexity',
  'comet',
  'perplexityapp',
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** The toolchains a sign-in can serve (each is a key of `toolchains`). */
export type ToolchainUser =
  'unreal' | 'steam' | 'unity' | 'fivem' | 'android' | 'flutter' | 'reactNative' | 'godot' | 'dotnet';
/** The apps a sign-in can serve: on when one of APP_USERS' apps is in apps.install. */
export type AppUser = 'perplexity' | 'comet' | 'perplexityapp';
/** What a sign-in serves (it is handed over only when one of them is on for the boot). */
export type UsedBy = ToolchainUser | AppUser;
/** The toolchains a sign-in can serve. */
export const USED_BY: readonly ToolchainUser[] = [
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
/** The apps (apps.install ids) that turn each app user on. */
export const APP_USERS: { readonly [U in AppUser]: readonly string[] } = {
  perplexity: ['perplexity-mcp'],
  comet: ['comet'],
  perplexityapp: ['perplexity-desktop'],
};

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
  /** Asked only by `login` (typed) or only by `import --from` (file); both when not set. */
  readonly only?: 'typed' | 'file';
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
  /** The largest file `import --from` reads, when it holds more than the payload (a .env file); default maxBytes. */
  readonly maxFileBytes?: number;
  /** Shown on every surface. */
  readonly warnings: readonly string[];
  /** What `login` asks for, or what `import --from` needs besides the file. */
  readonly fields: readonly ServiceField[];
}

const AGENT_CAN_USE = 'The agent in the sandbox can use this sign-in while it is there.';
const ONE_PLACE = 'It works in one sandbox at a time: a second sandbox starts without it while the first one runs.';
/** A Perplexity API key: pplx- and its body. */
export const PERPLEXITY_KEY_PATTERN = /^pplx-[A-Za-z0-9_-]{8,200}$/;

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
    label: 'Steam',
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
      'Unity Personal is activated by signing in: sign in to Unity once in a sandbox and the licence it makes is kept for the next ones (if Unity refuses it there, sign in again).',
      'A Plus or Pro serial is activated in each sandbox and handed back when the sandbox stops cleanly; a sandbox closed abruptly may keep the seat until you remove it at id.unity.com (My Seats).',
      'A licence file taken from this PC may not work in a sandbox: Unity ties it to the computer.',
    ],
    fields: [
      { name: 'email', label: 'Unity ID email', secret: false, optional: true },
      { name: 'password', label: 'Unity ID password', secret: true, optional: true },
      { name: 'serial', label: 'Serial (Plus or Pro; empty for Personal)', secret: true, optional: true },
    ],
  },
  cfx: {
    kind: 'cfx',
    label: 'FiveM key',
    usedBy: ['fivem'],
    sources: ['typed', 'file'],
    singleHolder: false,
    returns: false,
    // `import cfx --from` reads a whole server.cfg (they often run to tens of KB); the payload itself is tiny.
    maxBytes: 4 * 1024,
    maxFileBytes: 256 * 1024,
    warnings: [AGENT_CAN_USE + ' Anyone with the key can run a server under your Cfx.re account.'],
    fields: [
      {
        name: 'licenseKey',
        label: 'Server licence key (cfxk_...)',
        secret: true,
        pattern: /^cfxk_[A-Za-z0-9_]+$/,
        only: 'typed',
      },
      {
        name: 'steamWebApiKey',
        label: 'Steam Web API key (optional)',
        secret: true,
        optional: true,
        pattern: /^[A-F0-9]{32}$/,
        only: 'typed',
      },
    ],
  },
  keystore: {
    kind: 'keystore',
    label: 'Android keystore',
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
    label: 'Google Play',
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
    label: 'Expo',
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
    label: 'App Store Connect',
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
  perplexity: {
    kind: 'perplexity',
    label: 'Perplexity API',
    usedBy: ['perplexity'],
    sources: ['pc', 'file', 'typed'],
    singleHolder: false,
    returns: false,
    maxBytes: 1024,
    maxFileBytes: 64 * 1024,
    warnings: [
      AGENT_CAN_USE + ' It can read the key and spend your API credit: use a separate API key with a spending limit.',
      'Perplexity Pro does not include API use; the API key is billed separately.',
      'Only the variable PERPLEXITY_API_KEY of the agent gets it: nothing in the sandbox writes it to a file.',
    ],
    fields: [
      {
        name: 'apiKey',
        label: 'Perplexity API key (pplx-...)',
        secret: true,
        pattern: PERPLEXITY_KEY_PATTERN,
        only: 'typed',
      },
    ],
  },
  comet: {
    kind: 'comet',
    label: 'Comet',
    usedBy: ['comet'],
    sources: ['sandbox'],
    singleHolder: false,
    returns: true,
    maxBytes: 256 * 1024,
    warnings: [
      AGENT_CAN_USE +
        ' It can act as you in Comet and spend your Perplexity Computer credits; agentic browsing is open to prompt injection from the pages it reads.',
      "Your Comet sign-in can't be copied from this PC: Windows locks it to your PC account. Sign in once inside a sandbox and it is kept for the next ones.",
      'Only the perplexity.ai sign-in cookies are kept: never saved passwords, other sites, localStorage or history. Never import your main browser profile.',
      'Several sandboxes can use it at once: the sign-in the last one hands back is kept.',
    ],
    fields: [],
  },
  perplexityapp: {
    kind: 'perplexityapp',
    label: 'Perplexity app',
    usedBy: ['perplexityapp'],
    sources: ['sandbox'],
    singleHolder: false,
    returns: true,
    maxBytes: 256 * 1024,
    warnings: [
      AGENT_CAN_USE +
        ' It can act as you in the Perplexity app and spend your Perplexity Computer credits; the app acts on the pages it reads, which can try to steer it.',
      "Your sign-in in the Perplexity app can't be copied from this PC: Windows locks it to your PC account. Sign in once inside a sandbox and it is kept for the next ones.",
      'Only the perplexity.ai sign-in cookies are kept: never saved passwords, other sites, localStorage or history.',
      'Several sandboxes can use it at once: the sign-in the last one hands back is kept.',
    ],
    fields: [],
  },
};

/** Where a sandbox leaves a renewed sign-in, under the data folder: state\accounts\<kind>.json. */
export const HANDOFF_PARTS = ['state', 'accounts'] as const;

/** The toolchains that build for Android and so want its signing keys (they turn the Android toolchain on). */
const ANDROID_USERS: readonly UsedBy[] = ['flutter', 'reactNative', 'godot', 'unity'];

export function isServiceKind(value: string): value is ServiceKind {
  return (SERVICE_KINDS as readonly string[]).includes(value);
}

/** How the apps that use a sign-in are named in sentences ("for sandboxes that use ..."). */
const APP_USER_TEXT: { readonly [U in AppUser]: string } = {
  perplexity: 'the Perplexity MCP app',
  comet: 'the Comet app',
  perplexityapp: 'the Perplexity desktop app',
};

/** What a sign-in serves, for a sentence: "unreal", "reactNative or flutter", "the Comet app". */
export function usedByText(usedBy: readonly string[]): string {
  return usedBy.map((u) => (u in APP_USER_TEXT ? APP_USER_TEXT[u as AppUser] : u)).join(' or ');
}

/** The app users that the chosen apps (apps.install) turn on. */
export function appUsersOn(install: readonly string[]): AppUser[] {
  return (Object.keys(APP_USERS) as AppUser[]).filter((u) => APP_USERS[u].some((id) => install.includes(id)));
}

/** Whether a sign-in is wanted when these toolchains (and apps) are on. */
export function serviceWanted(kind: ServiceKind, on: ReadonlySet<UsedBy>): boolean {
  const spec: ServiceSpec = SERVICE_SPECS[kind];
  if (spec.usedBy.some((u) => on.has(u))) return true;
  return spec.usedBy.includes('android') && ANDROID_USERS.some((u) => on.has(u));
}

/**
 * For a sign-in that only apps use (Perplexity API, Comet, the Perplexity app): the apps.install ids to turn on for it
 * to be handed over; empty for a kind a toolchain uses. A sign-in shared with its app off would otherwise do nothing.
 */
export function appsNeededFor(kind: ServiceKind): string[] {
  const { usedBy } = SERVICE_SPECS[kind];
  return usedBy.every((u) => u in APP_USERS) ? usedBy.flatMap((u) => [...APP_USERS[u as AppUser]]) : [];
}
