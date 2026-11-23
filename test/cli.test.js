import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, runBrowse } from '../src/commands/browse.js';
import { kindOfPort, runView } from '../src/commands/view.js';
import { runLogin } from '../src/commands/login.js';
import { browserVersion, listTargets } from '../src/cdp.js';
import { freePort } from '../src/chrome.js';
import { kittyQuery } from '../src/kitty.js';
import { paths } from '../src/paths.js';
import { upsertEntry, removeEntry, readRegistry } from '../src/registry.js';
import { startFakeCdp } from './helpers/fake-cdp.js';

const BIN = fileURLToPath(new URL('../bin/termbrowse.js', import.meta.url));
const skip = process.env.TERMBROWSE_SKIP_CHROME === '1' ? 'TERMBROWSE_SKIP_CHROME=1' : false;

// Isolated state and config, also for the in-process runBrowse test (launchChrome reads
// process.env). HOME, and so the Chrome for Testing download cache, stays real.
const tmp = await mkdtemp(join(tmpdir(), 'tb-cli-'));
const hookOut = join(tmp, 'hook.out');
process.env.XDG_STATE_HOME = join(tmp, 'state');
process.env.XDG_CONFIG_HOME = join(tmp, 'config');
process.env.HOOKOUT = hookOut;
for (const k of ['TERMBROWSE_CONFIG', 'TERMBROWSE_AGENT', 'TERMBROWSE_ASSUME_KITTY', 'HC_TERMINAL_ID', 'KITTY_WINDOW_ID', 'TERM_PROGRAM']) delete process.env[k];
process.env.TERM = 'dumb';
const env = { ...process.env };
const p = paths(env);
await mkdir(join(tmp, 'config', 'termbrowse'), { recursive: true });
await writeFile(p.config, '[chrome]\nheadless = true\n\n[hooks]\non_launch = "echo $TERMBROWSE_KIND [$TERMBROWSE_AGENT] > $HOOKOUT"\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

// Fake Kitty terminal (as in viewer.test.js): answers the Kitty query and the size queries.
function fakeTerm({ replyDelayMs = 0, kitty = true } = {}) {
  const ESC = '\x1b';
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.rows = 24;
  let out = '';
  stdout.on('data', (d) => { out += d; });
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.includes(kittyQuery())) setTimeout(() => stdin.write(kitty ? `${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c` : `${ESC}[?62;c`), replyDelayMs);
    else if (s.includes(`${ESC}[16t`)) setImmediate(() => stdin.write(`${ESC}[6;20;10t${ESC}[4;480;800t${ESC}[?62;c`));
    return write(chunk, ...rest);
  };
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (d) => { err += d; });
  return { stdin, stdout, stderr, env, signals: new EventEmitter(), out: () => out, err: () => err };
}

const children = [];
after(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
});

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// A live process standing in for a Chrome (registry entries need a live pid), leading its own group.
function fakeChrome() {
  const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  children.push(c);
  return c;
}

test('normalizeUrl adds a scheme where one is missing', () => {
  assert.equal(normalizeUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('localhost'), 'http://localhost');
  assert.equal(normalizeUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('example.com:8443/a'), 'https://example.com:8443/a');
  assert.equal(normalizeUrl('file:///x'), 'file:///x');
  assert.equal(normalizeUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeUrl('about:blank'), 'about:blank');
});

test('view with both --port and --agent is a usage error', async () => {
  const r = await run(['view', '--port', '9222', '--agent', 'a']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage/);
});

test('view with neither --port nor --agent is a usage error', async () => {
  const r = await run(['view']);
  assert.equal(r.code, 2);
});

test('view --agent with no live browser explains and exits 1', async () => {
  const r = await run(['view', '--agent', 'nobody']);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "termbrowse: no browser for agent nobody (it starts on the agent's first browser action)\n");
});

