// The VPN: profiles are untrusted (programs refused), the kill switch rules, NordVPN server choice, the saved login,
// the settings rules for projects, and that the login never lands in session.json or the launch folder.
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../app/context.js';
import { vpnLoginRowOf, vpnPage, VPN_WARNINGS, type VpnStatus } from '../app/features/vpn/index.js';
import { fakeIO, pageActions } from '../app/kernel/index.js';
import { runDefinition } from '../app/registry.js';
import { pageLines } from '../cli/output/index.js';
import { VpnService } from '../cli/services/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { insideSandbox } from '../host/sandbox/platform.js';
import { applyOverrides, loosenedRequests, NEVER_LOOSER, normalizeOverrides } from '../core/local-config/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import { SecretStore } from '../host/secrets/index.js';
import { clearSecrets } from '../host/secrets/index.js';
import { generateSandbox } from '../host/launch/index.js';
import {
  findCountry,
  nordProfile,
  prepareVpn,
  wireguardFileProblem,
  recommendedServer,
  VpnLogin,
  vpnLine,
  vpnNotes,
} from '../host/vpn/index.js';
import { RunDir } from '../shared/channel/index.js';
import type { SecretsFile } from '../shared/channel/secrets.js';
import { OPENVPN_MSI, WIREGUARD_MSI } from '../shared/vpn/download.js';
import {
  cleanServers,
  ipv4Except,
  killSwitchCommands,
  removeKillSwitchCommands,
  tunnelAddressFromLog,
  tunnelCommands,
} from '../shared/vpn/kill-switch.js';
import { assertSafeOvpn, inspectOvpn, PROGRAM_DIRECTIVES } from '../shared/vpn/ovpn.js';
import {
  assertSafeWireguard,
  handshakeDone,
  inspectWireguard,
  renderWireguard,
  serviceRunning,
  WIREGUARD_PROGRAM_KEYS,
  wireguardEndpoints,
  wireguardTunnelAddress,
} from '../shared/vpn/wireguard.js';
import type { Suite } from './support/suite.js';

const PROFILE = [
  'client',
  'dev tun',
  'proto udp',
  'remote 185.1.2.3 1194',
  'remote-random',
  'resolv-retry infinite',
  'nobind',
  'tun-mtu 1500',
  'tun-mtu-extra 32',
  'mssfix 1450',
  'persist-key',
  'persist-tun',
  'ping 15',
  'ping-restart 0',
  'ping-timer-rem',
  'reneg-sec 0',
  'comp-lzo no',
  'remote-cert-tls server',
  'auth-user-pass',
  'verb 3',
  'pull',
  'fast-io',
  'cipher AES-256-CBC',
  'auth SHA512',
  '<ca>',
  '-----BEGIN CERTIFICATE-----',
  'MIIDxx',
  '-----END CERTIFICATE-----',
  '</ca>',
  'key-direction 1',
  '<tls-auth>',
  '-----BEGIN OpenVPN Static key V1-----',
  'abcd',
  '-----END OpenVPN Static key V1-----',
  '</tls-auth>',
  '',
].join('\r\n');

const PRIVATE_KEY = 'PrivPlanted' + 'A'.repeat(32) + '=';
const PUBLIC_KEY = 'PubPlanted' + 'B'.repeat(33) + '=';
const PRESHARED_KEY = 'PskPlanted' + 'C'.repeat(33) + '=';
const WG_CONFIG = [
  '[Interface]',
  'PrivateKey = ' + PRIVATE_KEY,
  'Address = 10.64.0.2/32, fd00::2/128',
  'DNS = 10.64.0.1',
  'MTU = 1380',
  '',
  '[Peer] # the office',
  'PublicKey = ' + PUBLIC_KEY,
  'PresharedKey = ' + PRESHARED_KEY,
  'AllowedIPs = 0.0.0.0/0, ::/0',
  'Endpoint = vpn.example.com:51820',
  'PersistentKeepalive = 25',
  '',
].join('\r\n');

const PASSWORD = 'vpn-pass-planted-91c2d7';
const USERNAME = 'vpn-user-planted-5e8a40';

