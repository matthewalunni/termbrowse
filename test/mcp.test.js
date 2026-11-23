import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentId } from '../src/agent-id.js';
import { paths } from '../src/paths.js';
import { readRegistry, findEntry } from '../src/registry.js';
import { listTargets } from '../src/cdp.js';

const skip = process.env.TERMBROWSE_SKIP_CHROME === '1' ? 'TERMBROWSE_SKIP_CHROME=1' : false;
const BIN = fileURLToPath(new URL('../bin/termbrowse.js', import.meta.url));

test('agentId: TERMBROWSE_AGENT, then HC_TERMINAL_ID, then pid-<ppid>', () => {
  assert.equal(agentId({ TERMBROWSE_AGENT: 'a', HC_TERMINAL_ID: 't1' }, 42), 'a');
  assert.equal(agentId({ HC_TERMINAL_ID: 't1' }, 42), 't1');
  assert.equal(agentId({}, 42), 'pid-42');
});

// Isolated state and config. HOME (and so the Chrome for Testing download cache) stays real
// so the browser is downloaded once, as in chrome.test.js.
const tmp = await mkdtemp(join(tmpdir(), 'tb-mcp-'));
const env = { ...process.env, XDG_STATE_HOME: join(tmp, 'state'), XDG_CONFIG_HOME: join(tmp, 'config') };
delete env.TERMBROWSE_CONFIG;
delete env.TERMBROWSE_AGENT;
delete env.HC_TERMINAL_ID;
const p = paths(env);
await mkdir(join(tmp, 'config', 'termbrowse'), { recursive: true });
await writeFile(p.config, '[chrome]\nheadless = true\n\n[hooks]\non_launch = "echo $TERMBROWSE_AGENT >> $HOOKOUT"\n');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

const wrappers = [];
after(async () => {
  for (const w of wrappers) if (w.child.exitCode === null) w.child.kill('SIGKILL');
  // Kill any Chrome a wrapper left behind (its process group), then drop the temp dirs.
  const left = await readRegistry(p).catch(() => []);
  for (const e of left) {
    try { process.kill(-e.pid, 'SIGKILL'); } catch {}
  }
  await rm(tmp, { recursive: true, force: true });
});

class Wrapper {
  constructor(agent, extraEnv = {}) {
    this.agent = agent;
    this.child = spawn(process.execPath, [BIN, 'mcp', '--', '--no-usage-statistics', '--no-performance-crux'], {
      env: { ...env, TERMBROWSE_AGENT: agent, HOOKOUT: join(tmp, `hook-${agent}.txt`), ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.exit = new Promise((r) => this.child.once('exit', (code) => r(code)));
    this.waiters = new Map();
    this.lines = [];
    this.nextId = 1;
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        this.lines.push(msg);
        this.waiters.get(msg.id)?.(msg);
      }
    });
    wrappers.push(this);
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params && { params }) }) + '\n');
  }
  request(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.agent}: no reply to ${method} #${id}`)), timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }) + '\n');
    return reply;
  }
  async init() {
    const r = await this.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'termbrowse-test', version: '0' },
    });
    this.notify('notifications/initialized');
    return r;
  }
  call(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }
}

const text = (r) => (r.result?.content ?? []).map((c) => c.text).join('\n');

let a;
test('lazy start: initialize and tools/list answer without starting Chrome', { skip, timeout: 60_000 }, async () => {
  a = new Wrapper('test-a');
  const init = await a.init();
  assert.equal(init.result.serverInfo.name, 'chrome_devtools');
  const list = await a.request('tools/list');
  assert.ok(list.result.tools.some((t) => t.name === 'new_page'));
  assert.deepEqual(await readRegistry(p), []);
});

