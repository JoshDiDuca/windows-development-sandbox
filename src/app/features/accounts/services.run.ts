// The service sign-ins' work: their status, taking one from this PC or a file, typing one, and forgetting one
// everywhere. Talks only through io; the sign-in itself is never an output, a log line or part of a question. The
// flows take the store, the leases and this PC's folders, so the self-test runs them with its own.
import fs from 'node:fs';
import path from 'node:path';
import { requireOnPc } from '../../../cli/commands/context.js';
import { fail, failWith, safeText } from '../../../core/util/index.js';
import type { Config } from '../../../core/types.js';
import {
  AccountLeases,
  forgetEverywhere,
  HOST_SOURCES,
  pcEnv,
  ServiceAccountStore,
  type PcEnv,
} from '../../../host/accounts/index.js';
import {
  isServiceKind,
  SERVICE_KINDS,
  SERVICE_SPECS,
  type AccountSource,
  type ServiceKind,
  type ServiceSpec,
  usedByText,
} from '../../../shared/accounts/index.js';
import { readBoundedFile } from '../../../shared/io/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import { isKindReady } from '../../../shared/readiness.js';
import { listServices, serviceImport, serviceLogin, serviceLogout, type ServiceRow } from './services.def.js';

/** One service's row: never the sign-in, and the store's summary through safeText. */
export function serviceRow(
  kind: ServiceKind,
  config: Config,
  store: ServiceAccountStore,
  leases: AccountLeases,
): ServiceRow {
  const spec: ServiceSpec = SERVICE_SPECS[kind];
  const source = HOST_SOURCES[kind];
  const state = store.state(kind);
  const info = state === 'none' ? null : store.info(kind);
  const holder = spec.singleHolder ? leases.holder(kind) : null;
  return {
    kind,
    label: spec.label,
    share: config.accounts[kind].share,
    state,
    source: info?.source ?? null,
    savedAt: info?.savedAt ?? null,
    summary: info?.summary ? safeText(info.summary) : null,
    heldBy: holder ? safeText(holder.dataSet) : null,
    usedBy: [...spec.usedBy],
    usedFor: usedByText(spec.usedBy),
    warnings: [...spec.warnings],
    canImport: Boolean(source.fromPc || source.fromFile),
    canLogin: Boolean(source.fromAnswers),
    needsFile: Boolean(source.fromFile && !source.fromPc),
    ready: isKindReady(kind),
  };
}

/** The kind an operation is about: the name given (checked), else asked. */
async function kindOf(
  io: OperationIO,
  given: string | undefined,
  verb: string,
  offered: (spec: ServiceSpec) => boolean = () => true,
): Promise<ServiceKind> {
  if (given !== undefined) {
    const name = given.trim().toLowerCase();
    if (!isServiceKind(name))
      fail('There is no service called "' + safeText(given) + '".', 'Use one of: ' + SERVICE_KINDS.join(', '));
    return name;
  }
  const choices = SERVICE_KINDS.filter((k) => isKindReady(k) && offered(SERVICE_SPECS[k])).map((k) => ({
    value: k,
    label: SERVICE_SPECS[k].label,
  }));
  if (!choices.length) fail('No service can do that.');
  const picked = await io.choose({ title: 'Which service do you want to ' + verb + '?', choices });
  if (picked === undefined || !isServiceKind(picked)) cancelled();
  return picked;
}

/** Asks for the kind's fields (those for typing it, or for a file); optional ones may stay empty. */
async function askFields(io: OperationIO, spec: ServiceSpec, mode: 'typed' | 'file'): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const field of spec.fields.filter((f) => !f.only || f.only === mode)) {
    const validate = (value: string): true | string => {
      const v = value.trim();
      if (!v) return field.optional ? true : 'This one is needed.';
      return !field.pattern || field.pattern.test(v) ? true : 'That does not look right for ' + field.label + '.';
    };
    const title = field.label + (field.optional ? ' (Enter to skip)' : '') + ':';
    const answer = field.secret
      ? await io.secret({ title, validate })
      : await io.text({ title, validate, allowEmpty: Boolean(field.optional) });
    if (answer === undefined) {
      if (field.optional) continue;
      cancelled();
    }
    if (answer.trim()) answers[field.name] = answer.trim();
  }
  return answers;
}

