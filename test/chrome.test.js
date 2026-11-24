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
    launchChrome({ executablePath: exe, profileDir: join(tmp, 'pf'), headless: true, windowSize: [1, 1], extraArgs: [], startTimeoutMs: 1500 }),
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

// Real Chrome's helpers (GPU, network, renderers) can outlive the main process by a moment and
// still write to the profile: kill() returns only once the whole group is gone, so a caller can
// delete the profile right after.
test('kill() waits for helpers that outlive the main process', async () => {
  const pidfile = join(tmp, 'lingering.pids');
  const exe = join(tmp, 'lingering-chrome.mjs');
  await writeFile(exe, `#!${process.execPath}
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const helper = spawn('/bin/sh', ['-c', 'trap "sleep 0.6; exit 0" TERM; while :; do sleep 0.1; done'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidfile)}, process.pid + ' ' + helper.pid);
process.on('SIGTERM', () => process.exit(0));
const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
http.createServer((q, r) => r.end('{"Browser":"fake"}')).listen(port, '127.0.0.1');
`);
  await chmod(exe, 0o755);
  const c = await launchChrome({ executablePath: exe, profileDir: join(tmp, 'pl'), headless: true, windowSize: [1, 1], extraArgs: [], killGraceMs: 3000 });
  const [main, helper] = (await readFile(pidfile, 'utf8')).split(' ').map(Number);
  assert.ok(alive(main) && alive(helper));
  await c.kill();
  assert.equal(alive(main), false, 'main pid alive');
  assert.equal(alive(helper), false, 'kill() returned while a helper was still running');
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

// --- launch flags and ensureChrome offline/concurrency paths (no real Chrome, no network) ---
test('chromeArgs adds the Puppeteer anti-throttling defaults, nothing that changes logins', async () => {
  const { chromeArgs } = await import('../src/chrome.js');
  const base = { port: 9333, profileDir: '/p', headless: false, windowSize: [1280, 800], extraArgs: ['--x'], url: 'about:blank' };
  for (const platform of ['darwin', 'linux']) {
    const args = chromeArgs({ ...base, platform });
    for (const f of [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-popup-blocking',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-features=Translate',
    ]) assert.ok(args.includes(f), `${platform}: ${f}`);
    for (const f of ['--enable-automation', '--disable-extensions', '--mute-audio', '--headless=new']) {
      assert.ok(!args.includes(f), `${platform}: unexpected ${f}`);
    }
    assert.equal(args.at(-1), 'about:blank');
    assert.equal(args.at(-2), '--x', 'extra args come after ours, so they can override');
    assert.equal(args.includes('--disable-dev-shm-usage'), platform === 'linux');
    assert.equal(args.includes('--password-store=basic'), platform === 'linux');
    assert.equal(args.includes('--use-mock-keychain'), platform === 'darwin');
  }
  assert.ok(chromeArgs({ ...base, headless: true, platform: 'darwin' }).includes('--headless=new'));
});

async function cachePaths() {
  const home = await mkdtemp(join(tmp, 'home-'));
  return paths({ HOME: home });
}
const cfgStable = { chrome: { channel: 'stable' } };
const { Browser, computeExecutablePath, detectBrowserPlatform } = await import('@puppeteer/browsers');
async function fakeInstalled(p, buildId) {
  const executablePath = computeExecutablePath({ cacheDir: join(p.cache, 'browsers'), browser: Browser.CHROME, buildId, platform: detectBrowserPlatform() });
  const { mkdir: mk } = await import('node:fs/promises');
  await mk(join(executablePath, '..'), { recursive: true });
  await writeFile(executablePath, '#!/bin/sh\n');
  await chmod(executablePath, 0o755);
  return executablePath;
}

test('ensureChrome falls back to the newest installed build when the lookup fails or hangs', async () => {
  const p = await cachePaths();
  await fakeInstalled(p, '9.0.1.2');
  const newest = await fakeInstalled(p, '10.0.0.1');
  const installer = () => { throw new Error('must not install'); };
  const failing = () => Promise.reject(new Error('offline'));
  assert.deepEqual(await ensureChrome(cfgStable, p, { resolve: failing, installer }), { executablePath: newest, buildId: '10.0.0.1' });
  const hanging = () => new Promise(() => {});
  const t0 = Date.now();
  assert.equal((await ensureChrome(cfgStable, p, { resolve: hanging, installer, resolveTimeoutMs: 100 })).buildId, '10.0.0.1');
  assert.ok(Date.now() - t0 < 2000);
});

test('ensureChrome with no lookup and nothing installed fails clearly', async () => {
  const p = await cachePaths();
  await assert.rejects(
    ensureChrome(cfgStable, p, { resolve: () => Promise.reject(new Error('offline')), installer: () => { throw new Error('no'); } }),
    /could not look up the current Chrome for Testing build \(offline\) and none is installed/,
  );
});

test('two concurrent ensureChrome calls install once', async () => {
  const p = await cachePaths();
  let installs = 0;
  const installer = async ({ buildId }) => {
    installs++;
    await new Promise((r) => setTimeout(r, 200));
    return { executablePath: await fakeInstalled(p, buildId) };
  };
  const resolve = async () => '11.0.0.0';
  const saved = process.stderr.write;
  process.stderr.write = () => true; // the download notice
  let got;
  try {
    got = await Promise.all([ensureChrome(cfgStable, p, { resolve, installer }), ensureChrome(cfgStable, p, { resolve, installer })]);
  } finally {
    process.stderr.write = saved;
  }
  assert.equal(installs, 1);
  assert.equal(got[0].executablePath, got[1].executablePath);
  await access(got[0].executablePath, constants.X_OK);
});

// --- install lock: holder pid, staleness, refresh, waiting notice ---
const lockFile = (p) => join(p.cache, 'browsers', 'install.lock');
async function deadPid() {
  const { spawn } = await import('node:child_process');
  const c = spawn('/bin/sh', ['-c', 'exit 0']);
  await new Promise((r) => c.once('exit', r));
  return c.pid;
}
function sink() {
  let text = '';
  return { write: (s) => { text += s; return true; }, text: () => text };
}
const WAIT_MSG = 'termbrowse: waiting for another termbrowse to finish downloading Chrome…\n';

test('an install lock left by a dead pid is taken over at once', async () => {
  const p = await cachePaths();
  const { mkdir: mk } = await import('node:fs/promises');
  await mk(join(p.cache, 'browsers'), { recursive: true });
  await writeFile(lockFile(p), String(await deadPid())); // fresh mtime: only the pid says it is stale
  const err = sink();
  const installer = async ({ buildId }) => ({ executablePath: await fakeInstalled(p, buildId) });
  const t0 = Date.now();
  const got = await ensureChrome(cfgStable, p, { resolve: async () => '12.0.0.0', installer, stderr: err });
  assert.equal(got.buildId, '12.0.0.0');
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.ok(!err.text().includes('waiting for another'), err.text());
  await assert.rejects(access(lockFile(p)), 'lock released');
});

test('an install lock held by a live pid is waited on, with one notice', async () => {
  const p = await cachePaths();
  const { mkdir: mk, unlink: rmFile } = await import('node:fs/promises');
  await mk(join(p.cache, 'browsers'), { recursive: true });
  await writeFile(lockFile(p), String(process.pid));
  const err = sink();
  const installer = async ({ buildId }) => ({ executablePath: await fakeInstalled(p, buildId) });
  let done = false;
  const pr = ensureChrome(cfgStable, p, { resolve: async () => '13.0.0.0', installer, stderr: err }).then((r) => { done = true; return r; });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(done, false, 'must wait for the live holder');
  assert.equal(err.text().split(WAIT_MSG).length - 1, 1, err.text());
  await rmFile(lockFile(p));
  assert.equal((await pr).buildId, '13.0.0.0');
  assert.equal(err.text().split(WAIT_MSG).length - 1, 1, 'printed once');
});

// A fake install that runs 300 ms with its lock aged a minute, reporting download progress
// every 20 ms or not at all; returns the lock's pid text and mtimes before and after.
async function longInstall(p, buildId, progress) {
  const { stat: st, utimes } = await import('node:fs/promises');
  const seen = {};
  const installer = async (opts) => {
    seen.pid = (await readFile(lockFile(p), 'utf8')).trim();
    const old = new Date(Date.now() - 60_000);
    await utimes(lockFile(p), old, old); // as if the download had been running a while
    seen.before = (await st(lockFile(p))).mtimeMs;
    let bytes = 0;
    const tick = progress ? setInterval(() => opts.downloadProgressCallback((bytes += 1000), 100_000), 20) : null;
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(tick);
    await new Promise((r) => setTimeout(r, 20)); // let a last touch land
    seen.after = (await st(lockFile(p))).mtimeMs;
    return { executablePath: await fakeInstalled(p, opts.buildId) };
  };
  await ensureChrome(cfgStable, p, { resolve: async () => buildId, installer, lockRefreshMs: 50, stderr: sink() });
  return seen;
}

test('the install lock records the holder pid and its mtime is refreshed as the download progresses', async () => {
  const p = await cachePaths();
  const seen = await longInstall(p, '14.0.0.0', true);
  assert.equal(seen.pid, String(process.pid));
  assert.ok(seen.after - seen.before > 30_000, `mtime not refreshed: ${seen.before} -> ${seen.after}`);
});

test('a stalled download (no progress) does not keep its install lock fresh', async () => {
  const p = await cachePaths();
  const seen = await longInstall(p, '14.0.0.1', false);
  assert.equal(seen.after, seen.before, 'refreshed without progress');
});

test('if the pid cannot be written into the install lock, the lock is removed', async () => {
  const p = await cachePaths();
  const { open: openFile, mkdir: mk } = await import('node:fs/promises');
  await mk(join(p.cache, 'browsers'), { recursive: true });
  const probe = await openFile(join(p.cache, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const real = proto.writeFile;
  proto.writeFile = async function () { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
  try {
    await assert.rejects(
      ensureChrome(cfgStable, p, { resolve: async () => '16.0.0.0', installer: () => { throw new Error('no'); }, stderr: sink() }),
      /ENOSPC/,
    );
  } finally {
    proto.writeFile = real;
  }
  await assert.rejects(access(lockFile(p)), 'lock left behind');
});

// --- version lookup cap: short only when a build is already installed ---
test('with nothing installed, a lookup slower than the short cap still installs', async () => {
  const p = await cachePaths();
  const slow = () => new Promise((r) => setTimeout(() => r('15.0.0.0'), 300));
  const installer = async ({ buildId }) => ({ executablePath: await fakeInstalled(p, buildId) });
  const got = await ensureChrome(cfgStable, p, { resolve: slow, installer, resolveTimeoutMs: 100, stderr: sink() });
  assert.equal(got.buildId, '15.0.0.0');
});

test('with nothing installed, a lookup that outlasts the long cap fails clearly', async () => {
  const p = await cachePaths();
  const t0 = Date.now();
  await assert.rejects(
    ensureChrome(cfgStable, p, { resolve: () => new Promise(() => {}), installer: () => { throw new Error('no'); }, resolveTimeoutMs: 50, freshResolveTimeoutMs: 300 }),
    /could not look up the current Chrome for Testing build \(timed out after 300 ms\) and none is installed/,
  );
  assert.ok(Date.now() - t0 < 2000);
});

// --- background launch on macOS: no startup window, first page created in the background ---
test('launchPlan: only a windowed darwin launch with background on skips the startup window', async () => {
  const { launchPlan } = await import('../src/chrome.js');
  const base = { port: 9333, profileDir: '/p', windowSize: [1280, 800], extraArgs: ['--x'], url: 'https://example.com/' };
  for (const platform of ['darwin', 'linux']) {
    for (const headless of [false, true]) {
      for (const background of [false, true]) {
        const label = `${platform} headless=${headless} background=${background}`;
        const { args, createTarget } = launchPlan({ ...base, platform, headless, background });
        assert.equal(args.includes('--use-mock-keychain'), platform === 'darwin', `${label}: mock keychain on every macOS launch`);
        assert.equal(args.includes('--password-store=basic'), platform === 'linux', label);
        if (platform === 'darwin' && !headless && background) {
          assert.deepEqual(createTarget, { url: 'https://example.com/' }, label);
          assert.ok(args.includes('--no-startup-window'), label);
          assert.ok(!args.includes('https://example.com/'), `${label}: no positional url`);
          assert.equal(args.at(-1), '--x', `${label}: extra args still come last`);
        } else {
          assert.equal(createTarget, null, label);
          assert.ok(!args.includes('--no-startup-window'), label);
          assert.equal(args.at(-1), 'https://example.com/', label);
          assert.equal(args.at(-2), '--x', label);
        }
      }
    }
  }
});

test('a background launch resolves with its first page already created', { skip, timeout: 60_000 }, async () => {
  // Takes the darwin windowed+background path on any platform, but --headless=new in extraArgs
  // keeps the window from ever appearing.
  const c = await launch({
    profileDir: join(tmp, 'pbg'),
    url: 'data:text/html,<title>bg</title>hi',
    headless: false,
    background: true,
    platform: 'darwin',
    extraArgs: ['--headless=new'],
  });
  const { execFileSync } = await import('node:child_process');
  const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(c.pid)], { encoding: 'utf8' });
  assert.ok(cmd.includes('--no-startup-window'), cmd);
  assert.ok(!cmd.includes('data:text/html'), 'the url is not a positional arg');
  const pages = (await listTargets(c.port)).filter((t) => t.type === 'page');
  assert.equal(pages.length, 1, JSON.stringify(pages));
  assert.match(pages[0].url, /^data:text\/html/);
});

test('a background launch that cannot create its first page rejects and kills Chrome', async () => {
  const pidfile = join(tmp, 'nows.pid');
  // Answers /json/version without a browser websocket, so the first page cannot be created.
  const exe = join(tmp, 'nows-chrome.mjs');
  await writeFile(exe, `#!${process.execPath}
import http from 'node:http';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidfile)}, String(process.pid));
const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
http.createServer((q, r) => r.end('{"Browser":"fake"}')).listen(port, '127.0.0.1');
`);
  await chmod(exe, 0o755);
  await assert.rejects(
    launchChrome({
      executablePath: exe, profileDir: join(tmp, 'pn'), headless: false, background: true, platform: 'darwin',
      windowSize: [1, 1], extraArgs: [], startTimeoutMs: 3000,
    }),
    /first page/,
  );
  const pid = Number((await readFile(pidfile, 'utf8')).trim());
  assert.ok(await waitDead(pid), `pid ${pid} still alive`);
});
