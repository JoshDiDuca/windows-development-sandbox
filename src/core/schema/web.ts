// The web UI settings (sandbox web): not part of LocalOverrides, a repo never turns a way into your agents on. The
// remote group (other Windows users of this PC, devices on your network) is off by default: docs/design/remote-access.md.
import { z } from 'zod';

export const WEB_DEFAULT_PORT = 47800;
export const WEB_LAN_DEFAULT_PORT = 47801;
export const REMOTE_ROLES = ['view', 'control'] as const;
export type RemoteRole = (typeof REMOTE_ROLES)[number];

/** A Windows account name: "bob", "PC\bob" or "DOMAIN\bob" (no paths, quotes or wildcards). */
export const WindowsUserNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9._ -]{0,62}\\)?[^\\/"[\]:;|=,+*?<>@]{1,64}$/,
    'a Windows user name (name or DOMAIN\\name)',
  );

export const RemoteUserSchema = z.strictObject({
  name: WindowsUserNameSchema.describe('The Windows user (name, or DOMAIN\\name)'),
  role: z
    .enum(REMOTE_ROLES)
    .describe('view: sees everything, terminals read-only. control: everything but remote access, logins and tokens.'),
});
export type RemoteUser = z.output<typeof RemoteUserSchema>;

export const WebLanSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      '(Beta) Devices on your network (a phone): an HTTPS address on this PC for devices you pair with a one-time code (sandbox web pair). Needs a firewall rule (sandbox web lan on asks Windows once). Off: every paired device is signed out.',
    ),
  port: z.number().int().min(1024).max(65535).describe('HTTPS port for paired devices on your network.'),
  address: z
    .string()
    .trim()
    .max(15)
    .regex(/^$|^\d{1,3}(\.\d{1,3}){3}$/, 'an IPv4 address or empty')
    .describe("This PC's private address to listen on. Empty: the one of its network adapter (never a public one)."),
});

export const WebRemoteSchema = z.strictObject({
  windowsSignIn: z
    .boolean()
    .describe(
      '(Beta) Other Windows users of this PC named in web.remote.users sign in to your web UI (and sandbox remote) with their own Windows account: no password, no link.',
    ),
  users: z
    .array(RemoteUserSchema)
    .max(32)
    .describe('Who else may sign in with Windows, and their role (view or control).'),
  rememberDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .describe('How many days a paired device or a Windows sign-in stays signed in (from when it signed in, not renewed).'),
  lan: WebLanSchema,
});
export type WebRemote = z.output<typeof WebRemoteSchema>;

export const WebSchema = z.strictObject({
  enabled: z
    .boolean()
    .describe(
      '(Beta) The web UI: your sandbox sessions in a browser on this PC (http://127.0.0.1:<port>, this PC only). On: every sandbox start also starts it in the background (it keeps running until sandbox web stop or a restart of the PC). Off: only sandbox web start runs it. Open it signed in with sandbox web open.',
    ),
  port: z
    .number()
    .int()
    .min(1024)
    .max(65535)
    .describe('Port of the web UI on 127.0.0.1 (this PC only). Pick another when it is taken.'),
  openOnLaunch: z
    .boolean()
    .describe('(Beta) With the web UI on: open it in your browser, already signed in, every time a sandbox starts.'),
  remote: WebRemoteSchema.describe('(Beta) Access for other Windows users of this PC and for paired devices.'),
});
