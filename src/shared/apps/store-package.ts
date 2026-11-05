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
