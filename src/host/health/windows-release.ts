// Whether this PC's Windows 11 release still gets fixes from Microsoft. The sandbox's VM runs inside Windows' own
// Hyper-V code (vmwp.exe): a crash there is only fixed by an update, and a release that is out of servicing gets none.
// The release comes from the build number and edition the OS reports (CurrentBuild, EditionID in the registry), never
// from the version of a system file: 22H2 and 23H2 share the same 10.0.22621.x files.
import os from 'node:os';
import { captureOutput, isWin } from '../../core/util/index.js';
import { SYSTEM } from '../../shared/system.js';
import { selfTestRunning } from '../test-guard.js';

/** A Windows 11 release and the day Microsoft stops servicing it, per edition group (ISO dates, inclusive). */
export interface ReleaseDates {
  readonly build: number;
  readonly name: string;
  /** Home and Pro. */
  readonly homePro: string;
  /** Enterprise, Education and IoT Enterprise. */
  readonly enterprise: string;
}

/** Microsoft's end-of-servicing dates (the lifecycle pages), by Windows 11 build. Newer builds are not listed: fine. */
export const WINDOWS_RELEASES: readonly ReleaseDates[] = [
  { build: 22000, name: '21H2', homePro: '2023-10-10', enterprise: '2024-10-08' },
  { build: 22621, name: '22H2', homePro: '2024-10-08', enterprise: '2025-10-15' },
  { build: 22631, name: '23H2', homePro: '2025-11-11', enterprise: '2026-11-11' },
  { build: 26100, name: '24H2', homePro: '2026-10-13', enterprise: '2027-10-12' },
  { build: 26200, name: '25H2', homePro: '2027-10-12', enterprise: '2028-10-10' },
];

/** A release that ends within this many days is warned about. */
export const ENDING_SOON_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** What the OS says about itself (registry CurrentVersion). */
export interface WindowsVersion {
  readonly build: number;
  /** Update build revision (the fourth part of 10.0.22621.6060), when known. */
  readonly revision: number | null;
  /** EditionID: Professional, Enterprise, Education, Core ... */
  readonly edition: string | null;
  /** DisplayVersion: "22H2". */
  readonly displayVersion: string | null;
}

export interface WindowsServicing {
  readonly release: string;
  readonly endsOn: string;
  readonly state: 'ok' | 'soon' | 'out';
  readonly daysLeft: number;
  /** "Enterprise", "Pro" ... */
  readonly editionLabel: string;
  /** Out of servicing or ending soon: one plain sentence; ok: null. */
  readonly line: string | null;
}

/** "15 Oct 2025" from an ISO date (pure; UTC so the time zone never moves a day). */
export function dateText(iso: string): string {
  const at = new Date(iso + 'T00:00:00Z');
  return at.getUTCDate() + ' ' + MONTHS[at.getUTCMonth()] + ' ' + at.getUTCFullYear();
}

function isEnterprise(edition: string | null): boolean {
  return edition === null || /enterprise|education/i.test(edition);
}

function labelOf(edition: string | null): string {
  if (!edition) return 'edition unknown';
  if (/education/i.test(edition)) return 'Education';
  if (/enterprise/i.test(edition)) return 'Enterprise';
  if (/^core/i.test(edition)) return 'Home';
  return 'Pro';
}

/**
 * Where this Windows 11 release stands (pure). null when the build is not in the table (an older Windows, or a release
 * newer than the table). An unknown edition uses the later, Enterprise date: never a false alarm.
 */
export function windowsServicing(
  build: number | null,
  edition: string | null,
  now: Date = new Date(),
): WindowsServicing | null {
  const row = WINDOWS_RELEASES.find((r) => r.build === build);
  if (!row) return null;
  const endsOn = isEnterprise(edition) ? row.enterprise : row.homePro;
  const daysLeft = Math.ceil((Date.parse(endsOn + 'T23:59:59Z') - now.getTime()) / DAY_MS);
  const state = daysLeft < 0 ? 'out' : daysLeft <= ENDING_SOON_DAYS ? 'soon' : 'ok';
  const label = labelOf(edition);
  const tail = "crashes of the sandbox's VM (vmwp.exe) are in Windows' own code.";
  const line =
    state === 'out'
      ? 'Windows 11 ' + row.name + ' gets no more fixes since ' + dateText(endsOn) + ' (' + label + '); ' + tail
      : state === 'soon'
        ? 'Windows 11 ' + row.name + ' stops getting fixes on ' + dateText(endsOn) + ' (' + label + '); ' + tail
        : null;
  return { release: row.name, endsOn, state, daysLeft, editionLabel: label, line };
}

/** `reg query ...\CurrentVersion` output to the version it names (pure); null without a build. */
export function parseWindowsVersion(text: string): WindowsVersion | null {
  const value = (name: string): string | null =>
    new RegExp('^\\s+' + name + '\\s+REG_\\w+\\s+(.{1,64})\\s*$', 'im').exec(text)?.[1].trim() ?? null;
  const build = Number(value('CurrentBuild') ?? value('CurrentBuildNumber'));
  if (!Number.isInteger(build) || build <= 0) return null;
  const ubr = value('UBR');
  const revision = ubr === null ? null : Number(ubr);
  return {
    build,
    revision: revision !== null && Number.isInteger(revision) && revision >= 0 ? revision : null,
    edition: value('EditionID'),
    displayVersion: value('DisplayVersion'),
  };
}

/** "Windows 11 22H2 (build 22621.6060), Enterprise" (pure). */
export function windowsVersionText(v: WindowsVersion): string {
  const name = v.build >= 22000 ? 'Windows 11' : 'Windows';
  const release = WINDOWS_RELEASES.find((r) => r.build === v.build)?.name ?? v.displayVersion;
  return (
    name +
    (release ? ' ' + release : '') +
    ' (build ' +
    v.build +
    (v.revision !== null ? '.' + v.revision : '') +
    '), ' +
    labelOf(v.edition)
  );
}

/** The build and edition this PC reports, or null (not Windows, unreadable, or during the self-test). */
export function readWindowsVersion(): WindowsVersion | null {
  if (!isWin || selfTestRunning()) return null;
  const fromRegistry = parseWindowsVersion(
    captureOutput(SYSTEM.reg(), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'], { timeout: 15000 }),
  );
  if (fromRegistry) return fromRegistry;
  const build = Number(/^\d+\.\d+\.(\d+)/.exec(os.release())?.[1]);
  return Number.isInteger(build) && build > 0 ? { build, revision: null, edition: null, displayVersion: null } : null;
}