test('agents --json prints [] with empty state', async () => {
  const r = await run(['agents', '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('agents lists live entries with their first page URL, - when unreachable', async () => {
  const cdp = await startFakeCdp();
  const a = fakeChrome();
  const b = fakeChrome();
  try {
    await upsertEntry({ agentId: 'alpha', pid: a.pid, port: cdp.port, profileDir: '/x', kind: 'agent' }, p);
    await upsertEntry({ agentId: 'standalone-1', pid: b.pid, port: 1, profileDir: '/y', kind: 'standalone' }, p);
    const r = await run(['agents']);
    assert.equal(r.code, 0);
    const lines = r.stdout.trimEnd().split('\n').map((l) => l.trim().split(/\s+/));
    assert.deepEqual(lines[0], ['AGENT', 'KIND', 'PORT', 'PID', 'URL']);
    assert.deepEqual(lines[1], ['alpha', 'agent', String(cdp.port), String(a.pid), 'https://example.com/']);
    assert.deepEqual(lines[2], ['standalone-1', 'standalone', '1', String(b.pid), '-']);
    const j = await run(['agents', '--json']);
    assert.deepEqual(JSON.parse(j.stdout).map((e) => [e.agentId, e.url]), [['alpha', 'https://example.com/'], ['standalone-1', null]]);
  } finally {
    await cdp.close();
    a.kill('SIGKILL');
    b.kill('SIGKILL');
  }
});

test('stop --agent kills that Chrome and removes its entry; --all stops the rest', async () => {
  const a = fakeChrome();
  const b = fakeChrome();
  const startedAt = new Date(Date.now() + 1000).toISOString(); // recorded after the process started
  await upsertEntry({ agentId: 'one', pid: a.pid, port: 1, profileDir: '/x', kind: 'agent', startedAt }, p);
  await upsertEntry({ agentId: 'two', pid: b.pid, port: 2, profileDir: '/y', kind: 'agent', startedAt }, p);

  let r = await run(['stop', '--agent', 'one']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`stopped one \\(pid ${a.pid}, port 1\\)`));
  assert.equal(alive(a.pid) && a.exitCode === null, false);
  assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), ['two']);

  r = await run(['stop', '--agent', 'one']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no browser for agent one/);

  r = await run(['stop', '--all']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /stopped two/);
  assert.deepEqual(await readRegistry(p), []);

  r = await run(['stop', '--all']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to stop/);
});

test('stop does not kill a pid it cannot confirm is still that Chrome', async () => {
  const a = fakeChrome(); // started after the entry says its Chrome did, and the port is dead
  await upsertEntry({ agentId: 'reused', pid: a.pid, port: 1, profileDir: '/x', kind: 'agent', startedAt: new Date(Date.now() - 3600_000).toISOString() }, p);
  const r = await run(['stop', '--agent', 'reused']);
  await sleep(300);
  assert.equal(alive(a.pid) && a.exitCode === null, true, 'unrelated process was killed');
  assert.match(r.stderr, new RegExp(`not killing pid ${a.pid}`));
  assert.equal(await (await import('../src/registry.js')).findEntry('reused', p), null, 'entry kept');
});

test('stop needs exactly one of --agent and --all', async () => {
  assert.equal((await run(['stop'])).code, 2);
  assert.equal((await run(['stop', '--agent', 'x', '--all'])).code, 2);
});

test('doctor prints a Node line that is ok', async () => {
  const r = await run(['doctor']);
  const node = r.stdout.split('\n').find((l) => /\bNode\b/.test(l));
  assert.ok(node, r.stdout);
  assert.match(node, /\bok\b/);
});

test('doctor fails on a config that does not parse', async () => {
  const r = await run(['doctor'], { TERMBROWSE_CONFIG: fileURLToPath(new URL('../package.json', import.meta.url)) });
  assert.equal(r.code, 1);
  assert.match(r.stdout.split('\n').find((l) => /config/i.test(l)), /\bfail\b/);
});

test('doctor reports a known Kitty terminal without querying', async () => {
  const r = await run(['doctor'], { TERMBROWSE_ASSUME_KITTY: '1' });
  assert.match(r.stdout.split('\n').find((l) => /Kitty/.test(l)), /ok \(known terminal: TERMBROWSE_ASSUME_KITTY\)/);
});

