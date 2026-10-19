// Remote access (docs/design/remote-access.md): devices on your network (LAN mode, a one-time code per device) and
// other Windows users of this PC (Windows sign-in), who is in, and taking access away. Pure: schemas, texts and the
// page; access.run.ts does the work. Everything here is the owner's: a device or another Windows user never manages
// access, whatever their role.
import { z } from 'zod';
import { action, defineOperation, defineQuery, defineView, fieldOf, type Item, type Page } from '../../kernel/index.js';

const RoleSchema = z.enum(['view', 'control']);

export const DeviceRowSchema = z.object({
  id: z.string().describe('Its id (for revoke)'),
  name: z.string().describe('The name it gave itself'),
  role: RoleSchema.describe('view or control'),
  address: z.string().describe('The address it was allowed from'),
  createdAt: z.string().describe('When it was allowed (ISO time)'),
  expiresAt: z.string().describe('When it is signed out (ISO time)'),
  lastSeen: z.string().nullable().describe('When it was last used (ISO time)'),
});

export const WindowsRowSchema = z.object({
  id: z.string().describe('Its id (for revoke)'),
  user: z.string().describe('The Windows user (DOMAIN\\name)'),
  createdAt: z.string().describe('When they signed in'),
  expiresAt: z.string().describe('When they are signed out'),
});

export const AccessStatusSchema = z.object({
  lan: z.object({
    enabled: z.boolean().describe('web.remote.lan.enabled'),
    running: z.boolean().describe('The web UI listens on your network now'),
    address: z.string().nullable().describe('What a phone types: https://<address>:<port>'),
    fingerprint: z.string().nullable().describe("The certificate's SHA-256 fingerprint"),
    problem: z.string().nullable().describe('Why it is on but not listening'),
    network: z.string().nullable().describe('The network it was turned on for'),
  }),
  windowsSignIn: z.boolean().describe('web.remote.windowsSignIn'),
  users: z.array(z.object({ name: z.string(), role: RoleSchema })).describe('web.remote.users'),
  rememberDays: z.number().describe('web.remote.rememberDays'),
  devices: z.array(DeviceRowSchema),
  windows: z.array(WindowsRowSchema).describe('Windows users signed in to the web UI now'),
  pending: z
    .object({ role: RoleSchema, expiresAt: z.string() })
    .nullable()
    .describe('A device code waiting to be typed (the code itself is never kept)'),
  codeVoided: z.boolean().describe('The last code was voided after too many wrong tries'),
});
export type AccessStatus = z.output<typeof AccessStatusSchema>;

export const accessStatus = defineQuery({
  id: 'access.status',
  title: 'Remote access',
  summary: 'devices on your network and other Windows users who may use your web UI',
  input: z.object({}),
  output: AccessStatusSchema,
  access: 'owner',
  live: { everyMs: 5000 },
  text: (o) =>
    (o.lan.running && o.lan.address ? 'On your network: ' + o.lan.address : 'LAN mode is off') +
    '. ' +
    o.devices.length +
    ' device' +
    (o.devices.length === 1 ? '' : 's') +
    ', ' +
    o.windows.length +
    ' Windows sign-in' +
    (o.windows.length === 1 ? '' : 's') +
    '.',
  cli: { name: 'web', action: 'devices', json: true },
});

export const allowDevice = defineOperation({
  id: 'access.allowDevice',
  title: 'Allow a new device',
  summary: 'show a one-time code that a phone or tablet on your network types to sign in (5 minutes)',
  input: z.object({
    role: RoleSchema.default('view').describe('What the device may do: view (look) or control (everything but access)'),
  }),
  output: z.object({
    code: z.string().describe('The one-time code (ABCD-EFGH)'),
    expiresAt: z.string().describe('When it runs out'),
    role: RoleSchema,
    address: z.string().nullable().describe('What the device opens'),
    fingerprint: z.string().nullable().describe("The certificate's fingerprint, to compare on the device"),
  }),
  access: 'owner',
  keepResult: true,
  text: (o) =>
    'Code ' +
    o.code +
    ' (5 minutes, ' +
    o.role +
    '). On the device open ' +
    (o.address ?? 'the address on your network') +
    ' and type the code.' +
    (o.fingerprint ? ' Its certificate should be ' + o.fingerprint.slice(0, 23) + '...' : ''),
  cli: {
    name: 'web',
    action: 'allow-device',
    flags: { role: { flag: '--role', value: 'view|control', choices: ['view', 'control'] } },
  },
});

