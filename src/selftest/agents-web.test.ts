// Perplexity and the computer-use tools (P8): the perplexity and comet sign-ins (shapes, limits, where the key may
// and may not appear, the cookie allow-list, several sandboxes handing Comet back), the DevTools client over a fake
// socket, Codex's config.toml (MCP sign-ins in a file, the add-ons' servers), the catalogue entries, the signer
// check and the Chromium unpacking helpers. Temp folders and SecretStore.memory() only; no download, nothing run.
import fs from 'node:fs';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { importServiceFlow, loginServiceFlow, serviceRow } from '../app/features/accounts/index.js';
import { fakeIO } from '../app/kernel/index.js';
import { DEFAULTS } from '../core/config/index.js';
import { applyOverrides, normalizeOverrides, OFF_IS_SAFER } from '../core/local-config/index.js';
import { ConfigSchema, LocalOverridesSchema } from '../core/schema/index.js';
import {
  AccountLeases,
  HOST_SOURCES,
  prepareServiceAccounts,
  parseRegValue,
  ServiceAccountStore,
  takeHandoffs,
} from '../host/accounts/index.js';
import { generateSandbox, toolchainsOnForBoot } from '../host/launch/index.js';
import { handoffDir } from '../host/accounts/index.js';
import { clearSecrets, SecretStore } from '../host/secrets/index.js';
import { applyServiceAccounts } from '../guest/accounts/apply.js';
import type { GuestAdapter } from '../guest/accounts/adapter.js';
import { AccountWatch } from '../guest/accounts/watch.js';
import { cometAdapter, cometPendingFile, takePendingComet } from '../guest/accounts/kinds/comet.js';
import { perplexityAdapter } from '../guest/accounts/kinds/perplexity.js';
import { chromiumBin, keptInstaller, nextInner } from '../guest/apps/comet-unpack.js';
import {
  acceptFor,
  CdpConnection,
  encodeFrame,
  FrameReader,
  MAX_MESSAGE_BYTES,
  OPCODE,
  parseDevToolsActivePort,
  readHandshake,
} from '../guest/browser/cdp.js';
import { cometLaunchArgs, cometShortcutArgs } from '../guest/browser/comet.js';
import {
  appUsersOn,
  cometPayloadFromCookies,
  cookiesToRestore,
  fingerprint,
  MAX_COMET_COOKIES,
  PAYLOADS,
  perplexityKeyFromText,
  SERVICE_KINDS,
  SERVICE_SPECS,
  serviceWanted,
  usedByText,
  type UsedBy,
} from '../shared/accounts/index.js';
import {
  addonMcpServer,
  AGENTS_WEB_APPS,
  APPS,
  appsNeedUv,
  appsToInstall,
  codexWithAddonMcpServers,
  COMET_SIGNER,
  PERPLEXITY_COMPUTER_MCP_URL,
  signerMatches,
} from '../shared/apps/index.js';
import { RunDir } from '../shared/channel/index.js';
import type { SecretsFile } from '../shared/channel/secrets.js';
import type { Suite } from './support/suite.js';

const KEY = 'pplx-PlantedPerplexityKey0123456789abcdWXYZ';
const OTHER_SECRET = 'sk-PlantedOtherSecretInTheSameEnvFile';
const NOW = 1_800_000_000;
const DAY = 86400;

/** Every file below `dir` (text). */
function allText(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'));
}

/** A cookie as CDP reports it, signed in by default. */
const cdpCookie = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: '__Secure-next-auth.session-token',
  value: 'PlantedSessionToken.abc',
  domain: '.perplexity.ai',
  path: '/',
  expires: NOW + 30 * DAY + 1234.5,
  size: 40,
  httpOnly: true,
  secure: true,
  session: false,
  sameSite: 'Lax',
  priority: 'Medium',
  ...over,
});

/** A server's frame that is not the last of its message. */
const unfinished = (opcode: number, payload: Buffer): Buffer => {
  const frame = encodeFrame(opcode, payload, null);
  frame[0] &= 0x7f;
  return frame;
};

