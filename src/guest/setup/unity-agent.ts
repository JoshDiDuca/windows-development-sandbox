// Unity for the agents: the Unity CLI's MCP server (sbx-unity) and its skills in the sandbox's Claude Code and Codex.
// The project is never changed. A failure is a warning: the editor itself still works without the agent tools.
import path from 'node:path';
import { UNITY_CLI_ENV, UNITY_MCP_NAME, unityCliMcpServer } from '../../shared/unity/index.js';
import { execAsync } from '../runtime/process.js';
import { log, warn } from '../runtime/log.js';
import { claudeDir, session, stateDir } from '../runtime/session.js';
import { setEngineMcp, writeAddonMcpServers } from './addon-mcp.js';

export interface UnityAgentInput {
  readonly unityExe: string;
  readonly projectPath: string | null;
  readonly mcp: boolean;
  readonly skills: boolean;
}

/** Syncs Unity's skills for one agent, with that agent's home folder in its variable; false on failure. */
async function syncSkills(unityExe: string, agent: 'claude' | 'codex'): Promise<boolean> {
  const home = agent === 'claude' ? { CLAUDE_CONFIG_DIR: claudeDir } : { CODEX_HOME: path.join(stateDir, 'codex') };
  try {
    await execAsync(unityExe, ['skill', 'sync', agent], { env: { ...process.env, ...UNITY_CLI_ENV, ...home } });
    return true;
  } catch (e) {
    warn('Unity skills for ' + agent + ' were not synced: ' + (e instanceof Error ? e.message : String(e)));
    return false;
  }
}

/** Sets up what is asked; returns the MCP server's name when it was registered and whether the skills were synced. */
export async function setupUnityAgentTools(i: UnityAgentInput): Promise<{ mcp: string | null; skills: boolean }> {
  setEngineMcp(UNITY_MCP_NAME, i.mcp ? unityCliMcpServer(i.unityExe, i.projectPath) : null);
  const names = writeAddonMcpServers();
  const mcp = names.includes(UNITY_MCP_NAME) ? UNITY_MCP_NAME : null;
  let skills = false;
  if (i.skills) {
    const results = [await syncSkills(i.unityExe, 'claude')];
    if (session.agents?.codex) results.push(await syncSkills(i.unityExe, 'codex'));
    skills = results.some(Boolean);
    if (skills) log('Unity skills synced for the agents');
  }
  return { mcp, skills };
}
