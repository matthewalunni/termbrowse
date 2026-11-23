import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, constants, writeFile, chmod, readFile } from 'node:fs/promises';
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

// --- failure paths, using fake "chrome" executables (no real Chrome needed) ---
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitDead = async (pid, ms = 3000) => {
  const end = Date.now() + ms;
  while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};
async function fakeChrome(name, body) {
  const file = join(tmp, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

test('failed start rejects and kills the child', async () => {
  const pidfile = join(tmp, 'fail.pid');
  const exe = await fakeChrome('fail-chrome', `echo $$ > "${pidfile}"\nexec sleep 60`);
  await assert.rejects(
    launchChrome({ executablePath: exe, profileDir: join(tmp, 'pf'), headless: true, windowSize: [1, 1], extraArgs: [], startTimeoutMs: 400 }),
    /did not open/,
  );
  const pid = Number((await readFile(pidfile, 'utf8')).trim());
  assert.ok(await waitDead(pid), `pid ${pid} still alive`);
});

test('spawn error (bogus executable) rejects', async () => {
  await assert.rejects(
    launchChrome({ executablePath: join(tmp, 'does-not-exist'), profileDir: join(tmp, 'pe'), headless: true, windowSize: [1, 1], extraArgs: [], startTimeoutMs: 2000 }),
    /ENOENT/,
  );
});

test('kill() escalates to SIGKILL and takes the whole process group', async () => {
  const pidfile = join(tmp, 'stubborn.pids');
  // Ignores SIGTERM, answers /json/version, and has a helper child in the same group.
  const exe = join(tmp, 'stubborn-chrome.mjs');
  await writeFile(exe, `#!${process.execPath}
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
const helper = spawn('/bin/sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidfile)}, process.pid + ' ' + helper.pid);
const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
http.createServer((q, r) => r.end('{"Browser":"fake"}')).listen(port, '127.0.0.1');
`);
  await chmod(exe, 0o755);
  const c = await launchChrome({ executablePath: exe, profileDir: join(tmp, 'ps'), headless: true, windowSize: [1, 1], extraArgs: [], killGraceMs: 300 });
  const [main, helper] = (await readFile(pidfile, 'utf8')).split(' ').map(Number);
  assert.ok(alive(main) && alive(helper));
  const t0 = Date.now();
  await c.kill();
  assert.ok(Date.now() - t0 >= 250, 'should have waited for the grace period');
  assert.ok(await waitDead(main), 'main pid alive');
  assert.ok(await waitDead(helper), 'helper pid alive');
});

test('chrome that exits before opening its port rejects at once with the exit code', async () => {
  const exe = await fakeChrome('exit-chrome', 'exit 7');
  const t0 = Date.now();
  await assert.rejects(
    launchChrome({ executablePath: exe, profileDir: join(tmp, 'px'), headless: true, windowSize: [1, 1], extraArgs: [], startTimeoutMs: 10_000 }),
    /exited before opening its debugging port.*code 7/,
  );
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
