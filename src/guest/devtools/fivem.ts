// sbx-fivem: start the FiveM / RedM server (plain or with txAdmin), make a server folder or a new resource, pick a
// server build, get the natives list. The Cfx.re key reaches FXServer only through +exec of its cfg on the sandbox's
// own disk; it is never written into the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloader, spawnAsync } from '../../shared/download/index.js';
import { errMsg } from '../../core/util/errors.js';
import { toolsDir } from '../runtime/paths.js';
import { runScript } from '../runtime/process.js';
import { portOpen } from '../runtime/ports.js';
import { session } from '../runtime/session.js';
import { fetchChannels, CHANNELS } from '../toolchains/fivem/artifacts.js';
import {
  artifactDir,
  rememberArtifact,
  chosenArtifact,
  installArtifact,
  installedBuilds,
  resolveArtifact,
  secretsCfg,
  servingBuildDir,
  txDataDir,
} from '../toolchains/fivem/fivem.js';
import {
  fivemTemplatesDir,
  initServerFolder,
  resourceHome,
  RESOURCE_LANGS,
  scaffoldResource,
  withEnsure,
  type FivemGame,
  type ResourceLang,
} from '../toolchains/fivem/scaffold.js';
import { GAME_PORT, servePlan, TXADMIN_PORT } from '../toolchains/fivem/serve-plan.js';
import type { DevTool } from './devtool.js';

const USAGE = [
  'Usage:',
  '  sbx-fivem serve [--txadmin | --no-txadmin] [--dir <server folder>]   start the server (default: this folder)',
  '  sbx-fivem init [--dir <folder>]                    a server.cfg (no keys in it) and resources\\[local]',
  '  sbx-fivem new <name> --lua | --js | --ts | --cs [--dir <folder>]   a new resource',
  '  sbx-fivem artifact list                            server builds: recommended, latest ..., and the installed ones',
  '  sbx-fivem artifact use <recommended|optional|latest|build>   install a build and use it from now on',
  '  sbx-fivem natives                                  download the natives list (JSON) for the game',
].join('\n');

const NATIVES: Record<FivemGame, readonly string[]> = {
  gta5: ['https://runtime.fivem.net/doc/natives.json', 'https://runtime.fivem.net/doc/natives_cfx.json'],
  rdr3: [
    'https://raw.githubusercontent.com/alloc8or/rdr3-nativedb-data/master/natives.json',
    'https://runtime.fivem.net/doc/natives_cfx.json',
  ],
};

const config = (): (typeof session.toolchains)['fivem'] => session.toolchains.fivem;
const game = (): FivemGame => config().game;

interface Parsed {
  readonly positionals: string[];
  readonly flags: Set<string>;
  readonly dir: string | undefined;
}

function parse(args: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--dir') {
      dir = args[++i];
      if (!dir) throw new Error('--dir needs a folder');
    } else if (a.startsWith('--')) flags.add(a.slice(2));
    else positionals.push(a);
  }
  return { positionals, flags, dir: dir === undefined ? undefined : path.resolve(dir) };
}

/** The sandbox's IPv4 addresses the PC can use (its Hyper-V network). */
function addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => Boolean(a && a.family === 'IPv4' && !a.internal))
    .map((a) => a.address);
}

/** The newest MariaDB client in tools\mariadb (databases.mysql installs it there). */
function mariadbClient(): string | null {
  const root = path.join(toolsDir, 'mariadb');
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(root).sort().reverse();
  } catch {
    return null;
  }
  for (const v of versions)
    for (const exe of ['mariadb.exe', 'mysql.exe']) {
      const file = path.join(root, v, 'bin', exe);
      if (fs.existsSync(file)) return file;
    }
  return null;
}

