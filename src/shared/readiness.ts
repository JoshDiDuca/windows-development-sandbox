// What is not written yet, so no menu, web page or "auto" decision offers it. Each package that lands deletes its own
// entries here (the end of round 2 leaves it empty). Pure.

export const NOT_READY = {
  /** Toolchains whose step is a stub: their settings rows are hidden and "auto" never turns them on. */
  toolchains: ['godot', 'android', 'flutter', 'dart', 'reactNative'],
  /** Service sign-ins whose host or guest side is a stub: the menu and the web do not list them. */
  kinds: ['keystore', 'play', 'expo', 'appstore'],
} as const satisfies Record<string, readonly string[]>;

export const isToolchainReady = (name: string): boolean => !(NOT_READY.toolchains as readonly string[]).includes(name);
export const isKindReady = (kind: string): boolean => !(NOT_READY.kinds as readonly string[]).includes(kind);
