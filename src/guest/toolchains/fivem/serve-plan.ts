// How `sbx-fivem serve` starts FXServer: the program, its arguments and environment, and the ports the PC needs.
// Plain: +exec the Cfx.re key's cfg (on the sandbox's own disk) and then the project's server.cfg, from the server
// folder. txAdmin: no +exec (FXServer then starts txAdmin), its data in state\fivem\txData through TXHOST_*.
// No runtime imports: the self-test loads this file.
import path from 'node:path';
import type { FivemGame } from './scaffold.js';

export const GAME_PORT = 30120;
export const TXADMIN_PORT = 40120;

export interface ServeInput {
  /** The FXServer build's folder (FXServer.exe, citizen\). */
  readonly artifactDir: string;
  /** The server folder (server.cfg, resources\). */
  readonly serverDir: string;
  readonly game: FivemGame;
  readonly txAdmin: boolean;
  /** The Cfx.re key's cfg, or null when no key was handed over. */
  readonly secretsCfg: string | null;
  readonly txData: string;
  /** The port of the sandbox's MariaDB (databases.mysql), or null when it has none. */
  readonly mysqlPort: number | null;
}

export interface OpenPort {
  readonly port: number;
  readonly protocol: 'TCP' | 'UDP' | 'Both';
  readonly name: string;
}

export interface ServePlan {
  readonly exe: string;
  readonly args: string[];
  readonly cwd: string;
  /** Added to sbx-fivem's own environment. */
  readonly env: Record<string, string>;
  readonly ports: OpenPort[];
}

/** FXServer's exec takes forward slashes. */
export function cfgPath(file: string): string {
  return file.split('\\').join('/');
}

/** oxmysql's connection string for the sandbox's MariaDB (user root, no password, database "fivem"). */
export function mysqlConnectionString(port: number): string {
  return 'mysql://root@127.0.0.1:' + port + '/fivem?charset=utf8mb4';
}

export function servePlan(i: ServeInput): ServePlan {
  const exe = path.join(i.artifactDir, 'FXServer.exe');
  const citizen = ['+set', 'citizen_dir', path.join(i.artifactDir, 'citizen')];
  const game = i.game === 'rdr3' ? ['+set', 'gamename', 'rdr3'] : [];
  if (i.txAdmin) {
    const db: Record<string, string> =
      i.mysqlPort === null
        ? {}
        : {
            TXHOST_DEFAULT_DBHOST: '127.0.0.1',
            TXHOST_DEFAULT_DBPORT: String(i.mysqlPort),
            TXHOST_DEFAULT_DBUSER: 'root',
            TXHOST_DEFAULT_DBNAME: 'fivem',
          };
    return {
      exe,
      // RedM: txAdmin's recipes for it set gamename in the server.cfg they write.
      args: citizen,
      cwd: i.txData,
      env: {
        TXHOST_DATA_PATH: i.txData,
        TXHOST_TXA_PORT: String(TXADMIN_PORT),
        TXHOST_GAME_NAME: i.game === 'rdr3' ? 'redm' : 'fivem',
        TXHOST_PROVIDER_NAME: 'Sandbox',
        ...db,
      },
      ports: [
        { port: GAME_PORT, protocol: 'Both', name: 'FiveM server' },
        { port: TXADMIN_PORT, protocol: 'TCP', name: 'txAdmin' },
      ],
    };
  }
  return {
    exe,
    args: [
      ...citizen,
      ...game,
      ...(i.mysqlPort === null ? [] : ['+set', 'mysql_connection_string', mysqlConnectionString(i.mysqlPort)]),
      ...(i.secretsCfg ? ['+exec', cfgPath(i.secretsCfg)] : []),
      '+exec',
      'server.cfg',
    ],
    cwd: i.serverDir,
    env: {},
    ports: [{ port: GAME_PORT, protocol: 'Both', name: 'FiveM server' }],
  };
}