/** A kind that only ever comes from a sandbox (Comet): why it cannot be taken from this PC, and what to do instead. */
function refuseSandboxOnly(spec: ServiceSpec): void {
  if (spec.sources.length !== 1 || spec.sources[0] !== 'sandbox') return;
  fail(
    'Your ' + spec.label + " sign-in can't be copied from this PC: Windows locks it to your PC account.",
    'Sign in once inside a sandbox (with accounts.' + spec.kind + '.share on): it is kept for the next ones.',
  );
}

function savedMessage(kind: ServiceKind, share: boolean): string {
  return (
    'Saved your ' +
    SERVICE_SPECS[kind].label +
    ' sign-in (encrypted for your Windows user).' +
    (share ? '' : ' Sandboxes get it once you turn on Share with sandboxes.')
  );
}

export interface ImportDeps {
  readonly store: ServiceAccountStore;
  readonly pc: PcEnv;
  readonly share: boolean;
}

/** Saves a kind's sign-in from this PC's program or from a file, after a confirmation (--yes answers it). */
export async function importServiceFlow(
  io: OperationIO,
  kind: ServiceKind,
  from: string | undefined,
  deps: ImportDeps,
): Promise<{ message: string }> {
  const spec: ServiceSpec = SERVICE_SPECS[kind];
  const source = HOST_SOURCES[kind];
  if (!source.fromPc && !source.fromFile) refuseSandboxOnly(spec);
  if (!source.fromPc && !source.fromFile)
    failWith(spec.label + ' cannot be imported.', 'Type it instead.', {
      op: 'accounts.service.login',
      input: { name: kind },
      label: 'Sign in…',
      cli: 'sandbox account login ' + kind,
    });
  let file = from === undefined ? undefined : path.resolve(from);
  const isFile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const useFile = Boolean(source.fromFile && (file ? isFile(file) : !source.fromPc));
  if (useFile && !file) {
    const asked = await io.path({ title: 'The ' + spec.label + ' file:', pathKind: 'file' });
    if (asked === undefined) cancelled();
    file = path.resolve(asked);
  }
  const yes = await io.confirm({
    title: useFile
      ? 'Save the ' + spec.label + ' sign-in from this file for sandboxes?'
      : "Take this PC's " + spec.label + ' sign-in for sandboxes?',
    lines: [...spec.warnings],
    yes: 'Save it',
    noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to save it without asking.' },
  });
  if (!yes) cancelled('Nothing saved.');
  let payload: unknown;
  let saved: AccountSource;
  if (useFile) {
    const maxBytes = spec.maxFileBytes ?? spec.maxBytes;
    const bytes = readBoundedFile(file!, maxBytes);
    if (!bytes) fail('Cannot read ' + file + ' (missing, a link, or bigger than ' + maxBytes / 1024 + ' KB).');
    payload = source.fromFile!(bytes, await askFields(io, spec, 'file'));
    saved = 'file';
  } else {
    payload = source.fromPc!(deps.pc, file);
    saved = 'pc';
  }
  if (!payload)
    return {
      message:
        'No saved ' +
        spec.label +
        ' sign-in found on this PC' +
        (file ? ' in ' + file : '') +
        (spec.returns
          ? ' (sign in there first, or sign in once inside a sandbox).'
          : kind === 'perplexity'
            ? ' (PERPLEXITY_API_KEY is not set for your Windows user: import a .env file, or type the key).'
            : '.'),
    };
  deps.store.save(kind, payload as never, saved, source.summary(payload as never));
  for (const w of spec.warnings) io.log(w, 'warn');
  return { message: savedMessage(kind, deps.share) };
}

