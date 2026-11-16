// `sbx-agent`: install or update a configured agent from a terminal inside the sandbox (the agent commands call it the
// first time, and for `claude update`). Usage: sbx-agent list | sbx-agent install <agent> | sbx-agent update [agent]
import { agents } from './agent-installer.js';
import { agentCommand, agentPaths } from './agent-files.js';
import { toolsDir } from '../runtime/paths.js';
import { exists } from '../runtime/fs.js';
import { session } from '../runtime/session.js';

const USAGE = 'Usage: sbx-agent list | sbx-agent install <agent> | sbx-agent update [agent]';

const isInstalled = (agent: string): boolean => {
  const p = agentPaths(toolsDir, agent, session.agents![agent]!);
  return (p.exe !== null && exists(p.exe)) || (p.cmd !== null && exists(p.cmd));
};

/** Runs one sbx-agent command; returns the exit code. Prints, as the command line tool it is. */
export async function runSbxAgent(argv: readonly string[]): Promise<number> {
  const known = session.agents ?? {};
  const [verb, name] = argv;
  if (verb === 'list' || verb === undefined) {
    for (const [agent, harness] of Object.entries(known))
      console.log(agentCommand(agent, harness).padEnd(14) + (isInstalled(agent) ? 'installed' : 'not installed yet'));
    return 0;
  }
  if (verb !== 'install' && verb !== 'update') {
    console.error(USAGE);
    return 1;
  }
  if (name && !known[name]) {
    console.error('Unknown agent "' + name + '". Configured agents: ' + Object.keys(known).join(', '));
    return 1;
  }
  if (!name && verb === 'install') {
    console.error(USAGE);
    return 1;
  }
  // `sbx-agent update` alone: every agent installed here.
  const targets = name ? [name] : Object.keys(known).filter(isInstalled);
  if (!targets.length) console.log('No agent is installed yet.');
  let code = 0;
  for (const agent of targets) {
    try {
      if (verb === 'install') await agents.provision(agent, known[agent]!, process.env, false);
      else console.log(await agents.update(agent, known[agent]!, process.env));
    } catch (e) {
      console.error('Could not ' + verb + ' ' + agent + ': ' + (e instanceof Error ? e.message : String(e)));
      code = 1;
    }
  }
  return code;
}
