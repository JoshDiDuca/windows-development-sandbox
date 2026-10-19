// What this browser may do (docs/design/remote-access.md): the owner everything; another Windows user or a paired device
// the role the owner gave them. Set once from /api/me after signing in; pages hide what the role cannot run (the server
// refuses it either way).
import { operationById } from '../../src/app/features/defs';
import { accessNeeded, allows, type Access, type Action, type Caller } from '../../src/app/kernel/index';

let caller: Caller = { kind: 'owner' };

export function setAccess(access: Access): void {
  caller = access === 'owner' ? { kind: 'owner' } : { kind: 'device', id: '', name: '', role: access };
}

export function isOwner(): boolean {
  return caller.kind === 'owner';
}

/** May this browser run the action? Links always (a terminal opens read-only for view); operations by their need. */
export function mayRun(action: Action): boolean {
  if (action.kind === 'link') return action.target.kind !== 'start-agent' || allows(caller, 'control');
  const def = operationById(action.op);
  return def !== undefined && allows(caller, accessNeeded(def, action.input));
}