test('a bare argument is a URL to browse (refused here: not a terminal, before any Chrome starts)', async () => {
  const r = await run(['example.com']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /doesn't support Kitty graphics/);
  assert.deepEqual(await readRegistry(p), []);
});

test('a bare word that cannot be a URL is an unknown command, not a page to open', async () => {
  const r = await run(['agnets']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^termbrowse: unknown command agnets\n/);
  assert.match(r.stderr, /Usage/);
  // localhost is a URL (refused here only because this is not a terminal)
  assert.match((await run(['localhost'])).stderr, /doesn't support Kitty graphics/);
});

test('Node older than 22 is refused with a clear message', async () => {
  const fake = "data:text/javascript,Object.defineProperty(process.versions,'node',{value:'20.19.2'})";
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', fake, BIN, 'agents'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'termbrowse: needs Node 22 or newer (this is 20.19.2)\n');
});

test('unknown options and extra arguments after the URL are usage errors', async () => {
  assert.equal((await run(['--bogus'])).code, 2);
  assert.equal((await run(['example.com', 'more'])).code, 2);
  assert.equal((await run(['agents', '--nope'])).code, 2);
});

test('browse: a terminal without Kitty graphics exits 2 before any Chrome or profile', async () => {
  const pid = fakeChrome().pid;
  const t = fakeTerm({ kitty: false });
  const logsBefore = await readdir(p.logs).catch(() => []);
  const code = await runBrowse('example.com', { ...t, pid });
  assert.equal(code, 2);
  assert.match(t.err(), /doesn't support Kitty graphics/);
  assert.deepEqual(await readdir(p.logs).catch(() => []), logsBefore, 'no Chrome was started (it would leave a log)');
  await assert.rejects(stat(join(p.profiles, `standalone-${pid}`)));
  assert.deepEqual(await readRegistry(p), []);
  assert.equal(t.signals.listenerCount('SIGTERM'), 0);
});

async function startBrowse(pid, termOptions) {
  const t = fakeTerm(termOptions);
  const result = runBrowse('data:text/html,<body style="background:red">hi</body>', { ...t, pid });
  const entry = await until(async () => (await readRegistry(p)).find((e) => e.agentId === `standalone-${pid}`), 30_000);
  return { t, result, entry };
}

test('browse: fresh starter copy per run, registered, drawn, closed and deleted on SIGTERM; two at once', { skip, timeout: 90_000 }, async () => {
  await mkdir(p.starter, { recursive: true });
  await writeFile(join(p.starter, 'from-starter'), 'x');
  await writeFile(join(p.starter, 'lockfile'), 'x'); // never copied (a real SingletonLock would stop login's Chrome below)
  // Each run is named by a pid; live stand-ins let two runs share this test process.
  const [pidA, pidB] = [fakeChrome().pid, fakeChrome().pid];
  const [a, b] = await Promise.all([startBrowse(pidA), startBrowse(pidB)]);
  for (const [run, pid] of [[a, pidA], [b, pidB]]) {
    assert.ok(run.entry, 'standalone entry registered');
    assert.equal(run.entry.kind, 'standalone');
    assert.equal(run.entry.wrapperPid, process.pid);
    assert.equal(run.entry.profileDir, join(p.profiles, `standalone-${pid}`));
    assert.ok(alive(run.entry.pid));
    await stat(join(run.entry.profileDir, 'from-starter'));
    await assert.rejects(stat(join(run.entry.profileDir, 'lockfile')));
    assert.ok(await until(() => run.t.out().includes('\x1b_G'), 15_000), 'a Kitty frame was drawn');
  }
  assert.notEqual(a.entry.port, b.entry.port);
  assert.notEqual(a.entry.profileDir, b.entry.profileDir);
  assert.match(await until(async () => (await readFile(hookOut, 'utf8').catch(() => '')).trim(), 15_000), /^standalone \[\]$/);

  a.t.signals.emit('SIGTERM');
  assert.equal(await a.result, 0);
  assert.equal(alive(a.entry.pid), false);
  await assert.rejects(stat(a.entry.profileDir), 'profile deleted after exit');
  assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), [`standalone-${pidB}`]);
  assert.equal(a.t.signals.listenerCount('SIGTERM'), 0);

  b.t.signals.emit('SIGTERM');
  assert.equal(await b.result, 0);
  await assert.rejects(stat(b.entry.profileDir));
  assert.deepEqual(await readRegistry(p), []);
});

test('browse: a signal while the viewer is still starting ends the run and cleans up', { skip, timeout: 60_000 }, async () => {
  const pid = fakeChrome().pid;
  // The Kitty reply comes late, so the viewer is still in its startup when the signal lands.
  const { t, result, entry } = await startBrowse(pid, { replyDelayMs: 600 });
  assert.ok(entry, 'standalone entry registered');
  t.signals.emit('SIGTERM');
  const code = await Promise.race([result, sleep(10_000).then(() => 'hung')]);
  if (code === 'hung') t.signals.emit('SIGTERM'); // let the run end so the test can clean up
  assert.notEqual(code, 'hung', 'the signal during viewer startup was swallowed');
  assert.equal(code, 0);
  assert.equal(alive(entry.pid), false);
  assert.deepEqual(await readRegistry(p), []);
  await assert.rejects(stat(entry.profileDir));
  assert.equal(t.signals.listenerCount('SIGTERM'), 0);
});

test('browse: stdout errors after the terminal hangs up do not stop the cleanup', { skip, timeout: 60_000 }, async () => {
  const pid = fakeChrome().pid;
  const { t, result, entry } = await startBrowse(pid);
  assert.ok(entry, 'standalone entry registered');
  assert.ok(await until(() => t.out().includes('\x1b_G'), 15_000), 'a Kitty frame was drawn');
  const eio = () => Object.assign(new Error('write EIO'), { code: 'EIO' });
  const write = t.stdout.write;
  t.stdout.write = (chunk, ...rest) => {
    setImmediate(() => t.stdout.emit('error', eio())); // after the viewer has finished, too
    return write(chunk, ...rest);
  };
  t.signals.emit('SIGHUP');
  assert.equal(await result, 0);
  assert.equal(alive(entry.pid), false);
  await assert.rejects(stat(entry.profileDir));
  assert.deepEqual(await readRegistry(p), []);
  assert.equal(t.stdout.listenerCount('error'), 0);
});

// Login with a headless Chrome (tests must not open windows) and a short save delay.
async function startLogin(saveDelayMs) {
  const port = await freePort();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += d));
  stderr.on('data', (d) => (err += d));
  const signals = new EventEmitter();
  // login refuses outright on Linux without a display; the test Chrome is headless, so any value does.
  const loginEnv = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY ? { ...env, DISPLAY: ':0' } : env;
  const result = runLogin([], { stdin, stdout, stderr, env: loginEnv, signals, saveDelayMs, chromeOptions: { headless: true, port } });
  return { port, stdin, signals, result, out: () => out, err: () => err };
}

