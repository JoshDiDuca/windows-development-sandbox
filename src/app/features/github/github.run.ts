// The GitHub feature's work: its status, saving the token through io.secret (kept only for the save, never returned,
// logged or shown), and deleting it after a confirmation. The flows take the store, so the self-test runs them with a
// store of its own.
import { requireOnPc } from '../../../cli/commands/context.js';
import { GithubToken } from '../../../host/github/index.js';
import { githubTokenProblem } from '../../../shared/github/index.js';
import { implement } from '../../context.js';
import { cancelled, type OperationIO } from '../../kernel/index.js';
import { GITHUB_STEPS, GITHUB_WARNINGS, githubLogin, githubLogout, githubStatus } from './github.def.js';

/** Asks for the token (one hidden question) and saves it. The validator answers with fixed texts only. */
export async function saveGithubTokenFlow(io: OperationIO, store: GithubToken): Promise<{ message: string }> {
  io.log('Make a GitHub token only for sandboxes:');
  GITHUB_STEPS.forEach((s, i) => io.log('  ' + (i + 1) + '. ' + s));
  io.log('What you type is not shown. It is kept encrypted for your Windows user and never printed.', 'muted');
  const token = await io.secret({
    title: 'GitHub token',
    validate: (v) => githubTokenProblem(v.trim())?.message ?? true,
  });
  if (token === undefined) cancelled();
  const kind = store.save(token.trim());
  GITHUB_WARNINGS.forEach((w) => io.log(w, 'warn'));
  if (kind === 'classic')
    io.log('This is a classic token: it reaches every repository you can. A fine-grained one is safer.', 'warn');
  return { message: 'Saved. Sandboxes get it once you turn it on: sandbox config set github.shareToken true' };
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
