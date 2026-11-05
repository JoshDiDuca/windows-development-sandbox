// Mesa for running OpenGL and Vulkan programs without a GPU (llvmpipe, lavapipe).
import path from 'node:path';
import type { Toolchains } from '../../../core/types.js';
import { downloader, fetchJson } from '../../../shared/download/index.js';
import { SYSTEM } from '../../../shared/system.js';
import { dryRun } from '../../runtime/paths.js';
import { execAsync, scriptOutput } from '../../runtime/process.js';
import { exists } from '../../runtime/fs.js';
import { log } from '../../runtime/log.js';
import { errMsg } from '../../../core/util/errors.js';
import { arch, tool, type ToolEnv } from '../tool-env.js';
import { installFromGithub } from '../install.js';

/**
 * Mesa 3D for Windows (llvmpipe): OpenGL 4.5 on the CPU when the sandbox has no GPU. Windows only offers OpenGL 1.1 in
 * software, and opengl32.dll cannot be replaced system-wide, so programs pick Mesa up from their own folder.
 */
export async function setupMesa(env: ToolEnv, config: Toolchains['mesa']): Promise<void> {
  if (dryRun) {
    log('(dry run) would provision Mesa 3D');
    return;
  }
  const root = tool('mesa');
  const dir = path.join(root, arch === 'arm64' ? 'arm64' : 'x64');
  if (!exists(path.join(dir, 'opengl32.dll'))) {
    await installFromGithub('pal1000/mesa-dist-win', /^mesa3d-[\d.]+-release-msvc\.7z$/, {
      dest: root,
      what: 'Mesa 3D for software OpenGL (~100 MB once)',
      locate: 'opengl32.dll',
      up: 1,
    });
  }
  Object.assign(env.vars, { MESA_DIR: dir, GALLIUM_DRIVER: 'llvmpipe' });
  env.summary.push(
    "mesa (software OpenGL 4.5): copy opengl32.dll + libgallium_wgl.dll from %MESA_DIR% next to a game's .exe",
  );
  if (config.vulkan) await setupLavapipe(env, dir);
}

/** LunarG's newest SDK version per platform ({"windows": "1.4.363.1", ...}). */
const VULKAN_LATEST = 'https://vulkan.lunarg.com/sdk/latest.json';
const runtimeUrl = (version: string): string =>
  'https://sdk.lunarg.com/sdk/download/' + version + '/windows/vulkan-runtime-components.zip';
/** Known to have the runtime zip: used when LunarG cannot be asked, or none of its versions has one. */
const VULKAN_PINNED = '1.4.363.0';

/**
 * The versions to try for the runtime zip, newest first: LunarG's latest, its x.y.z.0 (a point release such as
 * 1.4.363.1 reissues the SDK without the runtime zip), then the pinned one.
 */
async function runtimeVersions(): Promise<string[]> {
  let latest: string | null = null;
  try {
    const value = (await fetchJson<Record<string, unknown>>(VULKAN_LATEST)).windows;
    if (typeof value === 'string' && /^\d{1,2}\.\d{1,2}\.\d{1,4}\.\d{1,3}$/.test(value)) latest = value;
  } catch {
    // LunarG not reachable: the pinned version.
  }
  const found = latest ? [latest, latest.replace(/\.\d+$/, '.0')] : [];
  return [...new Set([...found, VULKAN_PINNED])];
}

/**
 * Software Vulkan: Mesa's lavapipe plus the Khronos loader (vulkan-1.dll, from LunarG's runtime components; Windows
 * Sandbox has no Vulkan loader). The loader ignores VK_DRIVER_FILES in elevated processes, and everything in the
 * sandbox runs elevated, so lavapipe is registered where the loader looks (HKLM; the registry is new every boot).
 */
const setupLavapipe = async (env: ToolEnv, mesaDir: string): Promise<void> => {
  const icd = path.join(mesaDir, arch === 'arm64' ? 'lvp_icd.aarch64.json' : 'lvp_icd.x86_64.json');
  if (!exists(icd)) throw new Error('this Mesa build has no lavapipe (' + path.basename(icd) + ')');
  const dir = tool('vulkan');
  // vulkaninfo.exe too: a copy kept from an older runtime zip may lack it.
  if (!exists(path.join(dir, 'vulkan-1.dll')) || !exists(path.join(dir, 'vulkaninfo.exe'))) {
    log('Downloading the Vulkan loader (~20 MB once) ...');
    // LunarG publishes no checksum for this zip; it comes over HTTPS from LunarG, the Khronos SDK's maintainer.
    // The zip has x86 and x64 folders: only the 64-bit loader (and vulkaninfo) is extracted.
    const fetchRuntime = (url: string): Promise<void> =>
      downloader.archive(url, dir, { locate: 'vulkan-1.dll', fileName: 'vulkan-runtime.zip', members: ['*/x64/*'] });
    const versions = await runtimeVersions();
    for (const [n, version] of versions.entries()) {
      try {
        await fetchRuntime(runtimeUrl(version));
        log('Vulkan loader ' + version + ' installed');
        break;
      } catch (e) {
        if (n === versions.length - 1) throw new Error('the Vulkan loader could not be downloaded (' + errMsg(e) + ')');
      }
    }
  }
  const register = (file: string): Promise<void> =>
    execAsync(
      SYSTEM.reg(),
      ['add', 'HKLM\\SOFTWARE\\Khronos\\Vulkan\\Drivers', '/v', file, '/t', 'REG_DWORD', '/d', '0', '/f'],
      { stdio: 'ignore' },
    );
  await register(icd);
  // sandbox.vGpu: the sandbox sees this PC's GPU through Direct3D 12, and Dozen runs Vulkan on it. Programs prefer it
  // over lavapipe (a GPU before a CPU device); lavapipe stays for the ones that need it.
  const dozen = path.join(mesaDir, arch === 'arm64' ? 'dzn_icd.aarch64.json' : 'dzn_icd.x86_64.json');
  const gpu = hasGpu();
  if (gpu && exists(dozen)) await register(dozen);
  env.prepend.push(dir);
  env.summary.push(
    'vulkan: ' +
      (gpu && exists(dozen) ? 'Dozen (Vulkan on the GPU via Direct3D 12) and ' : '') +
      'lavapipe (software Vulkan 1.4 on the CPU), vulkaninfo on PATH; WGPU_BACKEND=vulkan for wgpu',
  );
};

/** A real display adapter (sandbox.vGpu on), not only the remote display or basic render driver. */
const hasGpu = (): boolean =>
  scriptOutput('get-gpu-names.ps1', [], { timeout: 30000 })
    .split(/\r?\n/)
    .map((n) => n.trim())
    .some((n) => n && !/^Microsoft (Remote Display|Basic (Render|Display))/i.test(n));