test('login: Enter, then Saving…, Chrome kept for the delay, then closed', { skip, timeout: 60_000 }, async () => {
  const l = await startLogin(1500);
  assert.ok(await until(() => l.out().includes('Sign in to the sites your agents need, then press Enter here (or close the browser window).\n'), 30_000));
  const { port } = l;
  l.stdin.write('\n');
  assert.ok(await until(() => l.out().includes('Saving your sign-ins…'), 5000));
  assert.ok(await browserVersion(port), 'Chrome still running during the save delay');
  assert.equal(await l.result, 0);
  assert.equal(await browserVersion(port), null);
  assert.equal(l.err(), '');
});

test('login: closing the last page finishes too', { skip, timeout: 60_000 }, async () => {
  const l = await startLogin(0);
  assert.ok(await until(() => l.out().includes('press Enter'), 30_000));
  const { port } = l;
  // As a person would: the window has been up a moment, so login has seen its page (it treats
  // "no pages" as closed only after one was seen; a starting Chrome may list none).
  assert.ok(await until(async () => (await listTargets(port)).some((x) => x.type === 'page'), 10_000));
  await sleep(1200);
  for (const t of (await listTargets(port)).filter((x) => x.type === 'page')) {
    await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
  }
  assert.equal(await l.result, 0);
  assert.match(l.out(), /Saving your sign-ins…/);
  assert.equal(await browserVersion(port), null);
});

test('login: Ctrl-C while saving asks once more; a second quits at once with a warning', { skip, timeout: 60_000 }, async () => {
  const l = await startLogin(60_000);
  assert.ok(await until(() => l.out().includes('press Enter'), 30_000));
  const { port } = l;
  l.stdin.write('\n');
  assert.ok(await until(() => l.out().includes('Saving your sign-ins…'), 5000));
  l.signals.emit('SIGINT');
  assert.ok(await until(() => /Ctrl-C again/.test(l.err()), 2000), l.err());
  assert.ok(await browserVersion(port), 'still saving after one Ctrl-C');
  const t0 = Date.now();
  l.signals.emit('SIGINT');
  assert.equal(await l.result, 130);
  assert.ok(Date.now() - t0 < 10_000);
  assert.match(l.err(), /recent sign-ins may not be saved/);
  assert.equal(await browserVersion(port), null);
});

