// How a handed-over service sign-in becomes the tool's own (one adapter per kind under kinds/): apply writes it where
// the tool reads it, current reads back what the tool holds now (a renewed sign-in), release lets go of it when the
// sandbox stops (a Unity seat). Adapters write only to secretDir(kind) or the tool's own files on the sandbox's disk,
// which is wiped when the sandbox closes. No runtime imports: the self-test loads these files.
import path from 'node:path';
import type { Payload, ServiceKind } from '../../shared/accounts/index.js';

export interface Applied {
  /** Variables the agent's sessions get (EXPO_TOKEN ...), in memory only. */
  readonly env?: Readonly<Record<string, string>>;
  /** One line for the boot log; never the secret. */
  readonly summary: string;
}

export interface GuestAdapter<K extends ServiceKind> {
  readonly kind: K;
  apply(p: Payload<K>): Promise<Applied> | Applied;
  /** Bounded, BOM-aware read of what the tool holds now; null when it holds none. */
  current?(): Payload<K> | null;
  /** How often current() is asked (default 60000 ms). */
  readonly checkMs?: number;
  /** When the sandbox stops: let go of what must not stay taken (a Unity seat). */
  release?(): Promise<void> | void;
}

/** %LOCALAPPDATA% of the sandbox's user (its own disk). */
export function localAppData(): string {
  return process.env.LOCALAPPDATA ?? 'C:\\Users\\WDAGUtilityAccount\\AppData\\Local';
}

/** The sandbox's own folder for the accounts: %LOCALAPPDATA%\AgentSandbox\accounts (wiped with the sandbox). */
export function accountsRoot(): string {
  return path.join(localAppData(), 'AgentSandbox', 'accounts');
}

/** Where one kind's files go (a keystore, a .p8, a cfg the server reads). */
export function secretDir(kind: ServiceKind): string {
  return path.join(accountsRoot(), kind);
}

/** What a kind whose sandbox side is not written yet says (the sign-in is not used). */
export function notAvailableYet(kind: ServiceKind): Applied {
  return { summary: kind + ': using a saved sign-in is not available yet (it is not used)' };
}
