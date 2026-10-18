// The HCS engine's check: what this PC has and lacks. Read-only: it looks (service list, files, the token's groups)
// and answers with the reasons and the exact commands that would fix each one. It NEVER runs a fix: turning on a
// Windows feature or adding a group member is the owner's choice (docs/design/engines.md, "Never").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEM, system32 } from '../../../shared/system.js';
import { isWin } from '../../../core/util/index.js';
import type { EngineCheck } from '../types.js';
import { defaultImageStores, findImage, type ImageStore } from './images.js';

/** Windows 10 1809: the first build with the Host Compute Service API (Microsoft HCS overview). */
export const MIN_BUILD = 17763;

export interface TokenGroups {
  /** The token is an elevated member of Administrators. */
  readonly elevatedAdministrator: boolean;
  /** The token has Hyper-V Administrators (S-1-5-32-578). */
  readonly hyperVAdministrators: boolean;
}

/** Everything the check looks at, so tests give it a fake PC. */
export interface HcsProbes {
  isWindows(): boolean;
  windowsBuild(): number | null;
  /** Whether a Windows service exists; null when that could not be told. */
  serviceInstalled(name: string): boolean | null;
  fileExists(file: string): boolean;
  tokenGroups(): TokenGroups | null;
  imageStores(): readonly ImageStore[];
}

const ENABLE = 'Enable-WindowsOptionalFeature -Online -All -FeatureName ';

export function checkHcs(p: HcsProbes): EngineCheck {
  const reasons: string[] = [];
  const fixes: string[] = [];
  const need = (reason: string, fix: string): void => {
    reasons.push(reason);
    fixes.push(fix);
  };
  if (!p.isWindows())
    return { available: false, reasons: ['The HCS engine only runs on Windows.'], fixes: ['Use "windows-sandbox".'] };

  const build = p.windowsBuild();
  if (build !== null && build < MIN_BUILD)
    need(
      'Windows build ' +
        build +
        ' is too old: the Host Compute Service needs Windows 10 1809 (build ' +
        MIN_BUILD +
        ') or newer.',
      'Update Windows.',
    );
  if (!p.fileExists(path.join(system32Dir(), 'computecore.dll')))
    need(
      'computecore.dll (the Host Compute Service API) is not on this PC.',
      'It comes with the Windows virtualization features (not in Windows Home). In an admin PowerShell, then restart: ' +
        ENABLE +
        'VirtualMachinePlatform  (the owner decides: this changes Windows)',
    );
  if (p.serviceInstalled('vmcompute') === false)
    need(
      'The Hyper-V Host Compute Service (vmcompute) is not installed.',
      'In an admin PowerShell, then restart: ' +
        ENABLE +
        'Microsoft-Hyper-V-All  (needs Windows Pro, Enterprise or Education)',
    );
  if (p.serviceInstalled('cexecsvc') === false)
    need(
      'The Windows Containers feature is not turned on (its Container Execution Agent service is missing).',
      'In an admin PowerShell, then restart: ' + ENABLE + 'Containers',
    );
  const token = p.tokenGroups();
  if (token && !token.elevatedAdministrator && !token.hyperVAdministrators)
    need(
      'This Windows user is neither an elevated Administrator nor in Hyper-V Administrators, and the Host Compute Service refuses anyone else (HCS_E_ACCESS_DENIED, https://aka.ms/hcsadmin).',
      'Either start the terminal as administrator, or in an admin PowerShell add yourself, then sign out and in: net localgroup "Hyper-V Administrators" "%USERDOMAIN%\\%USERNAME%" /add',
    );
  const image = findImage(p.imageStores());
  if (!image.image)
    need(
      'No Windows Server Core (ltsc2022) image is on this PC. ' + image.reason,
      'Pull one with Docker Desktop (Windows containers mode): docker pull mcr.microsoft.com/windows/servercore:ltsc2022  - or put your own in a folder with an image.json and set AGENT_SANDBOX_HCS_IMAGE to it. This tool does not download images in this alpha.',
    );
  return { available: reasons.length === 0, reasons, fixes };
}

export function system32Dir(): string {
  return path.dirname(system32('x'));
}

/** The groups of a token from `whoami /groups /fo csv /nh`: name, type, SID, attributes per line. */
export function parseWhoamiGroups(csv: string): TokenGroups {
  let elevated = false;
  let hyperV = false;
  for (const line of csv.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (cells.length < 4) continue;
    const [, , sid, attributes] = cells;
    const denyOnly = /deny only/i.test(attributes);
    if (sid === 'S-1-5-32-544' && !denyOnly) elevated = true;
    if (sid === 'S-1-5-32-578' && !denyOnly) hyperV = true;
  }
  return { elevatedAdministrator: elevated, hyperVAdministrators: hyperV };
}

const QUERY_TIMEOUT_MS = 10000;

/** The real probes: sc.exe query, whoami, file checks. They only read. */
export function realHcsProbes(): HcsProbes {
  return {
    isWindows: () => isWin,
    windowsBuild: () => {
      const m = /^\d+\.\d+\.(\d+)/.exec(os.release());
      return m ? Number(m[1]) : null;
    },
    serviceInstalled: (name) => {
      const r = spawnSync(SYSTEM.sc(), ['query', name], { windowsHide: true, timeout: QUERY_TIMEOUT_MS });
      if (r.status === 0) return true;
      return r.status === 1060 ? false : null; // 1060: the service does not exist
    },
    fileExists: (file) => fs.existsSync(file),
    tokenGroups: () => {
      const r = spawnSync(SYSTEM.whoami(), ['/groups', '/fo', 'csv', '/nh'], {
        windowsHide: true,
        timeout: QUERY_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      return r.status === 0 ? parseWhoamiGroups(r.stdout) : null;
    },
    imageStores: () => defaultImageStores(),
  };
}
