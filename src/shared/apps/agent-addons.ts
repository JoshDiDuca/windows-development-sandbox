// How agent add-ons plug into the agents. Pure: the sandbox writes what these return (guest/setup/managed-policy.ts,
// guest/boot/guide.ts), the self-test checks them. rtk documents its Claude Code hook as a PreToolUse entry for Bash
// that runs `rtk hook claude`; here it goes into the sandbox's managed settings, never into a file on this PC.

/** One hook command in Claude Code's settings. */
interface ClaudeHook {
  readonly type: 'command';
  readonly command: string;
}

/** Claude Code's managed-settings.json as the sandbox writes it. */
export interface ManagedSettings {
  readonly permissions?: { readonly deny: readonly string[] };
  readonly hooks?: {
    readonly PreToolUse: readonly { readonly matcher: string; readonly hooks: readonly ClaudeHook[] }[];
  };
}

/** The command Claude Code runs for rtk's hook: the program by its full path (quoted, forward slashes for Git Bash). */
export function rtkHookCommand(exe: string): string {
  return '"' + exe.replace(/\\/g, '/') + '" hook claude';
}

/**
 * The managed settings for the git deny rules and, when rtk is installed (`rtkExe`), its Bash hook. Null when there is
 * nothing to write (the file is removed then).
 */
export function claudeManagedSettings(deny: readonly string[], rtkExe: string | null): ManagedSettings | null {
  if (!deny.length && !rtkExe) return null;
  return {
    ...(deny.length ? { permissions: { deny } } : {}),
    ...(rtkExe
      ? { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: rtkHookCommand(rtkExe) }] }] } }
      : {}),
  };
}

/** The line every agent's sandbox guide gets while rtk is installed (Claude's commands go through it on their own). */
export const RTK_GUIDE_LINE =
  "- rtk is on PATH and compacts command output: Claude Code's Bash commands go through it on their own; in other agents prefix shell commands with `rtk` (`rtk git status`, `rtk cargo test`, `rtk ls`).";
