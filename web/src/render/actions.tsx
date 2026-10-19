// What a page's action does in the browser: an operation runs over RPC (its fields asked first); a terminal link opens
// the session's terminal page; "start an agent" runs agents.start and then opens the new session's terminal; a view
// link goes there. Command links belong to areas that are not features yet: the web does not offer them. Buttons get an
// icon from the action's verb.
import { ActionIcon, Button, Menu, Tooltip, type ButtonProps } from '@mantine/core';
import {
  IconCheck,
  IconCircleMinus,
  IconCirclePlus,
  IconDeviceFloppy,
  IconDots,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconListCheck,
  IconStar,
  IconTerminal2,
  IconTrash,
  IconX,
  type Icon,
} from '@tabler/icons-react';
import { useCallback } from 'react';
import type { Action, OperationAction } from '../../../src/app/kernel/index';
import { mayRun } from '../access';
import { navigate, viewPath } from '../router';
import { useRunAction, type Outcome } from '../rpc/hooks';
import { askFields } from './ActionForm';

/** An icon for the first word of an action's verb. */
const VERB_ICONS: Readonly<Record<string, Icon>> = {
  attach: IconTerminal2,
  open: IconTerminal2,
  start: IconPlayerPlay,
  stop: IconPlayerStop,
  restart: IconRefresh,
  reopen: IconRefresh,
  reset: IconRestore,
  make: IconStar,
  remove: IconTrash,
  delete: IconTrash,
  edit: IconPencil,
  change: IconPencil,
  show: IconEye,
  hide: IconEyeOff,
  add: IconPlus,
  new: IconPlus,
  forget: IconX,
  include: IconCirclePlus,
  exclude: IconCircleMinus,
  rename: IconPencil,
  use: IconCheck,
  save: IconDeviceFloppy,
  choose: IconListCheck,
};

/** The session a started agent runs in, from what agents.start returned. */
function sessionOf(output: unknown): string | undefined {
  const session = (output as { session?: unknown } | undefined)?.session;
  return typeof session === 'string' ? session : undefined;
}

export function actionIcon(action: Action): Icon | undefined {
  const word = (action.verb ?? action.label).split(/\s+/)[0].toLowerCase();
  return VERB_ICONS[word];
}

export function isDanger(action: Action): boolean {
  return action.kind === 'operation' && action.danger === true;
}

/** Can the web do this action, for whoever is signed in (a role that may not run it does not see it)? */
export function offered(action: Action | undefined): action is Action {
  return action !== undefined && !(action.kind === 'link' && action.target.kind === 'command') && mayRun(action);
}

/** Does an action. */
export function useAct(): (action: Action) => Promise<Outcome | undefined> {
  const run = useRunAction();
  return useCallback(
    async (action) => {
      if (action.kind === 'operation') {
        const values = action.fields?.length ? await askFields(action) : {};
        return values ? run(action, values) : undefined;
      }
      const target = action.target;
      if (target.kind === 'terminal') navigate('/s/' + target.session);
      else if (target.kind === 'start-agent') {
        const start: OperationAction = {
          kind: 'operation',
          op: 'agents.start',
          label: 'Start ' + target.agent,
          input: { agent: target.agent },
        };
        const started = await run(start);
        const session = started.ok ? sessionOf(started.output) : undefined;
        if (session) navigate('/s/' + session);
        return started;
      } else if (target.kind === 'view') navigate(viewPath(target.view, target.params));
      return undefined;
    },
    [run],
  );
}

interface ActionButtonProps extends ButtonProps {
  readonly action: Action;
  /** The page's main action: filled, in the accent colour. */
  readonly primary?: boolean;
}

export function ActionButton({ action, primary = false, ...props }: ActionButtonProps) {
  const act = useAct();
  if (!offered(action)) return null;
  const danger = isDanger(action);
  const Picture = actionIcon(action);
  const button = (
    <Button
      variant={primary ? 'filled' : danger ? 'light' : 'default'}
      color={danger ? 'red' : undefined}
      leftSection={Picture ? <Picture size={16} stroke={1.8} /> : undefined}
      onClick={(e) => {
        e.stopPropagation();
        void act(action);
      }}
      {...props}
    >
      {action.label}
    </Button>
  );
  return action.description ? <Tooltip label={action.description}>{button}</Tooltip> : button;
}

/** A small icon button for an action (a row's reset), its label as the tooltip. */
export function ActionIconButton({ action }: { readonly action: Action }) {
  const act = useAct();
  if (!offered(action)) return null;
  const Picture = actionIcon(action);
  // Without a picture of its own, a few words say it better than a generic icon.
  if (!Picture)
    return (
      <Button
        size="compact-xs"
        variant="subtle"
        color={isDanger(action) ? 'red' : 'gray'}
        onClick={(e) => {
          e.stopPropagation();
          void act(action);
        }}
      >
        {action.label}
      </Button>
    );
  return (
    <Tooltip label={action.label}>
      <ActionIcon
        aria-label={action.label}
        color={isDanger(action) ? 'red' : 'gray'}
        onClick={(e) => {
          e.stopPropagation();
          void act(action);
        }}
      >
        <Picture size={16} stroke={1.7} />
      </ActionIcon>
    </Tooltip>
  );
}

/** Several actions behind a "…" button. */
export function ActionMenu({ actions }: { readonly actions: readonly Action[] }) {
  const act = useAct();
  const shown = actions.filter(offered);
  if (!shown.length) return null;
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <ActionIcon aria-label="More actions" onClick={(e) => e.stopPropagation()}>
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {shown.map((a, i) => {
          const Picture = actionIcon(a);
          return (
            <Menu.Item
              key={i}
              color={isDanger(a) ? 'red' : undefined}
              leftSection={Picture ? <Picture size={15} /> : undefined}
              onClick={() => void act(a)}
            >
              {a.label}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