export const revokeAccess = defineOperation({
  id: 'access.revoke',
  title: 'Sign out',
  summary: 'sign out one device or Windows user now (its open pages close)',
  input: z.object({
    id: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .describe('The id from sandbox web devices'),
  }),
  output: z.object({ message: z.string() }),
  access: 'owner',
  text: (o) => o.message,
  cli: { name: 'web', action: 'revoke', positional: ['id'] },
});

export const revokeAllAccess = defineOperation({
  id: 'access.revokeAll',
  title: 'Sign out everyone',
  summary: 'sign out every device and Windows user now, and void a code that was not used',
  input: z.object({}),
  output: z.object({ message: z.string() }),
  access: 'owner',
  danger: true,
  text: (o) => o.message,
  cli: { name: 'web', action: 'revoke-all', yes: 'sign everyone out without asking' },
});

export const lanOn = defineOperation({
  id: 'access.lanOn',
  title: 'Turn on LAN mode',
  summary: 'let devices you allow use the web UI on your network (adds a firewall rule; Windows asks once)',
  input: z.object({}),
  output: z.object({ message: z.string(), address: z.string() }),
  access: 'owner',
  text: (o) => o.message,
  cli: { name: 'web', action: 'lan-on' },
});

export const lanOff = defineOperation({
  id: 'access.lanOff',
  title: 'Turn off LAN mode',
  summary: 'stop listening on your network, remove the firewall rule and sign out every device',
  input: z.object({}),
  output: z.object({ message: z.string() }),
  access: 'owner',
  danger: true,
  text: (o) => o.message,
  cli: { name: 'web', action: 'lan-off', yes: 'turn it off without asking' },
});

const DAY_MS = 86_400_000;

/** "in 3 days", "in 5 hours", "today". */
function untilText(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '?';
  if (ms >= DAY_MS) return 'in ' + Math.round(ms / DAY_MS) + ' days';
  if (ms >= 3_600_000) return 'in ' + Math.round(ms / 3_600_000) + ' hours';
  return 'in ' + Math.max(1, Math.round(ms / 60_000)) + ' minutes';
}

function dateText(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : 'not yet';
}

