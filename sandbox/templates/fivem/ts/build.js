// Bundles src/client and src/server into dist/client.js and dist/server.js, the files fxmanifest.lua loads.
// `node build.js --watch` rebuilds on every change (then `restart {{name}}` in the server console).
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
const builds = [
  { entryPoints: ['src/client/client.ts'], outfile: 'dist/client.js', platform: 'browser', target: 'es2020' },
  { entryPoints: ['src/server/server.ts'], outfile: 'dist/server.js', platform: 'node', target: 'node16' },
];

(async () => {
  for (const b of builds) {
    const options = { ...b, bundle: true, format: 'iife', logLevel: 'info' };
    if (watch) await (await esbuild.context(options)).watch();
    else await esbuild.build(options);
  }
})().catch(() => process.exit(1));