let entryA;
test('starts chrome on first tool call', { skip, timeout: 300_000 }, async () => {
  const r = await a.call('new_page', { url: 'data:text/html,<title>x</title>' });
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  entryA = await findEntry('test-a', p);
  assert.ok(entryA, 'registry entry for test-a');
  assert.ok(alive(entryA.pid));
  assert.equal(entryA.kind, 'agent');
  const targets = await listTargets(entryA.port);
  assert.ok(targets.some((t) => t.title === 'x'), JSON.stringify(targets.map((t) => t.title)));
});

let b;
test('two agents, two chromes', { skip, timeout: 120_000 }, async () => {
  b = new Wrapper('test-b');
  await b.init();
  const r = await b.call('list_pages');
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  const entryB = await findEntry('test-b', p);
  assert.ok(entryB && alive(entryB.pid));
  assert.notEqual(entryB.port, entryA.port);
  assert.notEqual(entryB.profileDir, entryA.profileDir);
  assert.notEqual(entryB.pid, entryA.pid);
});

test('hook runs once per launch', { skip, timeout: 60_000 }, async () => {
  const r = await a.call('list_pages');
  assert.ok(!r.result.isError, JSON.stringify(r));
  const file = join(tmp, 'hook-test-a.txt');
  await until(() => readFile(file, 'utf8').catch(() => ''));
  await sleep(500); // a second (wrong) run would land by now
  assert.equal(await readFile(file, 'utf8'), 'test-a\n');
});

test('relaunches Chrome on the next tool call after it dies', { skip, timeout: 120_000 }, async () => {
  const before = await findEntry('test-b', p);
  process.kill(-before.pid, 'SIGKILL');
  assert.ok(await until(() => !alive(before.pid)));
  const r = await b.call('new_page', { url: 'data:text/html,<title>again</title>' });
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  const now = await findEntry('test-b', p);
  assert.ok(now && alive(now.pid) && now.pid !== before.pid);
  assert.equal(now.port, before.port);
  assert.ok((await listTargets(now.port)).some((t) => t.title === 'again'));
});

test('cleanup on exit: closing stdin kills Chrome, removes the entry, keeps the profile', { skip, timeout: 30_000 }, async () => {
  a.child.stdin.end();
  assert.equal(await a.exit, 0);
  assert.ok(await until(() => !alive(entryA.pid), 5000), 'chrome still alive');
  assert.equal(await findEntry('test-a', p), null);
  assert.ok((await stat(entryA.profileDir)).isDirectory());
  assert.ok(await findEntry('test-b', p), 'test-b untouched');
});

test('SIGTERM shuts down the same way', { skip, timeout: 30_000 }, async () => {
  const e = await findEntry('test-b', p);
  b.child.kill('SIGTERM');
  assert.equal(await b.exit, 0);
  assert.ok(await until(() => !alive(e.pid), 5000), 'chrome still alive');
  assert.equal(await findEntry('test-b', p), null);
});

test('SIGHUP (terminal pane closed) shuts down the same way', { skip, timeout: 60_000 }, async () => {
  const h = new Wrapper('test-h');
  await h.init();
  assert.ok(!(await h.call('list_pages')).result.isError);
  const e = await findEntry('test-h', p);
  h.child.kill('SIGHUP');
  assert.equal(await h.exit, 0);
  assert.ok(await until(() => !alive(e.pid), 5000), 'chrome still alive');
  assert.equal(await findEntry('test-h', p), null);
});

test('a failed launch answers the tools/call with an error; the next call retries', { skip, timeout: 120_000 }, async () => {
  // A regular file where the profile dir should be makes the launch fail.
  const blocker = join(p.profiles, 'test-c');
  await mkdir(p.profiles, { recursive: true });
  await writeFile(blocker, '');
  const c = new Wrapper('test-c');
  await c.init();
  const r1 = await c.call('list_pages');
  assert.equal(r1.error?.code, -32000, JSON.stringify(r1));
  assert.match(r1.error.message, /^termbrowse: could not start Chrome: /);
  assert.equal(await findEntry('test-c', p), null);
  await rm(blocker);
  const r2 = await c.call('list_pages');
  assert.ok(!r2.error && !r2.result.isError, JSON.stringify(r2));
  assert.ok(text(r2).length > 0);
  const e = await findEntry('test-c', p);
  assert.ok(e && alive(e.pid));
  c.child.stdin.end();
  assert.equal(await c.exit, 0);
  assert.ok(await until(() => !alive(e.pid), 5000));
});