/** The Remote access page: your network, the devices, the Windows users. */
export function accessPage(o: AccessStatus, now: number = Date.now()): Page {
  const allow = action(
    allowDevice,
    {},
    {
      key: 'a',
      verb: 'allow',
      fields: [{ ...fieldOf(allowDevice.input.shape.role, ['role']), name: 'role', label: 'Role' }],
      initial: { role: 'view' },
    },
  );
  const deviceItems: Item[] = o.devices.map((d) => ({
    id: 'device:' + d.id,
    label: d.name,
    hint: d.role,
    tone: d.role === 'control' ? 'accent' : undefined,
    icon: 'device',
    description: 'From ' + d.address + ', signed out ' + untilText(d.expiresAt, now) + '.',
    details: [
      'Allowed  ' + dateText(d.createdAt),
      'Last seen  ' + dateText(d.lastSeen),
      'Ends     ' + dateText(d.expiresAt),
      'Id       ' + d.id,
    ],
    keys: 'x signs it out.',
    actions: [action(revokeAccess, { id: d.id }, { key: 'x', verb: 'sign out', label: 'Sign out ' + d.name })],
  }));
  const windowsItems: Item[] = o.windows.map((w) => ({
    id: 'windows:' + w.id,
    label: w.user,
    hint:
      o.users.find(
        (u) =>
          w.user.toLowerCase().endsWith('\\' + u.name.toLowerCase()) || w.user.toLowerCase() === u.name.toLowerCase(),
      )?.role ?? 'not on the list',
    description: 'Signed in with Windows, signed out ' + untilText(w.expiresAt, now) + '.',
    details: ['Signed in  ' + dateText(w.createdAt), 'Ends      ' + dateText(w.expiresAt), 'Id        ' + w.id],
    keys: 'x signs them out.',
    actions: [action(revokeAccess, { id: w.id }, { key: 'x', verb: 'sign out', label: 'Sign out ' + w.user })],
  }));
  const lan = o.lan;
  return {
    title: 'Remote access',
    notice: {
      text: 'Anyone you let in acts as you: control can read what your agents can read, logins included. Local network only, never the internet.',
      tone: 'warn',
    },
    sections: [
      {
        id: 'lan',
        title: 'Devices on your network',
        facts: [
          {
            id: 'lan-mode',
            label: 'LAN mode',
            value: lan.running ? 'on' : lan.enabled ? 'on, not listening' : 'off',
            tone: lan.running ? 'ok' : lan.enabled ? 'warn' : 'muted',
            description: lan.problem ?? undefined,
          },
          ...(lan.address
            ? [
                {
                  id: 'lan-address',
                  label: 'On your network',
                  value: lan.address,
                  description:
                    "Type this into the phone's browser. The first time it warns about the certificate: compare it with the one below. A warning after that means stop.",
                },
              ]
            : []),
          ...(lan.fingerprint ? [{ id: 'lan-cert', label: 'Certificate', value: lan.fingerprint }] : []),
          ...(o.pending
            ? [
                {
                  id: 'pending',
                  label: 'Code waiting',
                  value: 'for a ' + o.pending.role + ' device, ' + untilText(o.pending.expiresAt, now),
                  tone: 'accent' as const,
                },
              ]
            : []),
          ...(o.codeVoided
            ? [
                {
                  id: 'voided',
                  label: 'Last code',
                  value: 'voided after too many wrong tries',
                  tone: 'warn' as const,
                  description: 'Someone on your network may have tried to guess it. Make a new one when you are ready.',
                },
              ]
            : []),
          { id: 'remember', label: 'Stays signed in', value: o.rememberDays + ' days (web.remote.rememberDays)' },
        ],
        items: deviceItems,
        actions: lan.enabled
          ? [allow, action(lanOff, {}, { key: 'f', verb: 'LAN off' })]
          : [action(lanOn, {}, { key: 'n', verb: 'LAN on' })],
        notes: deviceItems.length ? [] : [{ text: 'No devices yet.', tone: 'muted' }],
      },
      {
        id: 'windows',
        title: 'Other Windows users of this PC',
        facts: [
          {
            id: 'windows-sign-in',
            label: 'Windows sign-in',
            value: o.windowsSignIn ? 'on' : 'off',
            tone: o.windowsSignIn ? 'ok' : 'muted',
            description:
              'They run sandbox remote (or sandbox remote --browser) as themselves. Turn on web.remote.windowsSignIn and list them in web.remote.users (Settings).',
          },
          ...o.users.map((u, i) => ({ id: 'user-' + i, label: u.name, value: u.role })),
        ],
        items: windowsItems,
      },
    ],
    actions: [action(revokeAllAccess, {}, { key: 'X', verb: 'sign out all' })],
  };
}

export const accessView = defineView({
  id: 'access',
  title: 'Remote access',
  summary: 'Devices on your network and other Windows users of this PC: allow, see, sign out.',
  queries: { status: accessStatus },
  operations: [allowDevice, revokeAccess, revokeAllAccess, lanOn, lanOff],
  build: ({ status }) => accessPage(status),
});
