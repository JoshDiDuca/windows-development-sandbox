// A Microsoft Store app handed to the sandbox as package files (.msix and its dependencies). The PC fetches them with
// its own Store tooling (host/apps/store-package.ts) and the sandbox installs them with Add-AppxPackage.
// Pure, web-safe: the shape of the manifest that travels with the files, and which file is the app itself.
import { z } from 'zod';

const GB = 1024 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9._~+-]{1,200}\.(msix|appx|msixbundle|appxbundle)$/i;

export const StorePackageFileSchema = z.strictObject({
  name: z.string().regex(FILE_NAME),
  role: z.enum(['main', 'dependency']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z
    .number()
    .int()
    .positive()
    .max(2 * GB),
});
export type StorePackageFile = z.output<typeof StorePackageFileSchema>;

/** store-package.json: next to the package files, on this PC's cache and in the sandbox's data folder. */
export const StorePackageManifestSchema = z
  .strictObject({
    productId: z.string().regex(/^[A-Z0-9]{12}$/),
    fetchedAt: z.string().max(40),
    files: z.array(StorePackageFileSchema).min(1).max(24),
  })
  .refine((m) => m.files.filter((f) => f.role === 'main').length === 1, 'exactly one file must be the app itself')
  .refine((m) => new Set(m.files.map((f) => f.name.toLowerCase())).size === m.files.length, 'file names repeat');
export type StorePackageManifest = z.output<typeof StorePackageManifestSchema>;

export const STORE_PACKAGE_MANIFEST = 'store-package.json';

/** Whether a file name is a package file this feature handles. */
export function isStorePackageFile(name: string): boolean {
  return FILE_NAME.test(name);
}

/** The app itself (named <package name>_<version>_...), as opposed to a framework it depends on (VCLibs ...). */
export function storePackageRole(fileName: string, packageName: string): 'main' | 'dependency' {
  return fileName.toLowerCase().startsWith(packageName.toLowerCase() + '_') ? 'main' : 'dependency';
}

/**
 * Whether a dependency package suits this sandbox (64-bit Windows): winget may also fetch the 32-bit and ARM builds
 * of a framework, and Add-AppxPackage is only handed the builds that can run here.
 */
export function storePackageFitsX64(fileName: string): boolean {
  return !/[_.-](x86|arm|arm64)(?=[_.-]|$)/i.test(fileName.replace(/\.(msix|appx|msixbundle|appxbundle)$/i, ''));
}

/**
 * Which fetched file is the app and which are its frameworks. The app is named after its package; when winget names
 * it otherwise, the one file that did not come from the Dependencies folder is the app. Throws when that is unclear.
 */
export function assignStoreRoles(
  names: readonly string[],
  packageName: string,
  dependencyNames: readonly string[],
): { name: string; role: 'main' | 'dependency' }[] {
  const listed = new Set(dependencyNames.map((n) => n.toLowerCase()));
  let mains = names.filter((n) => storePackageRole(n, packageName) === 'main');
  if (mains.length === 0) mains = names.filter((n) => !listed.has(n.toLowerCase()));
  if (mains.length > 1) mains = mains.filter(storePackageFitsX64);
  if (mains.length !== 1)
    throw new Error(
      mains.length === 0
        ? 'winget gave only frameworks, not the app itself (' + names.join(', ') + ')'
        : 'winget gave more than one app package and it is not clear which to install (' + mains.join(', ') + ')',
    );
  return names.map((name) => ({ name, role: name === mains[0] ? 'main' : 'dependency' }));
}
