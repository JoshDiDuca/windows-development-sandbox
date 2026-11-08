// `npm run install:global`: installs this checkout globally as a COPY (packed tarball), not a link.
// That is what makes it safe to develop agent-sandbox inside its own sandbox: the agent edits this repository, but the
// sandbox command you run is a frozen copy, and the agent's changes only reach your PC when you run this script again.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A managed install (the installer's, in Program Files or your profile) is what updates itself. An npm copy goes first
// on the PATH and hides it, so it needs --force.
const managedFolders = [process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean)
  .map((base) => path.join(base, 'WindowsDevelopmentSandbox'))
  .filter((root) => fs.existsSync(path.join(root, 'active-version')) || fs.existsSync(path.join(root, 'install.json')));
const force = process.argv.includes('--force');
if (managedFolders.length && !force) {
  console.error('Not installing: this PC has a managed install in ' + managedFolders.join(' and ') + '.');
  console.error(
    'A global npm copy would run instead of it (its folder comes first on the PATH), the installed one would',
  );
  console.error('stop getting updates, and fixes made there would not be the ones you run.');
  console.error('To test this checkout anyway: npm run install:global -- --force');
  process.exit(1);
}
const out = path.resolve('.pack');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
execSync('npm pack --silent --pack-destination "' + out + '"', { stdio: ['ignore', 'ignore', 'inherit'] });
const tarball = fs.readdirSync(out).find((f) => f.endsWith('.tgz'));
if (!tarball) throw new Error('npm pack did not produce a package in ' + out);
// The package used to be called agent-sandbox; both ship the same commands, so npm refuses to install over it.
const globals = JSON.parse(execSync('npm ls -g --depth=0 --json', { encoding: 'utf8' }) || '{}').dependencies ?? {};
if (globals['agent-sandbox']) {
  console.log('Removing the old agent-sandbox package (now windows-development-sandbox) ...');
  execSync('npm uninstall -g agent-sandbox', { stdio: 'inherit' });
}
// A background watcher left by an older version holds files npm must replace; stopped only when no sandbox runs.
const stopLeftoverWatchers = [
  "if (-not (Get-Process -Name 'WindowsSandbox*' -ErrorAction SilentlyContinue)) {",
  "  Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '(windows-development-sandbox|agent-sandbox).*\\s_watch(\\s|$)' } |",
  "    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'Stopped a leftover background watcher (process ' + $_.ProcessId + ').' } }",
].join('\n');
const powershell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const encoded = Buffer.from(stopLeftoverWatchers, 'utf16le').toString('base64');
try {
  execSync('"' + powershell + '" -NoProfile -NonInteractive -EncodedCommand ' + encoded, { stdio: 'inherit' });
} catch {
  /* nothing to stop */
}
execSync('npm install -g "' + path.join(out, tarball) + '" --no-fund --no-audit', { stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
if (managedFolders.length) {
  console.log('\nThe copy now hides the installed one (' + managedFolders.join(', ') + ').');
  console.log('Undo it with: npm uninstall -g windows-development-sandbox');
  console.log('sandbox doctor lists every copy on the PATH and says which one runs.');
}
console.log('\nInstalled ' + tarball + ' globally as a copy. Review what changed before you run this again.');
