// Who may run what (docs/design/remote-access.md): every definition needs view, control or owner; the caller of a run
// has a role. The owner (at the PC, or through the token link) may do everything; another Windows user of this PC or a
// paired device has the role the owner gave them, never owner. Pure (the web bundle shows what the role allows).

/** What a definition needs. Default: a query needs view, an operation control. */
export type Access = 'view' | 'control' | 'owner';

/** A role the owner can give: view only, or full control (everything but the owner's own things). */
export type RemoteRole = 'view' | 'control';

/** Who runs a definition: the owner, or someone the owner let in. */
export type Caller =
  | { readonly kind: 'owner' }
  | { readonly kind: 'windows'; readonly user: string; readonly role: RemoteRole }
  | { readonly kind: 'device'; readonly id: string; readonly name: string; readonly role: RemoteRole };

export const OWNER: Caller = { kind: 'owner' };

/** A definition's need, as written: fixed, or from its input (settings.set on a web.* key needs owner). */
export type AccessRule = Access | ((input: unknown) => Access);

const RANK: Readonly<Record<Access, number>> = { view: 0, control: 1, owner: 2 };

/** The most a caller may do. */
export function callerAccess(caller: Caller): Access {
  return caller.kind === 'owner' ? 'owner' : caller.role;
}

/** The caller may run something that needs `need`. */
export function allows(caller: Caller, need: Access): boolean {
  return RANK[callerAccess(caller)] >= RANK[need];
}

/** What a definition needs for this input. A rule that throws on a strange input needs owner. */
export function accessNeeded(
  def: { readonly kind: 'operation' | 'query'; readonly access?: AccessRule },
  input: unknown,
): Access {
  const rule = def.access;
  if (rule === undefined) return def.kind === 'query' ? 'view' : 'control';
  if (typeof rule === 'string') return rule;
  try {
    return rule(input);
  } catch {
    return 'owner';
  }
}

/** Who the caller is, in a few words (the audit log, the page's header). */
export function callerLabel(caller: Caller): string {
  switch (caller.kind) {
    case 'owner':
      return 'you';
    case 'windows':
      return 'Windows user ' + caller.user;
    case 'device':
      return 'device ' + caller.name;
  }
}

/** The refusal text for a caller that may not. */
export function refusalText(caller: Caller, need: Access): string {
  if (need === 'owner') return 'Only the owner of this PC can do that, at the PC.';
  return callerAccess(caller) === 'view' ? 'Your access is view only.' : 'You may not do that.';
}