export const vpnSuite: Suite = {
  name: 'vpn',
  title: 'VPN: profile checks, kill switch rules, NordVPN, login storage, settings rules',
  run: async (t, f) => {
    t.section('a profile is untrusted data');
    const good = inspectOvpn(PROFILE);
    t.check(
      good.ok && good.remotes.length === 1 && good.remotes[0].host === '185.1.2.3' && good.remotes[0].proto === 'udp',
      'a NordVPN-style profile is accepted and says where it connects (and with which protocol)',
      JSON.stringify(good),
    );
    const byName = inspectOvpn('remote vpn.example.com 443\r\nproto tcp-client\r\nclient');
    t.check(
      byName.ok && byName.remotes[0].proto === 'tcp' && byName.remotes[0].host === 'vpn.example.com',
      'the proto line counts even after the remote line, and a host name is allowed',
    );
    for (const name of ['script-security', 'up', 'down', 'plugin', 'route-up', 'ipchange', 'tls-verify']) {
      const bad = inspectOvpn(PROFILE + name + ' 2 C:\\evil.cmd\r\n');
      t.check(
        !bad.ok && bad.problems.some((p) => p.includes(name + ' runs a program')),
        name + ' is refused as something that runs a program',
        JSON.stringify(bad),
      );
    }
    t.check(
      PROGRAM_DIRECTIVES.every((name) => !inspectOvpn(PROFILE + name + ' x\r\n').ok),
      'every listed program-running directive is refused',
    );
    const odd = [
      ['--up x', 'a leading -- does not hide it'],
      ['UP x', 'upper case does not hide it'],
      ['\tscript-security 2', 'leading white space does not hide it'],
      ['"up" x', 'quotes around the name do not hide it'],
      ['made-up-directive 1', 'an unknown directive is refused, not passed on'],
      ['ca /etc/ca.crt', 'a certificate file on this machine is refused'],
      ['auth-user-pass C:\\secret.txt', 'a login file named in the profile is refused'],
      ['setenv FOO bar', 'setenv for anything but CLIENT_CERT is refused'],
      ['<connection>', 'a <connection> section (it could hide more) is refused'],
    ] as const;
    for (const [line, why] of odd) t.check(!inspectOvpn(PROFILE + line + '\r\n').ok, why, line);
    t.check(
      !inspectOvpn(PROFILE.replace('</ca>', '')).ok &&
        !inspectOvpn('client\r\n').ok &&
        !inspectOvpn('x'.repeat(300 * 1024)).ok &&
        !inspectOvpn(PROFILE.replace('<tls-auth>', '<tls-auth>\r\nup evil\r\n<ca>')).ok,
      'an unclosed section, no remote, an oversized file and a section inside a section are refused',
    );
    t.check(
      inspectOvpn(PROFILE.replace('</ca>', '</ca>\r\n# up /bin/evil\r\n; plugin evil.dll\r\n')).ok,
      'comments are comments (a commented-out up line is not a directive)',
    );
    await t.throws(
      () => assertSafeOvpn(PROFILE + 'script-security 2\r\nup evil.cmd\r\n', 'uk1.nordvpn.com'),
      'uk1.nordvpn.com was refused',
      'a refused profile names its source and the reason',
    );

    t.section('the kill switch as netsh commands');
    const servers = [
      { ip: '185.1.2.3', port: 1194, proto: 'udp' as const },
      { ip: '185.1.2.3', port: 1194, proto: 'udp' as const },
      { ip: 'not-an-ip', port: 1194, proto: 'udp' as const },
      { ip: '185.9.9.9', port: 443, proto: 'tcp' as const },
    ];
    t.equal(
      cleanServers(servers).map((s) => s.ip + ':' + s.port),
      ['185.1.2.3:1194', '185.9.9.9:443'],
      'servers are valid and each once',
    );
    const phase1 = killSwitchCommands(servers, 'C:\\AgentLaunch\\ptyhost.exe').map((c) => c.join(' '));
    const policyAt = phase1.findIndex((c) => c.includes('firewallpolicy blockinbound,blockoutbound'));
    const firstAllow = phase1.findIndex((c) => c.includes('action=allow'));
    t.check(
      policyAt > 0 && policyAt < firstAllow,
      'outbound is blocked by default before any allow rule is added',
      phase1.join('\n'),
    );
    t.check(
      phase1.some((c) => c.includes('name=AgentSandbox-VPN-Loopback') && c.includes('remoteip=127.0.0.0/8')) &&
        phase1.some(
          (c) =>
            c.includes('name=AgentSandbox-VPN-Server-1') &&
            c.includes('protocol=udp') &&
            c.includes('remoteip=185.1.2.3') &&
            c.includes('remoteport=1194'),
        ) &&
        phase1.some(
          (c) =>
            c.includes('name=AgentSandbox-VPN-Server-2') && c.includes('protocol=tcp') && c.includes('remoteport=443'),
        ) &&
        phase1.some(
          (c) =>
            c.includes('name=AgentSandbox-VPN-Host') &&
            c.includes('remoteip=LocalSubnet') &&
            c.includes('program=C:\\AgentLaunch\\ptyhost.exe'),
        ) &&
        phase1.some((c) => c.includes('name=AgentSandbox-VPN-DHCP')),
      'it allows loopback, each VPN server endpoint, the attach channel on the Hyper-V network and DHCP',
    );
    t.check(
      !phase1.some((c) => c.includes('localip=') || (c.includes('action=allow') && c.includes('remoteip=any'))),
      'nothing else is allowed before the tunnel exists (no blanket rule)',
    );
    const blockAt = (name: string): number =>
      phase1.findIndex((c) => c.includes('name=AgentSandbox-VPN-' + name + ' '));
    const internet = phase1[blockAt('Block-Internet')] ?? '';
    t.check(
      ['Block-Internet', 'Block-IPv6', 'Block-DNS-UDP', 'Block-DNS-TCP'].every(
        (name) => blockAt(name) >= 0 && blockAt(name) < policyAt && phase1[blockAt(name)].includes('action=block'),
      ),
      'the kill switch is made of block rules, added before anything else (Windows Sandbox allows all outbound itself)',
      phase1.join('\n'),
    );
    t.check(
      internet.includes('1.0.0.0-9.255.255.255') &&
        internet.includes('-185.1.2.2,185.1.2.4-185.9.9.8,185.9.9.10-') &&
        !/(^|[=,])10\.\d/.test(internet.split('remoteip=')[1] ?? '') &&
        internet.includes('-172.15.255.255,172.32.0.0-') &&
        internet.includes('-192.167.255.255,192.169.0.0-') &&
        internet.endsWith('-223.255.255.255'),
      'the block covers every public address except the VPN servers (private, loopback and multicast are the LAN block)',
      internet,
    );
    t.check(
      phase1[blockAt('Block-IPv6')].includes('remoteip=2000::/3') &&
        phase1[blockAt('Block-DNS-UDP')].includes('protocol=udp remoteport=53') &&
        phase1[blockAt('Block-DNS-TCP')].includes('protocol=tcp remoteport=53'),
      'global IPv6 and DNS (which would leak the names you visit) are blocked too',
    );
    t.equal(
      [
        ipv4Except([]),
        ipv4Except([[0, 0]]),
        ipv4Except([[4294967295, 4294967295]]),
        ipv4Except([
          [5, 9],
          [7, 12],
        ]),
      ],
      [
        '0.0.0.0-255.255.255.255',
        '0.0.0.1-255.255.255.255',
        '0.0.0.0-255.255.255.254',
        '0.0.0.0-0.0.0.4,0.0.0.13-255.255.255.255',
      ],
      'address lists without some addresses (edges and overlaps)',
    );
    t.check(
      killSwitchCommands([], null).every((c) => !c.join(' ').includes('Server-1') || c[2] === 'delete') &&
        !killSwitchCommands([], null).some((c) => c.join(' ').includes('name=AgentSandbox-VPN-Host') && c[2] === 'add'),
      'with no servers and no session host only the block and the loopback rules remain (the failure case: offline)',
    );
    t.equal(
      tunnelCommands('10.8.0.6')
        .map((c) => c.join(' '))
        .filter((c) => c.includes(' add ')),
      [
        'advfirewall firewall add rule name=AgentSandbox-VPN-Tunnel dir=out action=allow enable=yes profile=any protocol=any localip=10.8.0.6',
      ],
      'once the tunnel is up, traffic from its own address (the tunnel) is allowed',
    );
    const phase2 = tunnelCommands('10.8.0.6').map((c) => c.join(' '));
    t.check(
      ['Block-Internet', 'Block-DNS-UDP', 'Block-DNS-TCP'].every((name) =>
        phase2.some(
          (c) =>
            c.startsWith('advfirewall firewall set rule name=AgentSandbox-VPN-' + name + ' new ') &&
            c.endsWith('localip=0.0.0.0-10.8.0.5,10.8.0.7-255.255.255.255'),
        ),
      ) && !phase2.some((c) => c.includes('delete') && c.includes('Block-')),
      'the block rules are narrowed in place to everything but the tunnel (never deleted, so no moment without them)',
      phase2.join('\n'),
    );
    await t.throws(
      () => tunnelCommands('10.8.0.6; calc'),
      'Not an IPv4',
      'a tunnel address that is not an address makes no rule',
    );
    t.check(
      removeKillSwitchCommands().some((c) => c.join(' ').includes('blockinbound,allowoutbound')) &&
        removeKillSwitchCommands().some((c) => c.join(' ').includes('name=AgentSandbox-VPN-Tunnel')) &&
        removeKillSwitchCommands().some((c) => c.join(' ').includes('name=AgentSandbox-VPN-Block-Internet')),
      'taking it away restores the default and deletes the rules',
    );
    t.equal(
      [
        tunnelAddressFromLog('... net_addr_v4_add: 10.100.0.2/16 dev Wintun ...'),
        tunnelAddressFromLog('ifconfig 10.8.0.6 255.255.255.0'),
        tunnelAddressFromLog('nothing'),
      ],
      ['10.100.0.2', '10.8.0.6', null],
      "the tunnel's address is read from OpenVPN's log",
    );
    t.check(
      OPENVPN_MSI.x64.sha256.length === 64 &&
        OPENVPN_MSI.arm64.sha256.length === 64 &&
        OPENVPN_MSI.base.startsWith('https://'),
      'the OpenVPN download has a checksum for each architecture (downloads.requireChecksum passes)',
    );

    t.section('NordVPN: the server for the country and protocol');
    const asked: string[] = [];
    const fake = (url: string): Promise<string> => {
      asked.push(url);
      if (url.endsWith('/servers/countries'))
        return Promise.resolve(
          JSON.stringify([
            { id: 227, name: 'United Kingdom', code: 'GB' },
            { id: 81, name: 'Germany', code: 'DE' },
          ]),
        );
      if (url.includes('/servers/recommendations'))
        return Promise.resolve(JSON.stringify([{ hostname: 'uk2201.nordvpn.com', station: '185.1.2.3' }]));
      if (url.endsWith('.ovpn')) return Promise.resolve(PROFILE);
      return Promise.reject(new Error('unexpected ' + url));
    };
    t.check(
      findCountry([{ id: 227, name: 'United Kingdom', code: 'GB' }], 'uk') === 227 &&
        findCountry([{ id: 81, name: 'Germany', code: 'DE' }], 'germany') === 81,
      'uk and Germany are found by code, alias or name',
    );
    await t.throws(
      () => findCountry([{ id: 81, name: 'Germany', code: 'DE' }], 'atlantis'),
      'no country',
      'an unknown country says so',
    );
    const server = await recommendedServer('udp', 'uk', fake);
    t.check(
      server.hostname === 'uk2201.nordvpn.com' &&
        asked.some((u) => u.includes('filters[country_id]=227') && u.includes('openvpn_udp')),
      'the recommendation asks for the country and the protocol',
      asked.join('\n'),
    );
    t.check(
      (await nordProfile(server, 'udp', fake)) === PROFILE &&
        asked.some(
          (u) => u === 'https://downloads.nordcdn.com/configs/files/ovpn_udp/servers/uk2201.nordvpn.com.udp.ovpn',
        ),
      "the server's own profile is fetched from NordVPN's download host",
    );
    await t.throws(
      () =>
        recommendedServer('udp', '', () =>
          Promise.resolve(JSON.stringify([{ hostname: 'evil.example.com; calc', station: '1.2.3.4' }])),
        ),
      'did not recommend',
      'an answer that is not a NordVPN host name is refused (it becomes part of a URL and a file name)',
    );

    t.section('the saved login');
    const storage = t.dir('vpn-storage');
    const login = new VpnLogin(storage, SecretStore.memory());
    t.check(login.state('nordvpn') === 'none', 'nothing is saved at first');
    await t.throws(
      () => login.save('nordvpn', { username: 'a\nb', password: 'x' }),
      'line breaks',
      'a login with a line break is refused (it goes on two lines of a file)',
    );
    login.save('nordvpn', { username: USERNAME, password: PASSWORD });
    const file = path.join(storage, 'vpn', 'nordvpn.json');
    t.check(
      login.state('nordvpn') === 'saved' &&
        !fs.readFileSync(file, 'utf8').includes(USERNAME) &&
        !fs.readFileSync(file, 'utf8').includes(PASSWORD),
      'it is saved sealed: neither value is in the file',
    );
    t.equal(login.read('nordvpn'), { username: USERNAME, password: PASSWORD }, 'and it opens for the launch');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"sealed": "[^"]*"/, '"sealed": "dpapi1:AAAA"'));
    t.check(login.state('nordvpn') === 'unreadable', 'a login this Windows user cannot open is reported as unreadable');
    login.remove('nordvpn');
    t.check(login.state('nordvpn') === 'none', 'logout deletes it');

    t.section('settings: what a project may and may not do');
    t.check(
      DEFAULTS.vpn.enabled === false && DEFAULTS.vpn.provider === 'nordvpn' && DEFAULTS.vpn.killSwitch === true,
      'the VPN is off by default, NordVPN, with the kill switch on',
    );
    t.check(ConfigSchema.safeParse(DEFAULTS).success, 'the defaults are valid');
    t.check(
      !ConfigSchema.safeParse({ ...DEFAULTS, vpn: { ...DEFAULTS.vpn, country: 'uk; calc' } }).success &&
        !ConfigSchema.safeParse({ ...DEFAULTS, vpn: { ...DEFAULTS.vpn, protocol: 'icmp' } }).success &&
        !ConfigSchema.safeParse({ ...DEFAULTS, vpn: { ...DEFAULTS.vpn, username: 'x' } }).success,
      'a country with odd characters, an unknown protocol and a login setting are all invalid (no login setting exists)',
    );
    for (const bad of [
      { vpn: { enabled: true } },
      { vpn: { provider: 'openvpn-file' } },
      { vpn: { configFile: 'C:\\evil.ovpn' } },
      { vpn: { country: 'uk' } },
      { vpn: { username: 'x', password: 'y' } },
      { vpn: { credentials: 'x' } },
      { vpn: { servers: ['1.2.3.4'] } },
    ])
      t.check(
        !LocalOverridesSchema.safeParse(bad).success,
        "a project's .sandbox-config.json cannot set " + Object.keys(bad.vpn).join(', '),
      );
    t.check(LocalOverridesSchema.safeParse({ vpn: { killSwitch: true } }).success, 'it can ask for the kill switch');
    t.check(NEVER_LOOSER.includes('vpn.killSwitch'), 'the kill switch is a protection a project may only tighten');
    const mine = structuredClone(DEFAULTS);
    mine.vpn.enabled = true;
    const loosen = normalizeOverrides({ vpn: { killSwitch: false } }, f.workA, 'x');
    t.check(
      applyOverrides(mine, loosen).vpn.killSwitch === true &&
        loosenedRequests(mine, loosen).some((r) => r.key === 'vpn.killSwitch'),
      'a project cannot turn the kill switch off (it is flagged and ignored)',
    );
    const off = structuredClone(mine);
    off.vpn.killSwitch = false;
    t.check(
      applyOverrides(off, normalizeOverrides({ vpn: { killSwitch: true } }, f.workA, 'x')).vpn.killSwitch === true,
      'but it can turn it on',
    );

    t.section('the login never lands in session.json, the launch folder or --json');
    const config = f.makeConfig();
    config.vpn = { ...config.vpn, enabled: true, country: 'uk' };
    const store = new VpnLogin(config.storage.root, SecretStore.memory());
    store.save('nordvpn', { username: USERNAME, password: PASSWORD });
    const run = await f.run({}, config);
    const prepared = await prepareVpn({
      config: run.config,
      storageRoot: config.storage.root,
      login: store,
      fetchText: fake,
    });
    t.check(
      prepared !== null &&
        prepared.session.server === 'uk2201.nordvpn.com' &&
        prepared.credentials?.password === PASSWORD,
      'a launch picks the server, checks its profile and holds the login in memory',
    );
    await t.throws(
      () =>
        prepareVpn({
          config: run.config,
          storageRoot: config.storage.root,
          login: store,
          fetchText: fake,
          sandboxRunning: true,
        }),
      'already',
      'the login is not handed over while a sandbox is running (one that is not being started now)',
    );
    await t.throws(
      () =>
        prepareVpn({
          config: run.config,
          storageRoot: config.storage.root,
          login: store,
          fetchText: (url) => (url.endsWith('.ovpn') ? Promise.resolve(PROFILE + 'up evil.cmd\r\n') : fake(url)),
        }),
      'refused',
      'a profile that would run a program stops the launch before anything is written',
    );
    await t.throws(
      () =>
        prepareVpn({
          config: run.config,
          storageRoot: config.storage.root,
          login: new VpnLogin(t.dir('vpn-empty'), SecretStore.memory()),
          fetchText: fake,
        }),
      'sandbox vpn login',
      'no saved login says how to save one',
    );
    clearSecrets(config.storage.root, run.dataPath);
    const withVpn = generateSandbox({
      packageRoot: t.packageRoot,
      run,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: ['python', 'rust', 'cpp', 'dotnet'],
      ...(prepared ? { vpn: prepared } : {}),
    });
    const session = fs.readFileSync(withVpn.sessionPath, 'utf8');
    const everything: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else everything.push(fs.readFileSync(p, 'latin1'));
      }
    };
    walk(withVpn.launchPath);
    t.check(
      !session.includes(PASSWORD) &&
        !session.includes(USERNAME) &&
        !everything.some((text) => text.includes(PASSWORD) || text.includes(USERNAME)),
      'neither the service user name nor the password is in session.json or any file of the launch folder',
    );
    const vpnSession = f.readJson(withVpn.sessionPath).vpn as { server: string; killSwitch: boolean; profile: string };
    t.check(
      vpnSession.server === 'uk2201.nordvpn.com' &&
        vpnSession.killSwitch === true &&
        fs.readFileSync(path.join(withVpn.launchPath, 'vpn', 'server.ovpn'), 'utf8') === PROFILE,
      'session.json says which server and whether the kill switch is on; the checked profile is in the launch folder',
    );
    const handed = f.readJson(new RunDir(run.dataPath).secretFile(withVpn.launchId)) as SecretsFile;
    t.equal(
      handed.vpn,
      { username: USERNAME, password: PASSWORD },
      'the login is only in the one-shot file for the sandbox',
    );
    clearSecrets(config.storage.root, run.dataPath);
    t.check(
      vpnNotes(config.vpn).some((n) => n.includes('can read the VPN login') && n.includes('turn the tunnel off')) &&
        vpnNotes(config.vpn).some((n) => n.includes('kill switch on')) &&
        vpnNotes({ ...config.vpn, killSwitch: false }).some((n) => n.includes('kill switch OFF')) &&
        vpnNotes({ ...config.vpn, enabled: false }).length === 0,
      'the launch warns that the agent can read the login and turn the tunnel off, and says what the kill switch does',
    );

    t.section('what the host says about the tunnel');
    const status = (state: 'up' | 'failed' | 'starting', extra: object = {}): ReturnType<typeof vpnLine> =>
      vpnLine({ state, message: 'm', killSwitch: true, updatedAt: 'now', ...extra }, '203.0.113.9');
    t.check(
      status('up', { publicIp: '185.1.2.3', server: 'uk2201.nordvpn.com' }).level === 'ok' &&
        status('up', { publicIp: '203.0.113.9' }).level === 'bad' &&
        status('failed', { message: 'login refused' }).text.includes('NO internet') === false &&
        status('failed', { message: 'login refused' }).text.includes('no internet') &&
        vpnLine({ state: 'failed', message: 'x', killSwitch: false, updatedAt: 'now' }).text.includes(
          'normal connection',
        ) &&
        status('starting').level === 'warn',
      "up with another address is fine, up with this PC's own address is flagged, a failure says what the kill switch did",
    );
    t.check(
      status('failed', { killSwitchHeld: false }).text.includes('ONLINE') &&
        !status('failed', { killSwitchHeld: false }).text.includes('no internet') &&
        status('failed', { killSwitchHeld: true }).text.includes('no internet') &&
        status('up', { publicIp: '185.1.2.3', killSwitchHeld: false }).level === 'warn',
      'a kill switch that did not hold is never reported as "no internet" (a failure says the sandbox is online)',
    );
    t.check(
      !vpnLine({
        state: 'failed',
        message: 'bad \u001b]52;c;ZXZpbA==\u0007 text',
        killSwitch: true,
        updatedAt: 'n',
      }).text.includes('\u001b'),
      'text the sandbox wrote loses its escape sequences before it is printed',
    );

    t.section('WireGuard: your own config is untrusted data');
    const wg = inspectWireguard(WG_CONFIG);
    t.check(
      wg.ok &&
        wg.config.peers.length === 1 &&
        wg.config.peers[0].endpointHost === 'vpn.example.com' &&
        wg.config.peers[0].endpointPort === 51820 &&
        wireguardTunnelAddress(wg.config) === '10.64.0.2' &&
        wireguardEndpoints(wg.config)[0].port === 51820,
      'a plain config is accepted and says where it connects and which address the tunnel has',
      JSON.stringify(wg),
    );
    for (const key of WIREGUARD_PROGRAM_KEYS) {
      const bad = inspectWireguard(WG_CONFIG.replace('MTU = 1380', key + ' = calc.exe'));
      t.check(
        !bad.ok && bad.problems.some((p) => p.toLowerCase().includes(key)),
        key + ' is refused by name',
        JSON.stringify(bad),
      );
    }
    const wgOdd = [
      ['FwMark = 7', 'an unknown [Interface] key is refused, not passed on'],
      ['postup = calc', 'lower case does not hide PostUp'],
      ['[Socks]', 'an unknown section is refused'],
      ['DNS = evil.example.com', 'a DNS name (a search domain) is refused: only addresses'],
      ['MTU = 99999', 'an MTU out of range is refused'],
      ['PrivateKey = ' + PRIVATE_KEY, 'a second PrivateKey is refused'],
    ] as const;
    for (const [line, why] of wgOdd) {
      const text = line.startsWith('[') ? WG_CONFIG + line + '\r\n' : WG_CONFIG.replace('MTU = 1380', line);
      t.check(!inspectWireguard(text).ok, why, line);
    }
    t.check(
      !inspectWireguard(WG_CONFIG.replace(PRIVATE_KEY, 'tooshort')).ok &&
        !inspectWireguard(WG_CONFIG.replace('10.64.0.2/32, fd00::2/128', 'fd00::2/128')).ok &&
        !inspectWireguard(WG_CONFIG.replace('vpn.example.com:51820', '[2001:db8::1]:51820')).ok &&
        !inspectWireguard(WG_CONFIG.replace('Endpoint = vpn.example.com:51820', '')).ok &&
        !inspectWireguard(WG_CONFIG.replace('vpn.example.com:51820', 'vpn.example.com:0')).ok &&
        !inspectWireguard(WG_CONFIG.replace('[Peer] # the office', '')).ok &&
        !inspectWireguard('x'.repeat(20 * 1024)).ok &&
        !inspectWireguard(WG_CONFIG.replace('AllowedIPs = 0.0.0.0/0, ::/0', 'AllowedIPs = 300.0.0.0/0')).ok,
      'a bad key, an IPv6-only address or endpoint, a missing endpoint or peer, a bad port, a huge file and a bad range are refused',
    );
    t.check(
      inspectWireguard(WG_CONFIG.replace('MTU = 1380', '# PostUp = calc\r\nMTU = 1380 # PreUp = calc')).ok,
      'comments are comments (a commented-out PostUp is not a key)',
    );
    const refusals = [
      WG_CONFIG.replace('MTU = 1380', 'PostUp = ' + PRIVATE_KEY),
      WG_CONFIG.replace('MTU = 1380', 'Bogus = ' + PRESHARED_KEY),
      WG_CONFIG.replace(PUBLIC_KEY, 'bad' + PRESHARED_KEY),
      WG_CONFIG.replace(PRIVATE_KEY, PRIVATE_KEY + 'x'),
    ].map(inspectWireguard);
    t.check(
      refusals.every(
        (r) => !r.ok && !JSON.stringify(r).includes('PrivPlanted') && !JSON.stringify(r).includes('PskPlanted'),
      ),
      'what a refusal says never contains a key',
    );
    await t.throws(
      () => assertSafeWireguard(WG_CONFIG.replace('MTU = 1380', 'PostUp = calc'), 'office.conf'),
      'office.conf was refused',
      'a refused config names its file and the reason',
    );
    if (wg.ok) {
      const text = renderWireguard(wg.config, { 0: '203.0.113.7' });
      t.check(
        text.includes('Endpoint = 203.0.113.7:51820') &&
          !text.includes('vpn.example.com') &&
          !text.includes('the office') &&
          inspectWireguard(text).ok,
        'the config handed on is written again from the checked values, with the endpoint as an address, and is itself valid',
      );
    }
    const wgRules = killSwitchCommands([{ ip: '203.0.113.7', port: 51820, proto: 'udp' }], null).map((c) =>
      c.join(' '),
    );
    t.check(
      wgRules.some(
        (c) =>
          c.includes('name=AgentSandbox-VPN-Server-1') &&
          c.includes('protocol=udp') &&
          c.includes('remoteip=203.0.113.7') &&
          c.includes('remoteport=51820'),
      ) && wgRules.findIndex((c) => c.includes('blockoutbound')) < wgRules.findIndex((c) => c.includes('action=allow')),
      'the kill switch blocks first and lets only the endpoint host:port through, over udp',
    );
    t.check(
      tunnelCommands('10.64.0.2').some((c) => c.join(' ').includes('localip=10.64.0.2') && c[2] === 'add'),
      "the tunnel's own address (from Address) is let through once the service runs",
    );
    t.check(
      WIREGUARD_MSI.x64.sha256.length === 64 &&
        WIREGUARD_MSI.arm64.sha256.length === 64 &&
        WIREGUARD_MSI.base.startsWith('https://download.wireguard.com/') &&
        serviceRunning('STATE              : 4  RUNNING') &&
        !serviceRunning('STATE              : 1  STOPPED') &&
        handshakeDone('abc=\t1700000000\r\n') &&
        !handshakeDone('abc=\t0\r\n') &&
        !handshakeDone(''),
      'the WireGuard download is pinned by checksum; the service state and handshake are read from the tools output',
    );

    t.section('WireGuard: the keys never land in session.json or the launch folder');
    const wgDir = t.dir('wg-config');
    const wgFile = path.join(wgDir, 'office.conf');
    fs.writeFileSync(wgFile, WG_CONFIG);
    const wgSettings = f.makeConfig();
    wgSettings.vpn = { ...wgSettings.vpn, enabled: true, provider: 'wireguard-file', configFile: wgFile };
    const wgRun = await f.run({}, wgSettings);
    const wgPrepared = await prepareVpn({
      config: wgRun.config,
      storageRoot: wgSettings.storage.root,
      login: new VpnLogin(t.dir('wg-nologin'), SecretStore.memory()),
    });
    t.check(
      wgPrepared !== null &&
        wgPrepared.session.server === 'office.conf' &&
        wgPrepared.session.profile === undefined &&
        wgPrepared.credentials === undefined &&
        (wgPrepared.wireguardConfig ?? '').includes(PRIVATE_KEY),
      'a launch needs no saved login; it holds the checked config (with the private key) in memory only',
    );
    fs.writeFileSync(wgFile, WG_CONFIG.replace('MTU = 1380', 'PostUp = calc.exe'));
    await t.throws(
      () => prepareVpn({ config: wgRun.config, storageRoot: wgSettings.storage.root }),
      'refused',
      'a config with PostUp stops the launch before anything is written',
    );
    t.check(
      wireguardFileProblem(wgFile, wgDir)?.includes('refused') === true &&
        wireguardFileProblem(path.join(wgDir, 'missing.conf'), wgDir) !== null &&
        !(wireguardFileProblem(wgFile, wgDir) ?? '').includes('PrivPlanted'),
      'doctor says a bad or missing config is a problem, without a key',
    );
    fs.writeFileSync(wgFile, WG_CONFIG);
    t.check(wireguardFileProblem('office.conf', wgDir) === null, 'a good config, even by a relative path, is fine');
    clearSecrets(wgSettings.storage.root, wgRun.dataPath);
    const wgLaunch = generateSandbox({
      packageRoot: t.packageRoot,
      run: wgRun,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: ['python', 'rust', 'cpp', 'dotnet'],
      ...(wgPrepared ? { vpn: wgPrepared } : {}),
    });
    const wgSession = fs.readFileSync(wgLaunch.sessionPath, 'utf8');
    const wgAll: string[] = [];
    const wgWalk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) wgWalk(p);
        else wgAll.push(fs.readFileSync(p, 'latin1'));
      }
    };
    wgWalk(wgLaunch.launchPath);
    const hasKey = (text: string): boolean =>
      text.includes(PRIVATE_KEY) || text.includes(PRESHARED_KEY) || text.includes('PrivPlanted');
    t.check(
      !hasKey(wgSession) && !wgAll.some(hasKey) && !fs.existsSync(path.join(wgLaunch.launchPath, 'vpn')),
      'neither the private key nor the preshared key is in session.json or any file of the launch folder',
    );
    const wgHanded = f.readJson(new RunDir(wgRun.dataPath).secretFile(wgLaunch.launchId)) as SecretsFile;
    t.check(
      (wgHanded.wireguardConfig ?? '').includes(PRIVATE_KEY) && wgHanded.vpn === undefined,
      'the config is only in the one-shot file for the sandbox',
    );
    clearSecrets(wgSettings.storage.root, wgRun.dataPath);
    t.check(
      !fs.existsSync(new RunDir(wgRun.dataPath).secretFile(wgLaunch.launchId)) &&
        vpnNotes(wgSettings.vpn).some((n) => n.includes('WireGuard private key') && n.includes('turn the tunnel off')),
      'the launch warns that the agent can read the key and turn the tunnel off',
    );

    t.section('the VPN feature: status page, login and logout');
    const sample: VpnStatus = {
      enabled: true,
      provider: 'nordvpn',
      protocol: 'udp',
      country: '',
      killSwitch: true,
      login: 'none',
      loginSavedAt: null,
      running: null,
    };
    const lines = pageLines(vpnPage(sample)).join('\n');
    t.check(
      lines.includes('Next: sandbox vpn login') &&
        VPN_WARNINGS.every((w) => lines.includes(w)) &&
        !lines.includes('Running now'),
      'vpn status page: the facts, the next step on the command line only, the warnings',
      lines,
    );
    t.equal(
      pageActions(vpnPage({ ...sample, provider: 'wireguard-file' })).map((a) =>
        a.kind === 'operation' ? a.op : a.kind,
      ),
      ['settings.set'],
      'vpn: wireguard needs no login and offers only turning the VPN on or off',
    );
    t.equal(
      pageActions(vpnPage({ ...sample, login: 'saved', loginSavedAt: '2026-10-14T09:30:00.000Z' })).map((a) =>
        a.kind === 'operation' ? a.op : a.kind,
      ),
      ['settings.set', 'vpn.login', 'vpn.logout'],
      'a saved login offers turning the VPN on or off, saving the login again and deleting it',
    );
    t.equal(vpnLoginRowOf(sample).hint, 'not saved', 'the Settings row says not saved when no login is saved');

    const featureStorage = t.dir('vpn-feature');
    const featureCtx = {
      storageRoot: featureStorage,
      dataPath: t.at('vpn-feature', 'data'),
      loaded: { config: { vpn: { ...DEFAULTS.vpn, provider: 'nordvpn' } } },
    } as unknown as AppContext;
    const read = (await runDefinition('vpn.status', featureCtx, { tunnel: false }, fakeIO().io)) as VpnStatus;
    t.check(
      read.login === 'none' && read.running === null,
      'vpn status reads the saved login without the tunnel request',
      JSON.stringify(read),
    );
    const { io: loginIO, seen: loginSeen } = fakeIO();
    await t.throws(
      () => runDefinition('vpn.login', featureCtx, { password: PASSWORD }, loginIO),
      'does not work',
      'the login is never accepted as an input',
    );
    t.check(loginSeen.questions.length === 0, 'a login passed on the command line asks nothing');

    // The on-PC guard only refuses inside a sandbox, so it is tested there; elsewhere there is nothing to assert.
    if (insideSandbox()) {
      const { io, seen } = fakeIO();
      await t.throws(
        () => runDefinition('vpn.login', featureCtx, {}, io),
        'inside the sandbox already',
        'vpn login refuses inside the sandbox',
      );
      t.check(seen.questions.length === 0, 'and asks no question first');
    }

    const service = new VpnService(featureCtx, SecretStore.memory());
    service.save({ username: USERNAME, password: PASSWORD });
    const onDisk = fs.readFileSync(path.join(featureStorage, 'vpn', 'nordvpn.json'), 'utf8');
    t.check(!onDisk.includes(PASSWORD) && !onDisk.includes(USERNAME), 'the saved file holds no login in clear');
    const report = await service.report({ tunnel: false });
    t.check(
      report.login === 'saved' &&
        !JSON.stringify(report).includes(PASSWORD) &&
        !JSON.stringify(report).includes(USERNAME),
      'a saved login shows as saved, and the status never holds it',
    );
    t.check(service.remove() && service.loginState() === 'none', 'deleting the login leaves none saved');
  },
};