/** The port of the sandbox's running MariaDB, with the "fivem" database made; null when it does not run. */
async function mysqlForServer(): Promise<number | null> {
  const own = (session.databases ?? []).find((p) => p.database === 'mysql');
  const plan = own ?? (session.databaseCatalog ?? []).find((p) => p.database === 'mysql');
  if (!plan) return null;
  if (!(await portOpen(plan.port))) {
    if (own) console.log('MySQL (MariaDB) is not running: sbx-db start mysql, then serve again for oxmysql.');
    return null;
  }
  const client = mariadbClient();
  if (client)
    spawnSync(
      client,
      ['-h', '127.0.0.1', '-P', String(plan.port), '-u', 'root', '-e', 'CREATE DATABASE IF NOT EXISTS fivem'],
      { stdio: 'ignore', windowsHide: true },
    );
  return plan.port;
}

function openPorts(ports: readonly { port: number; protocol: string; name: string }[]): void {
  for (const p of ports)
    try {
      runScript('add-firewall-port.ps1', ['-Port', String(p.port), '-Protocol', p.protocol, '-Name', p.name]);
    } catch (e) {
      console.error(
        'Could not open port ' + p.port + ' in the sandbox firewall (' + errMsg(e) + '): the PC may not reach it.',
      );
    }
}

async function serve(p: Parsed): Promise<number> {
  const build = servingBuildDir();
  if (!build) throw new Error('no FXServer build is installed: run sbx-fivem artifact use recommended');
  const txAdmin = p.flags.has('txadmin') ? true : p.flags.has('no-txadmin') ? false : config().txAdmin;
  const serverDir = p.dir ?? process.cwd();
  if (!txAdmin && !fs.existsSync(path.join(serverDir, 'server.cfg')))
    throw new Error('no server.cfg in ' + serverDir + ': run sbx-fivem init there (or serve --txadmin)');
  const secrets = secretsCfg();
  if (!secrets)
    console.log(
      'No Cfx.re key in this sandbox: on your PC run sandbox account login cfx and sandbox config set accounts.cfx.share true, then restart the sandbox.' +
        (txAdmin ? '' : ' FXServer stops without one.'),
    );
  fs.mkdirSync(txDataDir(), { recursive: true });
  const plan = servePlan({
    artifactDir: build,
    serverDir,
    game: game(),
    txAdmin,
    secretsCfg: secrets,
    txData: txDataDir(),
    mysqlPort: await mysqlForServer(),
  });
  openPorts(plan.ports);
  const ips = addresses();
  const where = ips.length ? ips : ['<the sandbox address>'];
  console.log('FXServer ' + path.basename(build) + (game() === 'rdr3' ? ' (RedM)' : '') + ' from ' + plan.cwd);
  console.log(
    'From your PC: in the ' +
      (game() === 'rdr3' ? 'RedM' : 'FiveM') +
      ' client press F8 and type: connect ' +
      where[0] +
      ':' +
      GAME_PORT,
  );
  if (txAdmin) {
    console.log(
      'txAdmin: http://' + where[0] + ':' + TXADMIN_PORT + ' in a browser on your PC (its PIN is printed below).',
    );
    if (secrets)
      console.log(
        'Keep the key out of txData: in the server.cfg txAdmin makes, replace the sv_licenseKey line with: exec "' +
          secrets.split('\\').join('/') +
          '"',
      );
  }
  return spawnAsync(plan.exe, plan.args, { cwd: plan.cwd, stdio: 'inherit', env: { ...process.env, ...plan.env } });
}

function init(p: Parsed): number {
  const dir = p.dir ?? process.cwd();
  const wrote = initServerFolder(fivemTemplatesDir(), dir, path.basename(dir), game());
  console.log(wrote.length ? 'Wrote ' + wrote.join(', ') + ' in ' + dir : dir + ' already has a server.cfg.');
  console.log('Next: sbx-fivem new <name> --lua (or --js, --ts, --cs), then sbx-fivem serve');
  return 0;
}

const NEXT: Record<ResourceLang, string> = {
  lua: '',
  js: '',
  ts: 'npm install, then npm run build (npm run watch keeps building) in ',
  cs: 'dotnet publish -c Release in Client and in Server of ',
};

