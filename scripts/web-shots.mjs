// Screenshots of the web UI preview (npm run web:preview) with the Edge every sandbox has, through playwright-core (no
// browser download). Usage: node scripts/web-shots.mjs <out folder> [path ...] [--port 47900] [--width 1400]
// [--height 900] [--dark] [--mobile]. Paths default to every page; each becomes <out>/<name>[-dark|-mobile].png.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const flag = (name) => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const port = Number(option('--port', '47900'));
const width = Number(option('--width', '1400'));
const height = Number(option('--height', '900'));
const dark = flag('--dark');
const mobile = flag('--mobile');
const [out = 'web-shots', ...paths] = args;
const pages = paths.length ? paths : ['/v/sessions', '/v/sandbox', '/v/settings', '/s/mva4ungc50e051'];

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width, height },
  deviceScaleFactor: mobile ? 2 : 1,
  colorScheme: dark ? 'dark' : 'light',
});
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('page error: ' + e.message));
page.on('console', (m) => m.type() === 'error' && problems.push('console: ' + m.text()));
const base = 'http://127.0.0.1:' + port;
// The preview may still be starting: try for a while before giving up.
for (let tries = 0; ; tries++) {
  try {
    await page.goto(base + '/#k=' + 'b'.repeat(64));
    break;
  } catch (e) {
    if (tries >= 30) throw e;
    await new Promise((r) => setTimeout(r, 500));
  }
}
await page.waitForLoadState('networkidle');
for (const p of pages) {
  await page.goto(base + p);
  await page.waitForTimeout(1500);
  const name =
    (p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home') +
    (dark ? '-dark' : '') +
    (mobile ? '-mobile' : '');
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file, fullPage: !p.startsWith('/s/') });
  console.log(file);
}
await browser.close();
if (problems.length) console.log(problems.join('\n'));