/** A fake browser behind a fake socket: answers the handshake, then each call with `answer`. */
function fakeBrowser(
  answer: (call: { id: number; method: string; params: unknown; sessionId?: string }) => Buffer[],
  o: { readonly badAccept?: boolean } = {},
): { socket: Duplex; seen: { method: string; sessionId?: string }[]; pongs: Buffer[] } {
  const seen: { method: string; sessionId?: string }[] = [];
  const pongs: Buffer[] = [];
  const reader = new FrameReader(MAX_MESSAGE_BYTES, true);
  let shook = false;
  const socket: Duplex = new Duplex({
    read() {
      // The test pushes the browser's bytes.
    },
    write(chunk: Buffer, _encoding, done) {
      if (!shook) {
        shook = true;
        const key = /Sec-WebSocket-Key: (\S+)/.exec(chunk.toString('latin1'))?.[1] ?? '';
        const accept = o.badAccept ? acceptFor('wrong') : acceptFor(key);
        const head = 'HTTP/1.1 101 WebSocket Protocol Handshake\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n';
        socket.push(Buffer.from(head + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'));
        // A ping right behind the handshake, in the same chunk as nothing else: the client must answer it.
        socket.push(encodeFrame(OPCODE.ping, Buffer.from('hi'), null));
      } else {
        for (const frame of reader.push(chunk)) {
          if (frame.opcode === OPCODE.pong) pongs.push(frame.payload);
          if (frame.opcode !== OPCODE.text) continue;
          const call = JSON.parse(frame.payload.toString('utf8')) as {
            id: number;
            method: string;
            params: unknown;
            sessionId?: string;
          };
          seen.push({ method: call.method, ...(call.sessionId ? { sessionId: call.sessionId } : {}) });
          // Byte by byte: frames split anywhere must still be read.
          for (const part of answer(call)) for (const byte of part) socket.push(Buffer.from([byte]));
        }
      }
      done();
    },
  });
  return { socket, seen, pongs };
}

const ENDPOINT = { port: 9222, path: '/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-0123456789ab' };

export const agentsWebSuite: Suite = {
  name: 'agents-web',
  title: 'Perplexity and computer-use tools: the two sign-ins, DevTools client, Codex config, catalogue, signer',
  run: async (t, f) => {
    t.section('the perplexity and comet kinds');
    const perplexity = SERVICE_SPECS.perplexity;
    const comet = SERVICE_SPECS.comet;
    t.check(
      SERVICE_KINDS.includes('perplexity') &&
        SERVICE_KINDS.includes('comet') &&
        DEFAULTS.accounts.perplexity.share === false &&
        DEFAULTS.accounts.comet.share === false,
      'both are kinds, and neither is shared by default',
    );
    t.check(
      perplexity.maxBytes === 1024 &&
        !perplexity.returns &&
        !perplexity.singleHolder &&
        perplexity.sources.join() === 'pc,file,typed' &&
        comet.maxBytes === 256 * 1024 &&
        comet.returns &&
        !comet.singleHolder &&
        comet.sources.join() === 'sandbox',
      'perplexity: from this PC, a file or typed, never handed back; comet: only from a sandbox, handed back, many at once',
    );
    const words = [...perplexity.warnings, ...comet.warnings].join(' ');
    t.check(
      words.includes('Perplexity Pro does not include API use; the API key is billed separately.') &&
        words.includes(
          "Your Comet sign-in can't be copied from this PC: Windows locks it to your PC account. Sign in once inside a sandbox and it is kept for the next ones.",
        ) &&
        words.includes('spending limit') &&
        words.includes('Computer credits') &&
        words.includes('prompt injection') &&
        words.includes('never saved passwords') &&
        words.includes('Never import your main browser profile') &&
        perplexity.warnings[0].startsWith('The agent in the sandbox can use') &&
        comet.warnings[0].startsWith('The agent in the sandbox can use'),
      'the wording and the security notes are in the kinds (every surface shows the warnings)',
    );
    const store = new ServiceAccountStore(t.dir('web-rows'), SecretStore.memory());
    const leases0 = new AccountLeases(t.dir('web-rows'));
    const rows = (['perplexity', 'comet'] as const).map((k) => serviceRow(k, DEFAULTS, store, leases0));
    t.check(
      rows[0].canLogin &&
        rows[0].canImport &&
        !rows[0].needsFile &&
        !rows[1].canLogin &&
        !rows[1].canImport &&
        rows[1].usedFor === 'the Comet app' &&
        rows[0].warnings.length === perplexity.warnings.length &&
        rows[1].warnings.length === comet.warnings.length,
      'their Accounts rows: perplexity can be imported (this PC or a file) or typed; comet only signs in inside',
    );
    t.check(
      OFF_IS_SAFER.includes('accounts.perplexity.share') &&
        OFF_IS_SAFER.includes('accounts.comet.share') &&
        applyOverrides(
          structuredClone(DEFAULTS),
          normalizeOverrides({ accounts: { perplexity: { share: true }, comet: { share: true } } }, f.workA, 'x'),
        ).accounts.perplexity.share === false,
      'a project file can only turn them off',
    );
    t.check(
      appUsersOn(['perplexity-mcp']).join() === 'perplexity' &&
        appUsersOn(['comet', 'rtk']).join() === 'comet' &&
        appUsersOn(['perplexity-computer-mcp', 'comet-mcp']).length === 0 &&
        serviceWanted('perplexity', new Set<UsedBy>(['perplexity'])) &&
        !serviceWanted('perplexity', new Set<UsedBy>(['comet', 'unreal'])) &&
        serviceWanted('comet', new Set<UsedBy>(['comet'])) &&
        usedByText(['reactNative', 'flutter']) === 'reactNative or flutter',
      'the key goes only where the Perplexity MCP app is on, the cookies only where Comet is',
    );
    const appsConfig = f.makeConfig();
    appsConfig.apps.install = ['perplexity-mcp', 'comet'];
    const onForBoot = toolchainsOnForBoot({ run: await f.run({}, appsConfig), pcLanguages: [] });
    t.check(onForBoot.has('perplexity') && onForBoot.has('comet'), 'a launch with those apps turns both on');

    t.section('payload shapes and limits');
    const keyOk = (apiKey: string): boolean => PAYLOADS.perplexity.safeParse({ apiKey }).success;
    t.check(
      keyOk(KEY) &&
        !keyOk('pplx-short') &&
        !keyOk('sk-' + 'a'.repeat(40)) &&
        !keyOk(KEY + '\n') &&
        !keyOk(KEY + ' extra') &&
        !keyOk('pplx-' + 'a'.repeat(201)) &&
        !PAYLOADS.perplexity.safeParse({ apiKey: KEY, more: 1 }).success,
      'a Perplexity key is pplx- and 8 to 200 key characters, nothing else',
    );
    const cookieOk = (over: Record<string, unknown>): boolean =>
      PAYLOADS.comet.safeParse({
        cookies: [
          { name: 'a', value: 'b', domain: '.perplexity.ai', path: '/', secure: true, httpOnly: true, ...over },
        ],
      }).success;
    t.check(
      cookieOk({}) &&
        cookieOk({ domain: 'www.perplexity.ai', expires: NOW, sameSite: 'Strict' }) &&
        !cookieOk({ domain: 'example.com' }) &&
        !cookieOk({ domain: 'perplexity.ai.evil.com' }) &&
        !cookieOk({ domain: 'evilperplexity.ai' }) &&
        !cookieOk({ value: 'x'.repeat(8193) }) &&
        !cookieOk({ name: 'x'.repeat(257) }) &&
        !cookieOk({ value: 'line\nbreak' }) &&
        !cookieOk({ name: 'a;b' }) &&
        !cookieOk({ path: 'relative' }) &&
        !cookieOk({ sameSite: 'Sometimes' }) &&
        !cookieOk({ password: 'x' }),
      'a kept cookie is a perplexity.ai cookie of bounded, printable text, and nothing more',
    );
    const many = Array.from({ length: MAX_COMET_COOKIES + 1 }, (_, i) => ({
      name: 'c' + i,
      value: 'v',
      domain: '.perplexity.ai',
      path: '/',
      secure: true,
      httpOnly: true,
    }));
    t.check(
      !PAYLOADS.comet.safeParse({ cookies: many }).success &&
        PAYLOADS.comet.safeParse({ cookies: many.slice(1) }).success &&
        !PAYLOADS.comet.safeParse({ cookies: [] }).success,
      'at most ' + MAX_COMET_COOKIES + ' cookies, and at least one',
    );

    t.section('a key from a .env file');
    const env = [
      '# keys',
      'OPENAI_API_KEY=' + OTHER_SECRET,
      'export PERPLEXITY_API_KEY="pplx-old0123456789"',
      'PERPLEXITY_API_KEY=' + KEY + '  # the new one',
      'OTHER=1',
    ].join('\r\n');
    t.equal(perplexityKeyFromText(env), { apiKey: KEY }, 'its PERPLEXITY_API_KEY line is read (the last one wins)');
    t.equal(perplexityKeyFromText('\uFEFF' + KEY + '\n'), { apiKey: KEY }, 'a file holding only the key is read');
    t.equal(perplexityKeyFromText("PERPLEXITY_API_KEY='" + KEY + "'"), { apiKey: KEY }, 'quotes are taken off');
    t.check(
      perplexityKeyFromText('OPENAI_API_KEY=' + OTHER_SECRET) === null &&
        perplexityKeyFromText('PERPLEXITY_API_KEY=not-a-key') === null &&
        perplexityKeyFromText('') === null,
      'a file without a Perplexity key gives none (another key is never taken instead)',
    );
    const flowStore = new ServiceAccountStore(t.dir('web-flow'), SecretStore.memory());
    const envFile = t.write(t.at('web-env', '.env'), env);
    const imported = await importServiceFlow(fakeIO([true]).io, 'perplexity', envFile, {
      store: flowStore,
      pc: { localAppData: '', appData: '', programData: '' },
      share: false,
    });
    const sealedFiles = allText(path.join(t.at('web-flow'), 'accounts')).join('\n');
    t.check(
      flowStore.read('perplexity')?.apiKey === KEY &&
        flowStore.info('perplexity')?.source === 'file' &&
        flowStore.info('perplexity')?.summary === 'pplx-...WXYZ' &&
        !sealedFiles.includes(KEY) &&
        !sealedFiles.includes(OTHER_SECRET) &&
        imported.message.includes('Share with sandboxes'),
      'import --from .env saves only the key, sealed; the status shows pplx-... and its last 4 characters',
    );
    await t.throws(
      () =>
        importServiceFlow(fakeIO([true]).io, 'perplexity', t.write(t.at('web-env', 'none.env'), 'A=1'), {
          store: flowStore,
          pc: { localAppData: '', appData: '', programData: '' },
          share: false,
        }),
      'holds no Perplexity API key',
      'a file without the key is refused',
    );
    const big = t.write(t.at('web-env', 'big.env'), '# pad\n'.repeat(4000) + 'PERPLEXITY_API_KEY=' + KEY);
    await importServiceFlow(fakeIO([true]).io, 'perplexity', big, {
      store: flowStore,
      pc: { localAppData: '', appData: '', programData: '' },
      share: false,
    });
    t.check(flowStore.read('perplexity')?.apiKey === KEY, 'a .env file bigger than the key itself is read (bounded)');
    const noPc = { localAppData: '', appData: '', programData: '' };
    let hkcuReads = 0;
    const fromTerminal = await importServiceFlow(fakeIO([true]).io, 'perplexity', undefined, {
      store: flowStore,
      pc: {
        ...noPc,
        env: { PERPLEXITY_API_KEY: ' "' + KEY + '" ' },
        userVariable: () => (hkcuReads++, 'pplx-unused0123456789'),
      },
      share: false,
    });
    t.check(
      flowStore.read('perplexity')?.apiKey === KEY &&
        flowStore.info('perplexity')?.source === 'pc' &&
        hkcuReads === 0 &&
        !fromTerminal.message.includes(KEY),
      "import without --from takes this PC's PERPLEXITY_API_KEY (this terminal's first, unquoted; HKCU not read), never printing it",
    );
    const asked: string[] = [];
    await importServiceFlow(fakeIO([true]).io, 'perplexity', undefined, {
      store: flowStore,
      pc: { ...noPc, env: {}, userVariable: (name) => (asked.push(name), '"' + KEY.replace('WXYZ', 'USER') + '"') },
      share: false,
    });
    t.check(
      flowStore.read('perplexity')?.apiKey === KEY.replace('WXYZ', 'USER') && asked.join() === 'PERPLEXITY_API_KEY',
      "else your saved Windows user environment's (HKCU\\Environment)",
    );
    const none = await importServiceFlow(fakeIO([true]).io, 'perplexity', undefined, {
      store: flowStore,
      pc: { ...noPc, env: { PERPLEXITY_API_KEY: 'not-a-key' }, userVariable: () => null },
      share: false,
    });
    t.check(none.message.includes('PERPLEXITY_API_KEY is not set'), 'no key on this PC: it says how else to save one');
    t.equal(
      [
        parseRegValue(
          '\r\nHKEY_CURRENT_USER\\Environment\r\n    PERPLEXITY_API_KEY    REG_SZ    ' + KEY + '\r\n',
          'PERPLEXITY_API_KEY',
        ),
        parseRegValue('    OTHER    REG_SZ    x', 'PERPLEXITY_API_KEY'),
      ],
      [KEY, null],
      "reg.exe's answer is read for that one value only",
    );
    await t.throws(
      () => importServiceFlow(fakeIO([true]).io, 'comet', undefined, { store: flowStore, pc: noPc, share: false }),
      "can't be copied from this PC",
      "Comet import says why it can't be copied from this PC",
    );
    await t.throws(
      () => loginServiceFlow(fakeIO([]).io, 'comet', { store: flowStore, share: false }),
      'Windows locks it to your PC account',
      'and so does Comet login',
    );
    const typedIO = fakeIO([KEY]);
    await loginServiceFlow(typedIO.io, 'perplexity', { store: flowStore, share: true });
    const typedQuestion = JSON.stringify(typedIO.seen.questions);
    t.check(
      flowStore.info('perplexity')?.source === 'typed' &&
        typedIO.seen.questions.length === 1 &&
        (typedIO.seen.questions[0] as { kind: string }).kind === 'secret' &&
        !typedQuestion.includes(KEY),
      'login asks for the key once, hidden',
    );
    await t.throws(
      () => loginServiceFlow(fakeIO(['sk-nope']).io, 'perplexity', { store: flowStore, share: true }),
      '',
      'a typed value that is not a Perplexity key is refused',
    );
    t.check(
      !HOST_SOURCES.comet.fromPc && !HOST_SOURCES.comet.fromFile && !HOST_SOURCES.comet.fromAnswers,
      "Comet's sign-in is never taken from this PC, a file or typing",
    );

    t.section('the key never sits in a file the sandbox keeps');
    const config = f.makeConfig();
    config.accounts.perplexity.share = true;
    config.apps.install = ['perplexity-mcp'];
    const run = await f.run({}, config);
    const launched = generateSandbox({
      packageRoot: t.packageRoot,
      run,
      harnessArgs: [],
      probe: f.probe,
      pcLanguages: [],
      serviceAccounts: { perplexity: { apiKey: KEY } },
    });
    const runDir = new RunDir(run.dataPath);
    const secretsFile = runDir.secretFile(launched.launchId);
    t.check(
      !allText(launched.launchPath).some((text) => text.includes(KEY)) &&
        !allText(runDir.root).some((text) => text.includes(KEY)),
      'not in session.json, the launch folder or <data>\\run',
    );
    t.equal(
      f.readJson<SecretsFile>(secretsFile).serviceAccounts?.perplexity?.apiKey,
      KEY,
      'only in the one-shot secrets file',
    );
    clearSecrets(config.storage.root, run.dataPath);
    const local = t.dir('web-guest-local');
    const oldLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = local;
    try {
      const guestRoot = t.dir('web-guest-accounts');
      const given = await applyServiceAccounts({ perplexity: { apiKey: KEY } }, { root: guestRoot });
      const applied = await perplexityAdapter.apply({ apiKey: KEY });
      t.check(
        given.PERPLEXITY_API_KEY === KEY &&
          Object.keys(applied.env ?? {}).join() === 'PERPLEXITY_API_KEY' &&
          !applied.summary.includes(KEY) &&
          !allText(guestRoot).some((text) => text.includes(KEY)) &&
          allText(local).length === 0,
        'in the sandbox it is only PERPLEXITY_API_KEY in memory: delivered.json and the profile never hold it',
      );

      t.section("Comet's sign-in in the sandbox");
      const payload = {
        cookies: [
          { name: 'a', value: 'PlantedCookie', domain: '.perplexity.ai', path: '/', secure: true, httpOnly: true },
        ],
      };
      const summary = (await cometAdapter.apply(payload)).summary;
      const pending = cometPendingFile();
      t.check(
        pending.startsWith(path.join(local, 'AgentSandbox', 'accounts', 'comet')) &&
          fs.existsSync(pending) &&
          !summary.includes('PlantedCookie'),
        "it waits for Comet in the sandbox's own accounts folder (wiped with the sandbox)",
      );
      t.equal(takePendingComet(), payload, 'the apps step takes it once Comet is there');
      t.check(!fs.existsSync(pending) && takePendingComet() === null, 'and the file is gone');
      fs.mkdirSync(path.dirname(pending), { recursive: true });
      fs.writeFileSync(pending, JSON.stringify({ cookies: [{ ...payload.cookies[0], domain: 'bank.example' }] }));
      t.check(takePendingComet() === null && !fs.existsSync(pending), 'one of the wrong shape is dropped');
      t.check(cometAdapter.current?.() !== undefined, 'the watch can look at what Comet holds');
      const args = cometLaunchArgs(0, 'C:\\P');
      t.check(
        args.includes('--user-data-dir=C:\\P') &&
          args.includes('--remote-debugging-port=0') &&
          args.includes('--remote-debugging-address=127.0.0.1') &&
          cometShortcutArgs(9222, 'C:\\With Space').startsWith(
            '"--user-data-dir=C:\\With Space" --remote-debugging-port=9222',
          ),
        "Comet starts on the sandbox's profile, DevTools on 127.0.0.1 only (any free port, 9222 for comet-mcp)",
      );
    } finally {
      if (oldLocal === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = oldLocal;
    }

    t.section('the cookie allow-list');
    const jar = [
      cdpCookie(),
      cdpCookie({ name: 'pplx.visitor', domain: 'www.perplexity.ai', expires: NOW + DAY }),
      cdpCookie({ name: 'bank', domain: '.bank.example' }),
      cdpCookie({ name: 'look-alike', domain: 'perplexity.ai.evil.com' }),
      cdpCookie({ name: 'script', httpOnly: false }),
      cdpCookie({ name: 'tab', session: true, expires: -1 }),
      cdpCookie({ name: 'old', expires: NOW - 1 }),
      cdpCookie({ name: '__cf_bm' }),
      cdpCookie({ name: 'third', partitionKey: { topLevelSite: 'https://x.example' } }),
      'not a cookie',
      null,
    ];
    const kept = cometPayloadFromCookies(jar, NOW);
    t.equal(
      kept?.cookies.map((c) => c.name),
      ['__Secure-next-auth.session-token', 'pplx.visitor'],
      "only perplexity.ai's own persistent HttpOnly cookies are kept (no other site, script, session, partitioned or Cloudflare cookie)",
    );
    t.check(
      kept?.cookies[0].expires === Math.floor((NOW + 30 * DAY + 1234.5) / 3600) * 3600 &&
        kept.cookies[0].sameSite === 'Lax' &&
        !('size' in kept.cookies[0]) &&
        !('priority' in kept.cookies[0]),
      'kept to the hour, only the fields setCookies needs',
    );
    t.equal(
      fingerprint(cometPayloadFromCookies([...jar].reverse(), NOW + 60)),
      fingerprint(kept),
      'the same sign-in looks the same in any order and a minute later (no handoff for nothing)',
    );
    t.check(
      cometPayloadFromCookies([cdpCookie({ name: 'script', httpOnly: false })], NOW) === null &&
        cometPayloadFromCookies(
          Array.from({ length: MAX_COMET_COOKIES + 1 }, (_, i) => cdpCookie({ name: 'n' + i })),
          NOW,
        ) === null,
      'no sign-in cookie, or more than a sign-in could need: none',
    );
    t.equal(
      kept ? cookiesToRestore(kept, NOW + 2 * DAY).map((c) => c.name) : [],
      ['__Secure-next-auth.session-token'],
      'only cookies still valid are written back',
    );

    t.section('several sandboxes hand Comet back');
    const shared = f.makeConfig();
    shared.accounts.comet.share = true;
    const root = shared.storage.root;
    const signIns = new ServiceAccountStore(root, SecretStore.memory());
    const leases = new AccountLeases(root);
    const runA = await f.run({}, shared);
    const dataB = path.join(root, 'data', 'second');
    const deliver = (dataPath: string, launchId: string): ReturnType<typeof prepareServiceAccounts> =>
      prepareServiceAccounts({
        config: shared,
        others: [],
        on: new Set<UsedBy>(['comet']),
        storageRoot: root,
        dataPath,
        launchId,
        isRunning: () => true,
        store: signIns,
        leases,
      });
    const first = deliver(runA.dataPath, 'L-a');
    const second = deliver(dataB, 'L-b');
    t.check(
      first.leased.includes('comet') &&
        second.leased.includes('comet') &&
        !first.payloads.comet &&
        first.notes.some((n) => n.includes('sign in to Comet once in this sandbox')) &&
        !first.notes.some((n) => n.includes('in use by sandbox')),
      'nothing saved yet: both sandboxes may sign in and hand it back, neither waits for the other',
    );
    const hand = (dataPath: string, launchId: string, value: string): void => {
      t.write(
        path.join(handoffDir(dataPath), 'comet.json'),
        JSON.stringify({
          kind: 'comet',
          launchId,
          payload: { cookies: [{ ...payload0(), value }] },
        }),
      );
    };
    const payload0 = (): Record<string, unknown> => ({
      name: 's',
      domain: '.perplexity.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      expires: NOW + DAY,
    });
    hand(runA.dataPath, 'L-a', 'from-a');
    hand(dataB, 'L-b', 'from-b');
    const tookA = takeHandoffs(runA.dataPath, false, signIns, leases);
    const tookB = takeHandoffs(dataB, false, signIns, leases);
    t.check(
      tookA.taken.includes('comet') &&
        tookB.taken.includes('comet') &&
        signIns.read('comet')?.cookies[0].value === 'from-b' &&
        signIns.info('comet')?.summary === '1 perplexity.ai sign-in cookie',
      'each sandbox hands its sign-in back; the last one is kept',
    );
    hand(runA.dataPath, 'L-old', 'stale');
    t.check(
      takeHandoffs(runA.dataPath, true, signIns, leases).dropped.includes('comet') &&
        signIns.read('comet')?.cookies[0].value === 'from-b' &&
        leases.leaseOf('comet', path.basename(runA.dataPath)) === null &&
        leases.leaseOf('comet', 'second') !== null,
      "one from an older launch is dropped; a sandbox's last sync lets go of its own lease only",
    );
    t.check(
      deliver(runA.dataPath, 'L-c').payloads.comet?.cookies[0].value === 'from-b',
      'the next sandbox gets the newest sign-in',
    );

    t.section('the watch asks Comet first');
    const watchRoot = t.dir('web-watch');
    const fake = { held: null as unknown, asked: 0 };
    const fakeComet: GuestAdapter<'comet'> = {
      kind: 'comet',
      apply: () => ({ summary: 'fake' }),
      refresh: async () => {
        fake.asked++;
        fake.held = { cookies: [{ ...payload0(), value: 'renewed' }] };
        await Promise.resolve();
      },
      current: () => fake.held as never,
    };
    await applyServiceAccounts(
      { comet: { cookies: [{ ...payload0(), value: 'given' }] } as never },
      { leased: ['comet'], root: watchRoot, adapters: { comet: fakeComet } },
    );
    const guestData = t.dir('web-watch-data');
    const watch = new AccountWatch(['comet'], {
      dataDir: guestData,
      launchId: 'L-w',
      root: watchRoot,
      adapters: { comet: fakeComet },
    });
    await watch.flush(true);
    const back = path.join(guestData, 'state', 'accounts', 'comet.json');
    t.check(
      fake.asked === 1 &&
        fs.existsSync(back) &&
        f.readJson<{ payload: { cookies: { value: string }[] } }>(back).payload.cookies[0].value === 'renewed',
      'a flush waits for the asynchronous read, then hands back what changed',
    );

    t.section('the DevTools client');
    t.equal(
      parseDevToolsActivePort('56789\n/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-0123456789ab\n'),
      { port: 56789, path: '/devtools/browser/0b1c2d3e-aaaa-bbbb-cccc-0123456789ab' },
      'DevToolsActivePort: the port and the browser target',
    );
    t.check(
      parseDevToolsActivePort('') === null &&
        parseDevToolsActivePort('70000\n/devtools/browser/x') === null &&
        parseDevToolsActivePort('9222\n/devtools/page/x') === null &&
        parseDevToolsActivePort('9222\n/devtools/browser/../../etc') === null &&
        parseDevToolsActivePort('9222 \n/devtools/browser/a b') === null,
      'anything else in that file is refused',
    );
    const roundTrip = (n: number): boolean => {
      const payload = Buffer.alloc(n, 7);
      const frames = new FrameReader(MAX_MESSAGE_BYTES, true).push(encodeFrame(OPCODE.text, payload));
      return frames.length === 1 && frames[0].fin && frames[0].payload.equals(payload);
    };
    t.check(
      roundTrip(0) && roundTrip(125) && roundTrip(126) && roundTrip(65535) && roundTrip(70000),
      'frames of every length size round-trip, masked',
    );
    const refuses = (bytes: Buffer, max = MAX_MESSAGE_BYTES): boolean => {
      try {
        new FrameReader(max).push(bytes);
        return false;
      } catch {
        return true;
      }
    };
    t.check(
      refuses(encodeFrame(OPCODE.text, Buffer.from('x'))) &&
        refuses(Buffer.from([0xc1, 0x00])) &&
        refuses(Buffer.from([0x83, 0x00])) &&
        refuses(unfinished(OPCODE.ping, Buffer.alloc(1))) &&
        refuses(Buffer.from([0x81, 127, 0, 0, 0, 1, 0, 0, 0, 0])) &&
        refuses(encodeFrame(OPCODE.text, Buffer.alloc(2000), null), 1000),
      'a masked or reserved-bit frame, an unknown type, a split control frame and an oversized frame are refused',
    );
    t.check(
      new FrameReader().push(encodeFrame(OPCODE.text, Buffer.from('hello'), null).subarray(0, 4)).length === 0,
      'a frame cut short waits for the rest',
    );
    await t.throws(
      () => Promise.resolve(readHandshake(Buffer.from('HTTP/1.1 403 Forbidden\r\n\r\n'), 'k')),
      'refused',
      'a handshake that is not a switch to WebSocket is refused',
    );
    const browser = fakeBrowser((call) => {
      if (call.method === 'Target.getTargets') {
        const body = Buffer.from(
          JSON.stringify({ id: call.id, result: { targetInfos: [{ targetId: 'T1', type: 'page' }] } }),
        );
        // One message in two frames: a text frame that is not the last, then its continuation.
        return [
          unfinished(OPCODE.text, body.subarray(0, 10)),
          encodeFrame(OPCODE.continuation, body.subarray(10), null),
        ];
      }
      if (call.method === 'Fail.me')
        return [
          encodeFrame(OPCODE.text, Buffer.from(JSON.stringify({ id: call.id, error: { message: 'nope' } })), null),
        ];
      const event = Buffer.from(JSON.stringify({ method: 'Target.targetCreated', params: {} }));
      const result = Buffer.from(JSON.stringify({ id: call.id, result: { echoed: call.sessionId ?? null } }));
      return [encodeFrame(OPCODE.text, event, null), encodeFrame(OPCODE.text, result, null)];
    });
    const cdp = await CdpConnection.over(browser.socket, ENDPOINT, 3000);
    const targets = await cdp.call<{ targetInfos: { targetId: string }[] }>('Target.getTargets');
    const echoed = await cdp.call<{ echoed: string | null }>('Network.getCookies', { urls: [] }, { sessionId: 'S1' });
    t.check(
      targets.targetInfos[0].targetId === 'T1' &&
        echoed.echoed === 'S1' &&
        browser.seen.map((s) => s.method).join() === 'Target.getTargets,Network.getCookies' &&
        browser.seen[1].sessionId === 'S1',
      'calls get their answers (split frames, byte by byte, events in between, a page session)',
    );
    t.check(browser.pongs.length === 1 && browser.pongs[0].toString() === 'hi', 'a ping is answered with its pong');
    await t.throws(() => cdp.call('Fail.me'), 'nope', "the browser's error is the call's error");
    cdp.close();
    await t.throws(() => cdp.call('Target.getTargets'), 'closed', 'a closed connection takes no more calls');
    const impostor = fakeBrowser(() => [], { badAccept: true });
    await t.throws(
      () => CdpConnection.over(impostor.socket, ENDPOINT, 3000),
      'does not match',
      'a server that does not answer the WebSocket key is refused',
    );

    t.section("Codex's config.toml");
    t.check(
      DEFAULTS.harnesses.codex.home?.loginFiles.includes('.credentials.json') === true &&
        DEFAULTS.harnesses.codex.home?.loginFiles.includes('auth.json') === true,
      "Codex's saved logins carry its MCP sign-ins (.credentials.json) beside auth.json",
    );
    const knownCodex = APPS.flatMap((a) => (a.mcp?.codex ? [a.mcp.name] : []));
    const perplexityEntry = APPS.find((a) => a.id === 'perplexity-mcp')!;
    const computerEntry = APPS.find((a) => a.id === 'perplexity-computer-mcp')!;
    const pplxServer = addonMcpServer('C:\\AgentData\\tools\\apps\\perplexity-mcp', perplexityEntry.mcp!)!;
    const computerServer = addonMcpServer('C:\\AgentData\\tools\\apps\\perplexity-computer-mcp', computerEntry.mcp!)!;
    const mine =
      '[mcp_servers.mine]\ncommand = "mine.exe"\n\n[mcp_servers.sbx-perplexity]\ncommand = "old"\n[mcp_servers."sbx-perplexity".env]\nX = "1"\n\n[profiles.p]\nmodel = "o3"\n';
    const added = codexWithAddonMcpServers(
      mine,
      {
        'sbx-perplexity': { ...pplxServer, envVars: ['PERPLEXITY_API_KEY'] },
        'sbx-perplexity-computer': computerServer,
      },
      knownCodex,
    );
    t.check(
      added.changed &&
        added.toml.includes('[mcp_servers.mine]\ncommand = "mine.exe"') &&
        added.toml.includes('[profiles.p]\nmodel = "o3"') &&
        !added.toml.includes('command = "old"') &&
        !added.toml.includes('X = "1"') &&
        added.toml.includes('env_vars = ["PERPLEXITY_API_KEY"]') &&
        added.toml.includes(
          'args = ["C:\\\\AgentData\\\\tools\\\\apps\\\\perplexity-mcp\\\\node_modules\\\\@perplexity-ai\\\\mcp-server\\\\dist\\\\index.js"]',
        ) &&
        added.toml.includes('[mcp_servers.sbx-perplexity-computer]\n# Set by the sandbox') &&
        added.toml.includes('url = "' + PERPLEXITY_COMPUTER_MCP_URL + '"') &&
        !added.toml.includes(KEY),
      'the add-ons go in as [mcp_servers.sbx-...] (an old copy replaced, your servers and profiles kept, no key)',
    );
    t.check(
      !codexWithAddonMcpServers(
        added.toml,
        {
          'sbx-perplexity': { ...pplxServer, envVars: ['PERPLEXITY_API_KEY'] },
          'sbx-perplexity-computer': computerServer,
        },
        knownCodex,
      ).changed,
      'writing the same again changes nothing',
    );
    const removed = codexWithAddonMcpServers(added.toml, {}, knownCodex);
    t.check(
      removed.changed &&
        !removed.toml.includes('sbx-') &&
        removed.toml.includes('[mcp_servers.mine]') &&
        removed.toml.includes('[profiles.p]'),
      'turned off: their tables are removed, nothing else',
    );
    const inline = '[mcp_servers]\nsbx-perplexity = { command = "mine" }\n';
    const clash = codexWithAddonMcpServers(inline, { 'sbx-perplexity': pplxServer }, knownCodex);
    t.check(
      clash.skipped.join() === 'sbx-perplexity' && !clash.changed,
      'a name used some other way in the file is left out (never the same key twice)',
    );
    t.check(
      !codexWithAddonMcpServers('', {}, knownCodex).changed &&
        !codexWithAddonMcpServers('model = "o3"\r\n', {}, knownCodex).changed,
      'nothing on and nothing there: the file is not touched',
    );

    t.section('the catalogue entries');
    const ids = [
      'perplexity-mcp',
      'perplexity-computer-mcp',
      'comet',
      'comet-mcp',
      'chrome-devtools-mcp',
      'browser-use-mcp',
    ];
    t.equal(
      AGENTS_WEB_APPS.map((a) => a.id),
      ids,
      'the six entries',
    );
    for (const entry of AGENTS_WEB_APPS) {
      t.check(
        APPS.filter((a) => a.id === entry.id).length === 1 &&
          entry.userOnly === true &&
          ['agents', 'browsers'].includes(entry.category) &&
          !LocalOverridesSchema.safeParse({ apps: { install: [entry.id] } }).success &&
          ConfigSchema.shape.apps.shape.install.safeParse([entry.id]).success &&
          (!entry.mcp || (entry.mcp.name.startsWith('sbx-') && entry.service === true)),
        entry.id + ': listed once, yours only (a project cannot turn it on); an MCP server is sbx-... and a service',
      );
      const source = entry.source;
      if ('locked' in source) {
        const lockDir = path.join(t.packageRoot, 'sandbox', 'addons', entry.id);
        if (source.locked === 'npm') {
          const manifest = JSON.parse(fs.readFileSync(path.join(lockDir, 'package.json'), 'utf8')) as {
            dependencies: Record<string, string>;
          };
          const lock = JSON.parse(fs.readFileSync(path.join(lockDir, 'package-lock.json'), 'utf8')) as {
            lockfileVersion: number;
            packages: Record<string, { version?: string; resolved?: string; integrity?: string; link?: boolean }>;
          };
          const deps = Object.entries(lock.packages).filter(([k]) => k !== '');
          t.check(
            manifest.dependencies[source.package] === source.version &&
              Object.keys(manifest.dependencies).length === 1 &&
              lock.lockfileVersion === 3 &&
              lock.packages['node_modules/' + source.package]?.version === source.version &&
              deps.every(
                ([, p]) =>
                  !p.link &&
                  (p.resolved ?? '').startsWith('https://registry.npmjs.org/') &&
                  /^sha512-[A-Za-z0-9+/]+=*$/.test(p.integrity ?? ''),
              ) &&
              (!entry.mcp?.script || lock.packages['node_modules/' + source.package] !== undefined),
            entry.id +
              ': its lock file pins ' +
              source.package +
              ' ' +
              source.version +
              ', every package from npm with a sha512',
          );
        } else {
          const lines = fs.readFileSync(path.join(lockDir, 'requirements.txt'), 'utf8').split(/\r?\n/);
          const pins = lines.filter((l) => /^[A-Za-z0-9]/.test(l));
          t.check(
            pins.includes(source.package + '==' + source.version + ' \\') &&
              pins.every((l) => /^[A-Za-z0-9._-]+(\[[^\]]+\])?==[^\s]+ \\$/.test(l)) &&
              lines
                .join('\n')
                .split(/\n(?=[A-Za-z0-9])/)
                .slice(1)
                .every((b) => /--hash=sha256:[0-9a-f]{64}/.test(b)) &&
              !lines.some((l) => /^\s*(-e|--index-url|--extra-index-url|-f|--find-links|git\+|https?:)/.test(l.trim())),
            entry.id + ': its requirements.txt pins every package with SHA-256 hashes, from PyPI only',
          );
        }
      }
    }
    const cometEntry = APPS.find((a) => a.id === 'comet')!;
    t.check(
      cometEntry.unpack === 'chromium' &&
        cometEntry.needs?.includes('7zip') === true &&
        cometEntry.signer === COMET_SIGNER &&
        'resolve' in cometEntry.source &&
        appsToInstall({ install: ['comet'], custom: {} }, 'full').entries[0].id === '7zip',
      'comet: unpacked with 7-Zip (brought first), its signer checked',
    );
    t.check(
      'remote' in computerEntry.source &&
        computerServer.type === 'http' &&
        computerServer.type === 'http' &&
        PERPLEXITY_COMPUTER_MCP_URL.startsWith('https://www.perplexity.ai/') &&
        pplxServer.type === 'stdio' &&
        Object.keys(pplxServer.env).length === 0 &&
        perplexityEntry.mcp?.envVars?.join() === 'PERPLEXITY_API_KEY',
      'Perplexity Computer is a remote HTTP server (nothing installed); the API server reads its key from the environment only',
    );
    const browserUse = APPS.find((a) => a.id === 'browser-use-mcp')!;
    const buServer = addonMcpServer('C:\\x', browserUse.mcp!, { exe: 'C:\\x\\venv\\Scripts\\browser-use.exe' });
    t.check(
      addonMcpServer('C:\\x', browserUse.mcp!) === null &&
        buServer?.type === 'stdio' &&
        buServer.command === 'C:\\x\\venv\\Scripts\\browser-use.exe' &&
        buServer.args.join() === '--mcp' &&
        buServer.env.ANONYMIZED_TELEMETRY === 'false' &&
        appsNeedUv({ install: ['browser-use-mcp'], custom: {} }),
      'browser-use: its own program runs the server, telemetry off; it brings the uv step',
    );
    const devtools = addonMcpServer('C:\\y', APPS.find((a) => a.id === 'chrome-devtools-mcp')!.mcp!);
    t.check(
      devtools?.type === 'stdio' &&
        devtools.args.includes('--isolated') &&
        devtools.args.includes('--no-usage-statistics') &&
        devtools.args.some((a) => a.endsWith('msedge.exe')),
      'chrome-devtools-mcp: Edge with a throwaway profile, no usage statistics',
    );
    const withPath = addonMcpServer('C:\\z', APPS.find((a) => a.id === 'comet-mcp')!.mcp!, {
      env: { COMET_PATH: 'C:\\comet\\comet.exe' },
    });
    t.check(
      withPath?.type === 'stdio' && withPath.env.COMET_PATH === 'C:\\comet\\comet.exe',
      'comet-mcp is told where Comet is',
    );

    t.section("Comet's signer");
    const signed = {
      subject:
        'CN="PERPLEXITY AI, INC.", O="PERPLEXITY AI, INC.", L=San Francisco, S=California, C=US, SERIALNUMBER=1234, OID.2.5.4.15=Private Organization',
      issuer: 'CN=GlobalSign GCC R45 EV CodeSigning CA 2020, O=GlobalSign nv-sa, C=BE',
    };
    t.check(signerMatches(signed, COMET_SIGNER), 'Perplexity AI, Inc. with its GlobalSign EV certificate passes');
    t.check(
      !signerMatches(null, COMET_SIGNER) &&
        !signerMatches(
          { ...signed, subject: signed.subject.replace('O="PERPLEXITY AI, INC."', 'O=Someone Else') },
          COMET_SIGNER,
        ) &&
        !signerMatches(
          { ...signed, subject: 'CN="PERPLEXITY AI, INC. EVIL", O="PERPLEXITY AI, INC. EVIL"' },
          COMET_SIGNER,
        ) &&
        !signerMatches({ ...signed, issuer: 'CN=Some Other CA, O=X' }, COMET_SIGNER) &&
        !signerMatches({ subject: '', issuer: signed.issuer }, COMET_SIGNER),
      'unsigned, another organisation, a look-alike name or another CA is refused',
    );

    t.section("unpacking Comet's installer");
    const stage = t.dir('web-unpack');
    t.write(path.join(stage, 'a', 'UPDATER.PACKED.7Z'), 'x');
    t.write(path.join(stage, 'b', 'mini_installer.exe'), 'x');
    t.check(path.basename(nextInner(stage) ?? '') === 'mini_installer.exe', 'the latest stage found is opened next');
    t.write(path.join(stage, 'c', 'chrome.7z'), 'x');
    t.check(path.basename(nextInner(stage) ?? '') === 'chrome.7z', 'down to chrome.7z');
    t.check(chromiumBin(stage, 'comet.exe') === null, 'no Chrome-bin yet');
    fs.mkdirSync(path.join(stage, 'd', 'Chrome-bin'), { recursive: true });
    t.check(chromiumBin(stage, 'comet.exe') === null, 'a Chrome-bin without the browser does not count');
    t.write(path.join(stage, 'd', 'Chrome-bin', 'comet.exe'), 'x');
    t.equal(chromiumBin(stage, 'comet.exe'), path.join(stage, 'd', 'Chrome-bin'), 'the browser folder is found');
    const appDir = t.dir('web-kept');
    t.check(keptInstaller(appDir) === null, 'no installer kept when it was unpacked');
    t.write(path.join(appDir, 'installer', 'comet_installer.exe'), 'x');
    t.equal(keptInstaller(appDir), path.join(appDir, 'installer', 'comet_installer.exe'), 'a kept installer is found');
  },
};
