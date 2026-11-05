// Unity's licence files and what they say, without secrets: the serial licence (Unity_lic.ulf), the named-user licence
// (UnityEntitlementLicense.xml) and the answer of `unity license status`. Pure text handling, every scan bounded.
import path from 'node:path';
import type { Payload } from '../payloads.js';

export type UnityPayload = Payload<'unity'>;

/** The licence files' size limit (the payload's). */
export const MAX_ULF_BYTES = 128 * 1024;
const MAX_LINES = 4000;
const MAX_FIELD = 200;

/** %PROGRAMDATA%\Unity\Unity_lic.ulf */
export function unityUlfFile(programData: string): string {
  return path.win32.join(programData, 'Unity', 'Unity_lic.ulf');
}

/** %LOCALAPPDATA%\Unity\licenses\UnityEntitlementLicense.xml */
export function unityEntitlementFile(localAppData: string): string {
  return path.win32.join(localAppData, 'Unity', 'licenses', 'UnityEntitlementLicense.xml');
}

export interface UlfSummary {
  /** The serial as Unity masks it in the file (XXXX-...), never a full one. */
  readonly serialMasked: string | null;
  readonly updated: string | null;
  readonly kind: 'personal' | 'paid' | 'unknown';
}

/** The value of `<Name Value="..."/>` on one line, by index scan (no backtracking). */
function valueOf(line: string, name: string): string | null {
  const at = line.indexOf('<' + name);
  if (at < 0) return null;
  const key = line.indexOf('Value="', at);
  if (key < 0) return null;
  const from = key + 7;
  const end = line.indexOf('"', from);
  if (end < 0 || end - from > MAX_FIELD) return null;
  return line.slice(from, end);
}

/** What a Unity_lic.ulf says (its SerialMasked and UpdateDate), or null when it holds neither. */
export function ulfSummary(text: string): UlfSummary | null {
  let serialMasked: string | null = null;
  let updated: string | null = null;
  const lines = text.slice(0, MAX_ULF_BYTES).split('\n', MAX_LINES);
  for (const line of lines) {
    serialMasked ??= valueOf(line, 'SerialMasked');
    updated ??= valueOf(line, 'UpdateDate');
    if (serialMasked !== null && updated !== null) break;
  }
  if (serialMasked === null && updated === null) return null;
  const kind = serialMasked === null ? 'unknown' : serialMasked.startsWith('U3-') ? 'personal' : 'paid';
  return { serialMasked, updated, kind };
}

/** One line for the status: the Unity ID, else what kind of licence file it is. Never a secret. */
export function unitySummary(p: UnityPayload): string {
  if (p.email) return p.email;
  if (p.ulf) {
    const kind = ulfSummary(p.ulf)?.kind;
    return kind === 'personal' ? 'licence file (Personal)' : 'licence file (Plus or Pro)';
  }
  if (p.entitlement) return 'licence file (Personal)';
  return 'serial';
}

export interface LicenceStatus {
  readonly state: 'active' | 'none' | 'unknown';
  readonly kind: string;
  readonly detail: string;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
}

/**
 * What `unity license status --format json` printed. The shape is not documented (checked against the docs, not a live
 * run), so anything unrecognised is 'unknown', never a guess.
 */
export function parseLicenceStatus(json: unknown): LicenceStatus {
  const unknown: LicenceStatus = { state: 'unknown', kind: '', detail: 'not recognised' };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return unknown;
  const o = json as Record<string, unknown>;
  const licences = Array.isArray(o.licenses)
    ? (o.licenses as unknown[])
    : Array.isArray(o.licences)
      ? o.licences
      : null;
  if (licences !== null) {
    if (!licences.length) return { state: 'none', kind: '', detail: 'no licence' };
    const first = licences[0];
    const f = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {};
    return { state: 'active', kind: text(f.type ?? f.kind), detail: text(f.detail ?? f.name ?? f.status) };
  }
  const status = text(o.status ?? o.state).toLowerCase();
  if (status === 'active' || status === 'activated' || status === 'valid')
    return { state: 'active', kind: text(o.type ?? o.kind), detail: text(o.detail ?? o.message) || status };
  if (status === 'none' || status === 'inactive' || status === 'not activated' || status === 'unlicensed')
    return { state: 'none', kind: '', detail: text(o.detail ?? o.message) || status };
  return unknown;
}
