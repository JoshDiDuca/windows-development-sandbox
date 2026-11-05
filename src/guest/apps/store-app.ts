// A Microsoft Store app in the sandbox: the PC put its package files in the data folder (toolsapps<id>.package,
// with store-package.json). Windows in the sandbox is new on every boot, so the app is installed again each boot with
// Add-AppxPackage (sandbox\scripts\install-store-package.ps1), from the package kept on the data disk. The files are
// checked against the manifest's SHA-256 first (store-check.ts). Windows checks the publisher's signature itself.
import { runScriptWithJsonAsync } from '../runtime/process.js';
import { tool } from '../toolchains/tool-env.js';
import { checkedPackage } from './store-check.js';

/** Where the PC left an app's package. */
export function storePackageDir(appId: string): string {
  return tool('apps', appId + '.package');
}

/** Installs the app from its kept package; resolves when Windows has it. */
export async function installStoreApp(appId: string, packageName: string): Promise<void> {
  const { main, dependencies } = await checkedPackage(storePackageDir(appId));
  await runScriptWithJsonAsync('install-store-package.ps1', 'ListFile', { main, dependencies }, [
    '-PackageName',
    packageName,
  ]);
}
