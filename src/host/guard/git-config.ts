// Git config lines that make git run a program on this PC: found by comparing with the snapshot, then commented out.
import fs from 'node:fs';
import path from 'node:path';
import _ from 'lodash';
import { writeFileAtomic } from '../../shared/io/index.js';
import { fileExists, isLink } from '../../core/util/index.js';
import type { RepoFinding } from './types.js';

/** Config keys that make git run a program, or load more config. */
const DANGEROUS_KEY =
  /^(fsmonitor|hookspath|sshcommand|pager|editor|askpass|program|gpgprogram|textconv|command|cmd|tocmd|cccmd|smtpserver|httpd|vcs|packobjectshook|clean|smudge|process|driver|helper|uploadpack|receivepack|path|attributesfile|excludesfile|worktree|worktreeconfig|gitproxy|proxycommand|sendemailvalidate|tool|external|difffilter|defaultkeycommand|alternaterefscommand)\s*(=|$)/i;
/**
 * A section header as git reads it: a name (the old [section.sub] form included), then an optional quoted subsection
 * in which `]` and escaped quotes are allowed ([filter "a]b"] must not hide the key after it).
 */
const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\]\s*/;
/** Sections where any key is risky: [protocol] turns on transports that run commands (ext::), [url] rewrites remotes. */
const RISKY_SECTIONS = new Set(['pager', 'protocol', 'url']);
const MARK = '# [agent-sandbox] disabled, added inside the sandbox: ';
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/**
 * Sections where any key runs a program ([pager] log = x), where a "!" value does ([alias] st = !x, also quoted or on a
 * continued line: every new alias line with a "!" counts), or a "!" submodule update command.
 */
function dangerousInSection(section: string, keyPart: string): boolean {
  if (keyPart === '' || /^[#;]/.test(keyPart)) return false;
  if (RISKY_SECTIONS.has(section)) return true;
  if (section === 'alias') return keyPart.includes('!');
  return section === 'submodule' && /^update\s*=/i.test(keyPart) && keyPart.includes('!');
}

/** The lines of <dir>\config (none for a link or a file over 4 MB). */
export function configLines(dir: string): string[] {
  const file = path.join(dir, 'config');
  return fileExists(file) && !isLink(file) && fs.statSync(file).size <= MAX_CONFIG_BYTES
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/)
    : [];
}

/** Comments out newly added config lines that make git run programs. Existing lines are never touched. */
export function disableConfig(dir: string, before: readonly string[]): RepoFinding[] {
  const lines = configLines(dir);
  const known = _.countBy(before);
  const seen: Record<string, number> = {};
  const findings: RepoFinding[] = [];
  let inInclude = false;
  let section = '';
  const fixed = lines.map((line) => {
    const header = SECTION.exec(line);
    // A line that starts like a header but is not one git would accept: treat it as unknown (risky) below.
    const badHeader = !header && /^\s*\[/.test(line);
    if (header) {
      section = header[1].toLowerCase().split('.')[0];
      inInclude = section === 'include' || section === 'includeif';
    }
    seen[line] = (seen[line] ?? 0) + 1;
    if (line.startsWith(MARK) || seen[line] <= (known[line] ?? 0)) return line;
    // git also accepts "[core] fsmonitor = x" on one line, so look past a leading section header.
    const keyPart = line.replace(SECTION, '').trim();
    if (
      !(
        badHeader ||
        DANGEROUS_KEY.test(keyPart) ||
        (inInclude && keyPart.includes('=')) ||
        dangerousInSection(section, keyPart)
      )
    )
      return line;
    findings.push({ kind: 'config', detail: line.trim() });
    return MARK + line.trim();
  });
  if (findings.length) writeFileAtomic(path.join(dir, 'config'), fixed.join('\n'));
  const file = path.join(dir, 'config');
  // A link or a huge file is not read at all, so say so instead of letting it pass as "nothing found".
  const unchecked = isLink(file)
    ? '.git/config is a link'
    : lines.length === 0 && fileExists(file) && fs.statSync(file).size > MAX_CONFIG_BYTES
      ? '.git/config is over 4 MB'
      : null;
  if (unchecked)
    findings.push({
      kind: 'git',
      detail: unchecked + ', so it cannot be checked. Do not run git in this folder until you have looked at it.',
    });
  return findings;
}
