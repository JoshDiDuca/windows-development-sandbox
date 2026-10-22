// Bundles each sandbox entry point into one self-contained file (dist/runtime/*.js) with its dependencies (zod, ...),
// so the launch folder needs no node_modules. Run after tsc (npm run build does both).
//
// The commands (dist/bin/*.js) are bundled too, over what tsc wrote there: loading the CLI as ~900 separate modules
// took most of a second before the menu could draw (each one is looked up, read and compiled on its own), one bundle
// takes a fraction of that. The bundles stay in dist/bin, two folders below package.json like every compiled file, so
// the package root (core/package-info) and the sandbox\ folder (shared/scripts) are found the same way. The self-test
// is not bundled: `self-test` loads the compiled dist/selftest as before.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // ES module builds first: jsonc-parser's default (UMD) build loads its parts with require() calls esbuild cannot follow.
  mainFields: ['module', 'main'],
  // CommonJS dependencies bundled into ESM may call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: ['main', 'daemon', 'view', 'gitguard', 'db', 'netproxy', 'agent'].map(
    (name) => 'src/guest/entries/' + name + '.ts',
  ),
  outdir: 'dist/runtime',
});

/** `self-test` imports the compiled self-test (dist/selftest/index.js, next to dist/bin) instead of bundling it. */
const selfTestOutside = {
  name: 'self-test-outside',
  setup(b) {
    b.onResolve({ filter: /[\\/]selftest[\\/]index\.js$/ }, () => ({ path: '../selftest/index.js', external: true }));
  },
};

const bins = fs.readdirSync('src/bin').filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
// Chunks of an earlier build (their names carry a hash) would pile up.
for (const old of fs.existsSync('dist/bin') ? fs.readdirSync('dist/bin') : [])
  if (/^chunk-.*\.js$/.test(old)) fs.rmSync(path.join('dist/bin', old));
await build({
  ...shared,
  entryPoints: bins.map((f) => 'src/bin/' + f),
  outdir: 'dist/bin',
  // The commands share one chunk with the CLI in it.
  splitting: true,
  chunkNames: 'chunk-[hash]',
  // ws loads these optional speed-ups only when they are installed.
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [selfTestOutside],
});