/** Saves what you type for a kind (a key, a token). */
export async function loginServiceFlow(
  io: OperationIO,
  kind: ServiceKind,
  deps: Omit<ImportDeps, 'pc'>,
): Promise<{ message: string }> {
  const spec: ServiceSpec = SERVICE_SPECS[kind];
  const source = HOST_SOURCES[kind];
  if (!source.fromAnswers) refuseSandboxOnly(spec);
  if (!source.fromAnswers)
    failWith(
      spec.label + ' has nothing to type.',
      spec.sources.includes('sandbox')
        ? 'Sign in once inside a sandbox (it is kept), or import it.'
        : 'Import it from a file.',
      {
        op: 'accounts.service.import',
        input: { name: kind },
        label: 'Import…',
        cli: 'sandbox account import ' + kind + (spec.sources.includes('sandbox') ? '' : ' --from <file>'),
      },
    );
  const payload = source.fromAnswers(await askFields(io, spec, 'typed'));
  deps.store.save(kind, payload as never, 'typed', source.summary(payload as never));
  for (const w of spec.warnings) io.log(w, 'warn');
  return { message: savedMessage(kind, deps.share) };
}

/** Forgets a kind's sign-in everywhere after asking (--yes answers it). */
export async function logoutServiceFlow(
  io: OperationIO,
  kind: ServiceKind,
  storageRoot: string,
  store: ServiceAccountStore,
  leases: AccountLeases,
): Promise<{ deleted: boolean; message: string }> {
  const label = SERVICE_SPECS[kind].label;
  const yes = await io.confirm({
    title: 'Forget the saved ' + label + ' sign-in?',
    lines: ['The next sandboxes start signed out; a copy a sandbox left behind is deleted too.'],
    yes: 'Forget',
    danger: true,
    noTerminal: { message: 'Cannot ask here (no terminal).', fix: 'Add --yes to forget it without asking.' },
  });
  if (!yes) cancelled('Nothing changed.');
  const { removed, pendingDeleted } = forgetEverywhere(kind, storageRoot, store, leases);
  if (!removed && !pendingDeleted) return { deleted: false, message: 'No ' + label + ' sign-in was saved.' };
  return {
    deleted: true,
    message:
      'The saved ' +
      label +
      ' sign-in is deleted' +
      (pendingDeleted ? ' (and ' + pendingDeleted + ' copy a sandbox left)' : '') +
      '. The next sandboxes start signed out.',
  };
}

export const listServicesRun = implement(listServices, async (ctx, input) => {
  const store = new ServiceAccountStore(ctx.storageRoot);
  const leases = new AccountLeases(ctx.storageRoot);
  const name = input.name?.trim().toLowerCase();
  if (name !== undefined && name !== '' && !isServiceKind(name))
    fail('There is no service called "' + safeText(input.name ?? '') + '".', 'Use one of: ' + SERVICE_KINDS.join(', '));
  const kinds = name ? [name as ServiceKind] : [...SERVICE_KINDS];
  return { services: kinds.map((k) => serviceRow(k, ctx.loaded.config, store, leases)) };
});

export const serviceImportRun = implement(serviceImport, async (ctx, input, io) => {
  requireOnPc('account import');
  const kind = await kindOf(io, input.name, 'import', (s) =>
    Boolean(HOST_SOURCES[s.kind].fromPc || HOST_SOURCES[s.kind].fromFile),
  );
  return importServiceFlow(io, kind, input.from, {
    store: new ServiceAccountStore(ctx.storageRoot),
    pc: pcEnv(),
    share: ctx.loaded.config.accounts[kind].share,
  });
});

export const serviceLoginRun = implement(serviceLogin, async (ctx, input, io) => {
  requireOnPc('account login');
  const kind = await kindOf(io, input.name, 'sign in to', (s) => Boolean(HOST_SOURCES[s.kind].fromAnswers));
  return loginServiceFlow(io, kind, {
    store: new ServiceAccountStore(ctx.storageRoot),
    share: ctx.loaded.config.accounts[kind].share,
  });
});

export const serviceLogoutRun = implement(serviceLogout, async (ctx, input, io) => {
  requireOnPc('account logout');
  const kind = await kindOf(io, input.name, 'forget');
  return logoutServiceFlow(
    io,
    kind,
    ctx.storageRoot,
    new ServiceAccountStore(ctx.storageRoot),
    new AccountLeases(ctx.storageRoot),
  );
});
