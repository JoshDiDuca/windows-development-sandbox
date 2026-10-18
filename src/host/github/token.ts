// The GitHub token you saved for sandboxes (github.shareToken), kept encrypted with Windows DPAPI in host-only storage
// (<storage>\github\token.json). It is read only when a sandbox starts, to hand to the sandbox in a one-shot file, and
// is never printed, logged or returned to a surface: they only learn its state, kind and when it was saved.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { JsonFile } from '../../shared/io/index.js';
import {
  GITHUB_TOKEN_KINDS,
  GithubTokenSchema,
  githubTokenKind,
  githubTokenProblem,
  type GithubTokenKind,
} from '../../shared/github/index.js';
import { fail } from '../../core/util/index.js';
import { SecretStore } from '../secrets/index.js';

const SavedSchema = z.object({
  savedAt: z.string().max(64),
  kind: z.enum(GITHUB_TOKEN_KINDS),
  sealed: z.string().max(10000),
});
type Saved = z.output<typeof SavedSchema>;

/** What the status may say about the token: never its value. */
export type TokenState = 'none' | 'saved' | 'unreadable';

/** The token's kind, or a refusal that says what to do (the message never holds what was typed). */
export function checkGithubToken(token: string): GithubTokenKind {
  const problem = githubTokenProblem(token);
  if (problem) fail(problem.message, problem.fix);
  return githubTokenKind(token) ?? fail('That is not a GitHub personal access token.', 'Run: sandbox github login');
}

export class GithubToken {
  constructor(
    private readonly storageRoot: string,
    private readonly secrets: SecretStore = SecretStore.standard(),
  ) {}

  private file(): JsonFile<Saved> {
    return new JsonFile(SavedSchema, path.join(this.storageRoot, 'github', 'token.json'));
  }

  /** Checks, encrypts and saves the token (replacing an earlier one). Returns its kind. */
  save(token: string): GithubTokenKind {
    const kind = checkGithubToken(token);
    this.file().write({ savedAt: new Date().toISOString(), kind, sealed: this.secrets.sealJson({ token }) });
    return kind;
  }

  /** The token, decrypted. Only the launch calls this; throws when this Windows user cannot open it. */
  read(): string | null {
    const saved = this.file().read();
    if (!saved) return null;
    const value = this.secrets.openJson(saved.sealed) as { token?: unknown };
    const token = GithubTokenSchema.safeParse(value?.token);
    if (!token.success) fail('The saved GitHub token is damaged.', 'Save it again with: sandbox github login');
    return token.data;
  }

  /** Whether a token is saved and can be decrypted by this Windows user (the value is never returned). */
  state(): TokenState {
    if (!this.file().read()) return 'none';
    try {
      return this.read() ? 'saved' : 'none';
    } catch {
      return 'unreadable';
    }
  }

  savedAt(): string | null {
    return this.file().read()?.savedAt ?? null;
  }

  kind(): GithubTokenKind | null {
    return this.file().read()?.kind ?? null;
  }

  remove(): boolean {
    const file = this.file().file;
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  }
}
