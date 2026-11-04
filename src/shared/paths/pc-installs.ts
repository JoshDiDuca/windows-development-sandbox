// Read-only installs of this PC (pcInstalls: Steam and Epic games, Unreal engines, Unity editors) as the sandbox sees
// them: each one under C:\PcInstalls, which no other mapping may use. Pure: the host places them, the sandbox reads
// the manifest (paths only) from session.json.

/** Where this PC's installs appear in the sandbox (reserved: RESERVED_GUEST). */
export const PC_INSTALLS_GUEST = 'C:\\PcInstalls';

export type PcInstallKind = 'steam-game' | 'steam-library' | 'epic-game' | 'unreal' | 'unity';

export interface PcInstall {
  readonly kind: PcInstallKind;
  /** The Steam app ID or library (library1), the Epic app name, the engine (UE_5.4) or editor version. */
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  /** The folder on this PC (never sent to the sandbox). */
  readonly host: string;
  /** Where it appears in the sandbox, read-only unless `writable`. */
  readonly guest: string;
  /** Mapped writable: an engine folder you registered (pcInstalls.unrealEngineFolders). */
  readonly writable?: boolean;
  /** An Unreal source build's registered name on this PC (HKCU\Software\Epic Games\Unreal Engine\Builds). */
  readonly buildId?: string;
  /** The Epic Games Launcher's own ids of the app (from this PC's LauncherInstalled.dat). */
  readonly launcher?: {
    readonly namespaceId: string;
    readonly itemId: string;
    readonly artifactId: string;
    readonly appVersion: string;
  };
}

/** What session.json says about them: no host paths. */
export interface PcInstallManifest {
  readonly items: readonly Omit<PcInstall, 'host'>[];
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;
const AREA: Readonly<Record<PcInstallKind, string>> = {
  'steam-game': 'steam',
  'steam-library': 'steam',
  'epic-game': 'epic',
  unreal: 'unreal',
  unity: 'unity',
};

/** The guest folder of one install: C:\PcInstalls\steam\<appid>, \epic\<AppName>, \unreal\UE_5.4, \unity\<ver>. */
export function pcInstallGuest(kind: PcInstallKind, id: string): string {
  if (!SAFE_ID.test(id) || /^\.+$/.test(id)) throw new Error('not a usable install id: ' + id);
  return PC_INSTALLS_GUEST + '\\' + AREA[kind] + '\\' + id;
}
