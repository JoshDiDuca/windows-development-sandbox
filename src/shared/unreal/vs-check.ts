// Whether UnrealBuildTool would find a compiler: the verdict on what sandbox\scripts\get-vs-setup.ps1 reports. UBT
// (MicrosoftPlatformSDK / VCToolChain) lists Visual Studio instances through the Setup Configuration API
// (EnumAllInstances), takes those with the MSVC x64 tools (Microsoft.VisualStudio.Component.VC.Tools.x86.x64) and a
// VC\Tools\MSVC\<version> with Hostx64\x64\cl.exe, and a Windows SDK under the KitsRoot10 the registry names with its
// headers and libraries. Unreal 5.4 and later want MSVC 14.38 or newer. Pure.
import { z } from 'zod';

export const VsSetupReportSchema = z.object({
  setupError: z.string().max(2000),
  instances: z
    .array(
      z.object({
        instanceId: z.string().max(100),
        installationPath: z.string().max(400),
        installationVersion: z.string().max(60),
        productId: z.string().max(200),
        isComplete: z.boolean(),
        isLaunchable: z.boolean(),
        packages: z.array(z.string().max(200)).max(50),
        toolchains: z.array(z.object({ version: z.string().max(40), cl: z.boolean(), link: z.boolean() })).max(50),
      }),
    )
    .max(20),
  kitsRoots: z.array(z.object({ where: z.string().max(40), path: z.string().max(400) })).max(10),
  sdks: z
    .array(
      z.object({
        version: z.string().max(40),
        root: z.string().max(400),
        windowsH: z.boolean(),
        kernel32: z.boolean(),
        ucrt: z.boolean(),
      }),
    )
    .max(50),
});
export type VsSetupReport = z.output<typeof VsSetupReportSchema>;

/** The oldest MSVC Unreal 5.4+ builds with. */
export const MIN_MSVC = [14, 38] as const;

const parts = (v: string): number[] => v.split('.').map((p) => parseInt(p, 10) || 0);
const newer = (a: string, b: string): number => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

export interface VsVerdict {
  readonly ok: boolean;
  readonly text: string;
}

/** What UnrealBuildTool would find, in plain words. */
export function vsVerdict(r: VsSetupReport): VsVerdict {
  if (r.setupError) return { ok: false, text: 'the Setup Configuration API failed: ' + r.setupError.slice(0, 300) };
  const usable = r.instances.filter(
    (i) => i.isComplete && i.packages.includes('Microsoft.VisualStudio.Component.VC.Tools.x86.x64'),
  );
  if (!usable.length)
    return {
      ok: false,
      text: r.instances.length
        ? 'Visual Studio is listed, but no complete instance has the C++ x64 tools'
        : 'the Setup Configuration API lists no Visual Studio',
    };
  const tools = usable
    .flatMap((i) => i.toolchains.filter((t) => t.cl && t.link).map((t) => ({ i, t })))
    .sort((a, b) => newer(b.t.version, a.t.version));
  const best = tools[0];
  if (!best) return { ok: false, text: 'Visual Studio has no MSVC with the x64 compiler (VC\\Tools\\MSVC)' };
  const [major, minor] = parts(best.t.version);
  const oldMsvc = major < MIN_MSVC[0] || (major === MIN_MSVC[0] && minor < MIN_MSVC[1]);
  const sdk = r.sdks.filter((s) => s.windowsH && s.kernel32 && s.ucrt).sort((a, b) => newer(b.version, a.version))[0];
  const where = 'Visual Studio ' + best.i.installationVersion + ' at ' + best.i.installationPath;
  if (!sdk) return { ok: false, text: where + ', MSVC ' + best.t.version + ', but no complete Windows SDK' };
  return {
    ok: !oldMsvc,
    text:
      where +
      ', MSVC ' +
      best.t.version +
      (oldMsvc ? ' (too old: Unreal 5.4 and later need 14.38 or newer)' : '') +
      ', Windows SDK ' +
      sdk.version +
      ' at ' +
      sdk.root,
  };
}
