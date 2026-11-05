// The Unity CLI as an MCP server (`unity mcp --cli-tools`, stdio) for Claude Code and Codex. Read-only tools always;
// the open editor's tools when the project has the Unity Pipeline package.
import { UNITY_CLI_ENV } from './cli.js';

export const UNITY_MCP_NAME = 'sbx-unity';

export interface UnityMcpServer {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function unityCliMcpServer(unityExe: string, projectPath: string | null): UnityMcpServer {
  return {
    type: 'stdio',
    command: unityExe,
    args: ['mcp', '--cli-tools'],
    env: { ...UNITY_CLI_ENV, ...(projectPath ? { UNITY_PROJECT_PATH: projectPath } : {}) },
  };
}
