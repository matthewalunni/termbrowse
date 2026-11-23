import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureChrome, freePort, launchChrome } from '../src/chrome.js';
import { listTargets, browserVersion } from '../src/cdp.js';
import { loadConfig } from '../src/config.js';
import { paths } from '../src/paths.js';

const skip = process.env.TERMBROWSE_SKIP_CHROME === '1' ? 'TERMBROWSE_SKIP_CHROME=1' : false;

// State and logs go to a temp XDG dir. The browser cache deliberately stays at the real
// cache dir (ensureChrome gets real paths() for cache) so Chrome for Testing is downloaded
// once, not on every run.
const tmp = await mkdtemp(join(tmpdir(), 'tb-chrome-'));
process.env.XDG_STATE_HOME = join(tmp, 'state');


const launched = [];
after(async () => {
  await Promise.all(launched.map((c) => c.kill().catch(() => {})));
  await rm(tmp, { recursive: true, force: true });
});

async function launch(opts) {
  const c = await launchChrome({ headless: true, windowSize: [800, 600], extraArgs: [], ...opts });
  launched.push(c);
  return c;
}

let chrome;
test('ensureChrome returns an existing executable', { skip, timeout: 300_000 }, async () => {
  const cfg = await loadConfig({ ...process.env, TERMBROWSE_CONFIG: join(tmp, 'none.toml') });
  chrome = await ensureChrome(cfg, paths(process.env));
  await access(chrome.executablePath, constants.X_OK);
  assert.ok(chrome.buildId);
});

test('launchChrome opens a page and kill() closes the port', { skip, timeout: 60_000 }, async () => {
  const c = await launch({
    profileDir: join(tmp, 'p1'),
    url: 'data:text/html,<title>t</title>hi',
  });
  let targets;
  for (let i = 0; i < 50; i++) {
    targets = await listTargets(c.port);
    if (targets.some((t) => t.type === 'page' && t.title === 't')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(targets.some((t) => t.type === 'page' && t.title === 't'), JSON.stringify(targets));
  await c.kill();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await browserVersion(c.port))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await browserVersion(c.port), null);
});

test('concurrent freePort + launches get different ports', { skip, timeout: 60_000 }, async () => {
  const ports = await Promise.all([freePort(), freePort()]);
  assert.equal(typeof ports[0], 'number');
  const [a, b] = await Promise.all([
    launch({ profileDir: join(tmp, 'pa') }),
    launch({ profileDir: join(tmp, 'pb') }),
  ]);
  assert.notEqual(a.port, b.port);
});