function newResource(p: Parsed): number {
  const [name] = p.positionals;
  const langs = RESOURCE_LANGS.filter((l) => p.flags.has(l));
  if (!name || langs.length !== 1) throw new Error('give a name and one of --lua, --js, --ts, --cs\n' + USAGE);
  const folder = p.dir ?? process.cwd();
  const into = resourceHome(folder);
  const made = scaffoldResource({ templates: fivemTemplatesDir(), lang: langs[0]!, name, into, game: game() });
  console.log('Made ' + made.dir + ' (' + made.files.length + ' files)');
  const cfg = path.join(folder, 'server.cfg');
  if (fs.existsSync(cfg)) {
    const next = withEnsure(fs.readFileSync(cfg, 'utf8'), name);
    if (next !== null) {
      fs.writeFileSync(cfg, next);
      console.log('Added ensure ' + name + ' to ' + cfg);
    }
  } else console.log('Add ensure ' + name + ' to your server.cfg.');
  if (NEXT[langs[0]!]) console.log('Build it: ' + NEXT[langs[0]!] + made.dir);
  console.log('A running server picks it up with: refresh, then ensure ' + name + ' (in the server console).');
  return 0;
}

async function artifact(p: Parsed): Promise<number> {
  const [, action, value] = p.positionals;
  const installed = installedBuilds();
  const chosen = chosenArtifact(config().artifact);
  if (action === 'list' || action === undefined) {
    try {
      const channels = await fetchChannels();
      for (const c of CHANNELS) {
        const a = channels[c];
        console.log(
          c.padEnd(12) +
            String(a.build).padEnd(8) +
            (a.txAdmin ? 'txAdmin ' + a.txAdmin : '').padEnd(16) +
            (installed.includes(a.build) ? 'installed' : ''),
        );
      }
    } catch (e) {
      console.log('Could not look up the builds online (' + errMsg(e) + ').');
    }
    console.log('Installed: ' + (installed.length ? installed.join(', ') : 'none') + ' (tools\\fivem\\artifacts)');
    console.log(
      'In use: ' +
        (chosen.chosen
          ? chosen.setting + ' (build ' + chosen.build + ', chosen with artifact use)'
          : config().artifact + ' (toolchains.fivem.artifact)'),
    );
    return 0;
  }
  if (action !== 'use' || !value) throw new Error(USAGE);
  const a = await resolveArtifact(value, true);
  const done = await installArtifact(a, config().keepVersions);
  rememberArtifact(value === config().artifact ? null : { artifact: value, build: a.build });
  console.log('FXServer build ' + a.build + (done.fresh ? ' installed' : ' was there') + ' in ' + artifactDir(a.build));
  console.log(
    'sbx-fivem serve uses it from now on' + (value === config().artifact ? '' : ', and so do the next sandboxes') + '.',
  );
  return 0;
}

async function natives(): Promise<number> {
  const dir = path.join(toolsDir, 'fivem', 'natives', game());
  for (const url of NATIVES[game()]) {
    const file = path.join(dir, path.basename(new URL(url).pathname));
    await downloader.file(url, file);
    console.log(file);
  }
  return 0;
}

export const fivemTool: DevTool = {
  name: 'fivem',
  summary: 'start the FiveM / RedM server, pick a server build, make a new resource',
  async run(args: readonly string[]): Promise<number> {
    const p = parse(args);
    switch (p.positionals[0]) {
      case 'serve':
        return serve(p);
      case 'init':
        return init(p);
      case 'new':
        return newResource({ ...p, positionals: p.positionals.slice(1) });
      case 'artifact':
      case 'artifacts':
        return artifact(p);
      case 'natives':
        return natives();
      default:
        console.log(USAGE);
        return p.positionals[0] === undefined || p.positionals[0] === 'help' ? 0 : 2;
    }
  },
};
