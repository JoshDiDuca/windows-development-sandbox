// The GitHub feature's work: its status, saving the token through io.secret (kept only for the save, never returned,
// logged or shown), and deleting it after a confirmation. The flows take the store, so the self-test runs them with a
// store of its own.
import os from 'node:os';
import { requireOnPc } from '../../../cli/commands/context.js';
import { fail } from '../../../core/util/index.js';
import { GithubToken, verifyGithubToken, type GithubVerdict } from '../../../host/github/index.js';
import { githubTokenProblem } from '../../../shared/github/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import {
  GITHUB_STEPS,
  GITHUB_WARNINGS,
  expiryOf,
  githubLogin,
  githubLogout,
  githubStatus,
  tokenUrlFor,
} from './github.def.js';

/** Asks GitHub about a token just typed (the self-test passes its own). */
export type VerifyToken = (token: string) => Promise<GithubVerdict>;

/** Asks for the token (one hidden question) and saves it. The validator answers with fixed texts only. */
export async function saveGithubTokenFlow(
  io: OperationIO,
  store: GithubToken,
  verify: VerifyToken = verifyGithubToken,
): Promise<{ message: string }> {
  io.log('Make a GitHub token only for sandboxes:');
  GITHUB_STEPS.forEach((s, i) => io.log('  ' + (i + 1) + '. ' + s));
  io.log('What you type is not shown. It is kept encrypted for your Windows user and never printed.', 'muted');
  const token = await io.secret({
    title: 'GitHub token',
    validate: (v) => githubTokenProblem(v.trim())?.message ?? true,
  });
  if (token === undefined) cancelled();
  // GitHub says whose token it is and when it ends; one it refuses is not saved. No answer (offline) is not a refusal.
  io.progress('Asking GitHub about the token');
  const verdict = await verify(token.trim());
  if (verdict.kind === 'refused')
    fail('GitHub refused this token.', 'Copy it again from GitHub, and check that it has not expired or been revoked.');
  if (verdict.kind === 'unreachable')
    io.log('The token could not be checked (' + verdict.reason + ') and is saved without a check.', 'warn');
  const check =
    verdict.kind === 'ok'
      ? {
          login: verdict.check.login,
          expiresAt: verdict.check.expiresAt,
          repoCount: verdict.check.repos.count,
          checkedAt: new Date().toISOString(),
        }
      : undefined;
  const kind = store.save(token.trim(), check);
  if (verdict.kind === 'ok') {
    const { repos } = verdict.check;
    io.log(
      'GitHub says this is ' +
        verdict.check.login +
        '. It reaches ' +
        repos.count +
        (repos.count >= 100 ? ' or more' : '') +
        ' repositories' +
        (repos.sample.length ? ' (' + repos.sample.join(', ') + (repos.count > repos.sample.length ? ', ...' : '') + ')' : '') +
        '.',
      'ok',
    );
    const expiry = expiryOf(verdict.check.expiresAt);
    if (expiry) io.log(expiry.text + '.', expiry.tone === 'ok' ? 'muted' : 'warn');
  }
  GITHUB_WARNINGS.forEach((w) => io.log(w, 'warn'));
  if (kind === 'classic')
    io.log('This is a classic token: it reaches every repository you can. A fine-grained one is safer.', 'warn');
  return { message: 'Saved. Sandboxes get it once you turn on Share the token with sandboxes.' };
}

/** Deletes the saved token after asking (the CLI's typed logout is the answer). */
export async function deleteGithubTokenFlow(
  io: OperationIO,
  store: GithubToken,
): Promise<{ deleted: boolean; message: string }> {
  if (store.state() === 'none') return { deleted: false, message: 'No GitHub token was saved.' };
  const yes = await io.confirm({ title: 'Delete the saved GitHub token?', yes: 'Delete', danger: true, implied: true });
  if (!yes) cancelled();
  store.remove();
  return {
    deleted: true,
    message: 'The saved GitHub token is deleted. Revoke it on GitHub too if you no longer use it.',
  };
}

export const githubStatusRun = implement(githubStatus, async (ctx) => {
  const { config } = ctx.loaded;
  const store = new GithubToken(ctx.storageRoot);
  const token = store.state();
  return {
    shareToken: config.github.shareToken,
    gitAccess: config.provisioning.git.access,
    token,
    kind: token === 'none' ? null : store.kind(),
    savedAt: token === 'none' ? null : store.savedAt(),
    login: token === 'none' ? null : (store.check()?.login ?? null),
    expiresAt: token === 'none' ? null : (store.check()?.expiresAt ?? null),
    repoCount: token === 'none' ? null : (store.check()?.repoCount ?? null),
    checkedAt: token === 'none' ? null : (store.check()?.checkedAt ?? null),
    tokenUrl: tokenUrlFor(os.hostname()),
  };
});

export const githubLoginRun = implement(githubLogin, async (ctx, _input, io) => {
  requireOnPc('github login');
  return saveGithubTokenFlow(io, new GithubToken(ctx.storageRoot));
});

export const githubLogoutRun = implement(githubLogout, async (ctx, _input, io) => {
  requireOnPc('github logout');
  return deleteGithubTokenFlow(io, new GithubToken(ctx.storageRoot));
});