test('lines split across chunks are forwarded in order, after Chrome is up', { skip, timeout: 120_000 }, async () => {
  const d = new Wrapper('test-d');
  await d.init();
  const callReply = new Promise((r) => d.waiters.set(100, r));
  const listReply = new Promise((r) => d.waiters.set(101, (m) => r({ m, entry: findEntry('test-d', p) })));
  const two = `${JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'list_pages', arguments: {} } })}\n`
    + `${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' })}\n`;
  for (let i = 0; i < two.length; i += 7) d.child.stdin.write(two.slice(i, i + 7));
  const r = await callReply;
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  const { m, entry } = await listReply;
  assert.ok(m.result.tools.length > 0);
  // tools/list was held back behind the tools/call, so Chrome was registered before its reply.
  assert.ok(await entry, 'tools/list was answered before Chrome started');
  d.child.stdin.end();
  assert.equal(await d.exit, 0);
});

test('a second wrapper for the same agent shares its Chrome and leaves it running', { skip, timeout: 120_000 }, async () => {
  const e1 = new Wrapper('test-e');
  await e1.init();
  assert.ok(!(await e1.call('list_pages')).result.isError);
  const first = await findEntry('test-e', p);
  const e2 = new Wrapper('test-e');
  await e2.init();
  const r = await e2.call('new_page', { url: 'data:text/html,<title>shared</title>' });
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  assert.equal((await findEntry('test-e', p)).pid, first.pid);
  assert.ok((await listTargets(first.port)).some((t) => t.title === 'shared'));
  e2.child.stdin.end();
  assert.equal(await e2.exit, 0);
  assert.ok(alive(first.pid), 'second wrapper must not close the first one\'s Chrome');
  assert.equal((await findEntry('test-e', p))?.pid, first.pid);
  e1.child.stdin.end();
  assert.equal(await e1.exit, 0);
  assert.ok(await until(() => !alive(first.pid), 5000));
  assert.equal(await findEntry('test-e', p), null);
});

test('an id-less tools/call (a notification) whose launch fails gets no reply', { skip, timeout: 60_000 }, async () => {
  const blocker = join(p.profiles, 'test-n');
  await mkdir(p.profiles, { recursive: true });
  await writeFile(blocker, '');
  const n = new Wrapper('test-n');
  try {
    await n.init();
    const before = n.lines.length;
    n.notify('tools/call', { name: 'list_pages', arguments: {} });
    const list = await n.request('tools/list');
    assert.ok(list.result.tools.length > 0);
    const extra = n.lines.slice(before).filter((m) => m !== list);
    assert.deepEqual(extra, [], 'replied to a notification');
  } finally {
    n.child.stdin.end();
    await n.exit;
    await rm(blocker, { force: true });
  }
});

test('shutdown SIGKILLs a chrome-devtools-mcp that ignores SIGTERM', { timeout: 30_000 }, async () => {
  const { runMcp } = await import('../src/mcp.js');
  const { PassThrough } = await import('node:stream');
  const pidFile = join(tmp, 'stubborn-mcp.pid');
  const script = join(tmp, 'stubborn-mcp.mjs');
  await writeFile(script, `import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
`);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const done = runMcp([], { stdin, stdout, env: { ...env, TERMBROWSE_AGENT: 'test-k' }, mcpBin: script, stopGraceMs: 100, killGraceMs: 300 });
  const pid = Number(await until(() => readFile(pidFile, 'utf8').catch(() => '')));
  stdin.end();
  const t0 = Date.now();
  assert.equal(await done, 0);
  assert.ok(Date.now() - t0 >= 300, 'did not wait for SIGTERM first');
  assert.equal(alive(pid), false);
});
