// Reading robocopy's exit code and output (pure; the guest and the tests share it).

/** Exit code 8 and up means something could not be copied; below that every file is in place. */
export function robocopyFailed(code: number | null): boolean {
  return code === null || code >= 8;
}

/** The exit code in plain words (it is a bit field: 1 copied, 2 extras, 4 mismatches, 8 failures, 16 fatal). */
export function robocopyMeaning(code: number | null): string {
  if (code === null) return 'robocopy did not finish';
  if (code >= 16) return 'robocopy stopped with a fatal error (bad path or no access)';
  if (code >= 8) return code & 1 ? 'some files were copied and some could not be' : 'files could not be copied';
  return code === 0 ? 'nothing to copy' : 'copied';
}

/** The first few ERROR lines of robocopy's output (what went wrong and on which file), one line each. */
export function robocopyErrors(output: string, max = 3): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\bERROR\b/.test(l) || /^The (process|system) cannot/i.test(l));
  return lines.slice(0, max).map((l) => (l.length > 220 ? l.slice(0, 217) + '...' : l));
}
