// Unity for the agents: the Unity CLI's MCP server (sbx-unity) and its skills in the sandbox's Claude Code and Codex.
// A stub until the Unity set-up lands: it changes nothing.

export interface UnityAgentInput {
  readonly unityExe: string;
  readonly projectPath: string | null;
  readonly mcp: boolean;
  readonly skills: boolean;
}

/** Sets up what is asked; returns the MCP server's name when it was registered and whether the skills were synced. */
export async function setupUnityAgentTools(_i: UnityAgentInput): Promise<{ mcp: string | null; skills: boolean }> {
  return { mcp: null, skills: false };
}