test('login: a first poll with no pages yet is not a closed browser', { timeout: 60_000 }, async () => {
  // A stand-in Chrome: no pages for two polls (still starting), then one, then none; it quits
  // after the last answer. listCount records how many polls it answered.
  const countFile = join(tmp, 'login-polls');
  const exe = join(tmp, 'slow-start-chrome.mjs');
  await writeFile(exe, `#!${process.execPath}
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const port = Number(process.argv.find((a) => a.startsWith('--remote-debugging-port=')).split('=')[1]);
const plan = [[], [], [{ id: 'P', type: 'page', url: 'about:blank' }], [{ id: 'P', type: 'page', url: 'about:blank' }], []];
let n = 0;
http.createServer((q, r) => {
  if (q.url !== '/json/list') return r.end('{"Browser":"fake"}');
  const answer = plan[Math.min(n, plan.length - 1)];
  n++;
  writeFileSync(${JSON.stringify(countFile)}, String(n));
  r.end(JSON.stringify(answer));
  if (n === plan.length) setTimeout(() => process.exit(0), 50);
}).listen(port, '127.0.0.1');
`);
  await import('node:fs/promises').then((m) => m.chmod(exe, 0o755));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (d) => (out += d));
  const loginEnv = process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY ? { ...env, DISPLAY: ':0' } : env;
  const code = await runLogin([], { stdin, stdout, stderr: new PassThrough(), env: loginEnv, signals: new EventEmitter(), saveDelayMs: 0, chromeOptions: { headless: true, executablePath: exe } });
  assert.equal(code, 0);
  assert.equal(Number(await readFile(countFile, 'utf8')), 5, 'kept polling past the empty first answers');
  assert.match(out, /Saving your sign-ins…/);
});

test('no arguments prints usage and exits 2', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage/);
});

test('--fill and --no-fill together are a usage error, for browse and view', async () => {
  for (const args of [['example.com', '--fill', '--no-fill'], ['--no-fill', '--fill', 'example.com'], ['view', '--port', '9222', '--fill', '--no-fill']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /--fill/);
    assert.match(r.stderr, /Usage/);
  }
});

test('browse accepts --fill / --no-fill around the URL', async () => {
  for (const args of [['example.com', '--no-fill'], ['--fill', 'example.com']]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /doesn't support Kitty graphics/, 'got as far as the terminal check');
  }
});

test('view --port: the registry says whose browser a port is', async () => {
  const [a, b] = [fakeChrome().pid, fakeChrome().pid];
  await upsertEntry({ agentId: 'kind-agent', pid: a, port: 40001, profileDir: '/x', kind: 'agent' }, p);
  await upsertEntry({ agentId: 'standalone-k', pid: b, port: 40002, profileDir: '/y', kind: 'standalone' }, p);
  try {
    assert.equal(await kindOfPort(40001, p), 'agent');
    assert.equal(await kindOfPort(40002, p), 'standalone');
    assert.equal(await kindOfPort(40003, p), 'unknown');
  } finally {
    await removeEntry('kind-agent', p);
    await removeEntry('standalone-k', p);
  }
});

// What view/browse hand the viewer: control.agentId decides whether the agent is made to wait.
test('view --agent ID passes that agent id to the viewer; --port on an agent port passes the same id', async () => {
  const [a, b] = [fakeChrome().pid, fakeChrome().pid];
  await upsertEntry({ agentId: 'ctl-agent', pid: a, port: 40011, profileDir: '/x', kind: 'agent' }, p);
  await upsertEntry({ agentId: 'standalone-ctl', pid: b, port: 40012, profileDir: '/y', kind: 'standalone' }, p);
  const seen = [];
  const viewer = async (opts) => { seen.push(opts); return 0; };
  try {
    for (const args of [['--agent', 'ctl-agent'], ['--port', '40011'], ['--port', '40012'], ['--port', '40013']]) {
      assert.equal(await runView(args, { env, viewer, stderr: new PassThrough() }), 0);
    }
  } finally {
    await removeEntry('ctl-agent', p);
    await removeEntry('standalone-ctl', p);
  }
  assert.deepEqual(seen.map((o) => o.port), [40011, 40011, 40012, 40013]);
  assert.deepEqual(seen.map((o) => o.control.agentId), ['ctl-agent', 'ctl-agent', null, null], 'only agent browsers are controlled');
  assert.equal(seen[0].control.idleReturnMs, 300_000);
  assert.equal(seen[0].keys.prefix.label, 'Ctrl-]');
});

test('browse passes null as the control agent id (standalone browsers never write a control file)', { skip, timeout: 60_000 }, async () => {
  const t = fakeTerm();
  let opts;
  const code = await runBrowse('about:blank', {
    ...t, pid: fakeChrome().pid, viewer: async (o) => { opts = o; return 0; },
  });
  assert.equal(code, 0);
  assert.equal(opts.control.agentId, null);
  assert.equal(opts.control.idleReturnMs, 300_000);
});
