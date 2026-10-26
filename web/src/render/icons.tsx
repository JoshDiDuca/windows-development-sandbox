// Pictures for what a Page names: the navigation's areas, an item's `icon` (an agent, a project, a folder ...), and a
// letter avatar for agents without a picture of their own. Only the web shows these.
import { Avatar } from '@mantine/core';
import {
  IconActivity,
  IconApps,
  IconBox,
  IconBrandGithub,
  IconCloudDownload,
  IconCpu,
  IconDatabase,
  IconDevices,
  IconFileText,
  IconFolder,
  IconFolderCode,
  IconFolders,
  IconHeartbeat,
  IconLayoutDashboard,
  IconRobot,
  IconServer2,
  IconSettings,
  IconShieldLock,
  IconTerminal2,
  IconTool,
  IconUsers,
  type Icon,
} from '@tabler/icons-react';

/** The navigation's entries by their label: one picture per page, the same in the sidebar and the command palette. */
export const AREA_ICONS: Readonly<Record<string, Icon>> = {
  Agents: IconRobot,
  Sessions: IconTerminal2,
  Activity: IconActivity,
  Sandbox: IconBox,
  Overview: IconLayoutDashboard,
  Projects: IconFolders,
  Apps: IconApps,
  Settings: IconSettings,
  Accounts: IconUsers,
  'Remote access': IconDevices,
  Maintenance: IconTool,
  Updates: IconCloudDownload,
  Data: IconDatabase,
  Storage: IconServer2,
  Health: IconHeartbeat,
  Logs: IconFileText,
  Engine: IconCpu,
  VPN: IconShieldLock,
  GitHub: IconBrandGithub,
};

const THING_ICONS: Readonly<Record<string, Icon>> = {
  project: IconFolderCode,
  folder: IconFolder,
  database: IconDatabase,
  session: IconTerminal2,
  // Plain shell sessions are listed by their shell's name.
  pwsh: IconTerminal2,
  powershell: IconTerminal2,
  cmd: IconTerminal2,
};

/** Each agent's colour, so its sessions are told apart at a glance. */
const AGENT_COLORS: Readonly<Record<string, string>> = {
  claude: 'orange',
  codex: 'dark',
  gemini: 'blue',
  opencode: 'gray',
  qwen: 'violet',
  crush: 'pink',
  copilot: 'teal',
  kilo: 'yellow',
  amp: 'red',
  cline: 'cyan',
  continue: 'grape',
  kimi: 'indigo',
  aider: 'green',
  deepseek: 'blue',
  reasonix: 'lime',
};

/** The picture for an item's `icon`: a thing's icon, or an agent's coloured initial. */
export function ItemIcon({ name, size = 36 }: { readonly name: string; readonly size?: number }) {
  const Thing = THING_ICONS[name];
  if (Thing)
    return (
      <Avatar size={size} radius="md" color="indigo" variant="light">
        <Thing size={size * 0.55} stroke={1.6} />
      </Avatar>
    );
  return (
    <Avatar size={size} radius="md" color={AGENT_COLORS[name] ?? 'indigo'} variant="filled" fw={700}>
      {name.slice(0, 1).toUpperCase()}
    </Avatar>
  );
}
