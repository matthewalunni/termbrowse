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
import { takeControl, releaseControl, readControl, controlPath } from '../src/control.js';
import { takeoverNote, appendNote } from '../src/mcp.js';

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

test('backgroundNewPages: new_page without background gets background: true', async () => {
  const { backgroundNewPages } = await import('../src/mcp.js');
  const call = (name, args) => `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`;
  const out = JSON.parse(backgroundNewPages(call('new_page', { url: 'https://example.com' })));
  assert.deepEqual(out.params.arguments, { url: 'https://example.com', background: true });
  assert.ok(backgroundNewPages(call('new_page', { url: 'x' })).endsWith('\n'));
  assert.equal(JSON.parse(backgroundNewPages(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'new_page' } })}\n`)).params.arguments.background, true);
  // explicit values are kept, other tools and messages are byte-identical
  for (const line of [
    call('new_page', { url: 'x', background: false }),
    call('new_page', { url: 'x', background: true }),
    call('navigate_page', { url: 'x' }),
    call('select_page', { pageId: 1 }),
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    '{ "jsonrpc": "2.0",  "method":"notifications/initialized" }\n',
    'not json\n',
    '\n',
    'null\n',
  ]) {
    assert.equal(backgroundNewPages(line), line);
  }
  // a batch: only the new_page entry changes
  const batch = JSON.parse(backgroundNewPages(`${JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'new_page', arguments: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_pages', arguments: {} } },
  ])}\n`));
  assert.equal(batch[0].params.arguments.background, true);
  assert.deepEqual(batch[1].params.arguments, {});
});

const NOTE = /^Note from termbrowse: the user took control of this browser for /;
const notes = (r) => (r.result?.content ?? []).filter((c) => c.type === 'text' && NOTE.test(c.text)).map((c) => c.text);
const WAIT_ERROR = { code: -32000, message: 'termbrowse: the user has control of the browser; try again later' };

test('takeoverNote: appends the tab-change sentence only when tabsChanged', () => {
  const base = takeoverNote({ durationMs: 40000, waited: true, url: 'https://x/' });
  const t = takeoverNote({ durationMs: 40000, waited: true, url: 'https://x/', tabsChanged: true });
  assert.equal(t, `${base} The user changed tabs; call list_pages and select_page before continuing.`);
  assert.equal(takeoverNote({ durationMs: 40000, waited: true, url: 'https://x/', tabsChanged: false }), base);
});

test('takeoverNote: exact text, seconds and minutes', () => {
  assert.equal(
    takeoverNote({ durationMs: 40000, waited: true, url: 'https://x/' }),
    'Note from termbrowse: the user took control of this browser for 40 s (while you waited). The page may have changed; it is now at https://x/. Re-check the page (e.g. take a snapshot) before continuing.',
  );
  assert.equal(
    takeoverNote({ durationMs: 180000, waited: false, url: 'https://y/' }),
    'Note from termbrowse: the user took control of this browser for 3 min (since your last action). The page may have changed; it is now at https://y/. Re-check the page (e.g. take a snapshot) before continuing.',
  );
  assert.match(takeoverNote({ durationMs: 200, waited: false, url: 'u' }), / for 1 s /);
  assert.match(takeoverNote({ durationMs: 59400, waited: false, url: 'u' }), / for 59 s /);
  assert.match(takeoverNote({ durationMs: 90000, waited: false, url: 'u' }), / for 1 min 30 s /);
  assert.match(takeoverNote({ durationMs: 120000, waited: false, url: 'u' }), / for 2 min /);
  assert.match(takeoverNote({ durationMs: 754000, waited: false, url: 'u' }), / for 13 min /);
});

test('takeoverNote: says how long the call waited, when known', () => {
  assert.match(takeoverNote({ durationMs: 40000, waited: true, waitedMs: 31000, url: 'u' }), / for 40 s \(while you waited, 31 s\)\. The page/);
  assert.match(takeoverNote({ durationMs: 40000, waited: true, waitedMs: 0, url: 'u' }), / for 40 s \(while you waited\)\. The page/);
});

test('takeoverNote: an idle return counts the whole hold and says when the last input was', () => {
  // The step 8 case: 4 s of input, then idle_return (5 min) with no input.
  assert.equal(
    takeoverNote({ durationMs: 304000, waited: true, waitedMs: 290000, url: 'https://x/', how: 'idle', activeMs: 4000 }),
    'Note from termbrowse: the user took control of this browser for 5 min 4 s (while you waited, 4 min 50 s).'
      + ' Their last input was 4 s in; control came back automatically after 5 min with no input.'
      + ' The page may have changed; it is now at https://x/. Re-check the page (e.g. take a snapshot) before continuing.',
  );
  assert.match(
    takeoverNote({ durationMs: 7000, waited: false, url: 'u', how: 'viewer-gone', activeMs: 7000 }),
    / for 7 s \(since your last action\)\. Their viewer closed without handing back; their last input was 7 s in\. The page/,
  );
});

test('appendNote: one text item on a result; error.data.note on an error', () => {
  const ok = JSON.parse(appendNote(`${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'a' }] } })}\n`, 'N'));
  assert.deepEqual(ok.result.content, [{ type: 'text', text: 'a' }, { type: 'text', text: 'N' }]);
  assert.ok(appendNote(`${JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} })}\n`, 'N').endsWith('\n'));
  assert.deepEqual(JSON.parse(appendNote(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }), 'N')).result.content, [{ type: 'text', text: 'N' }]);
  const tool = JSON.parse(appendNote(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { isError: true, content: [] } }), 'N'));
  assert.deepEqual(tool.result, { isError: true, content: [{ type: 'text', text: 'N' }] });
  const err = JSON.parse(appendNote(JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'm', data: { x: 1 } } }), 'N'));
  assert.deepEqual(err.error, { code: 1, message: 'm', data: { x: 1, note: 'N' } });
  assert.deepEqual(JSON.parse(appendNote(JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'm' } }), 'N')).error.data, { note: 'N' });
  assert.equal(appendNote('not json\n', 'N'), 'not json\n');
});

// The viewer's side of a takeover, from this (live) test process.
const take = (agent, url = 'https://x/') => takeControl(agent, { viewerPid: process.pid, url, idleReturnMs: 60_000 }, p);
// The page the agent is on now: what the note names.
const pageUrl = async (agent) => (await listTargets((await findEntry(agent, p)).port)).find((t) => t.type === 'page').url;
const noReplyFor = async (w, id, ms) => { await sleep(ms); return !w.lines.some((m) => m.id === id); };

test('a tools/call waits while the user holds control; pings pass; the note comes after release', { skip, timeout: 120_000 }, async () => {
  const w = new Wrapper('test-w');
  await w.init();
  const first = await w.call('list_pages');
  assert.ok(!first.error && !first.result.isError, JSON.stringify(first));
  assert.deepEqual(notes(first), []);
  await take('test-w');
  let got = null;
  const held = w.call('list_pages').then((r) => (got = r));
  await sleep(1000);
  assert.equal(got, null, 'a held call was answered');
  const ping = await w.request('ping', undefined, 5000);
  assert.deepEqual(ping.result, {});
  assert.equal(got, null);
  await releaseControl('test-w', { url: 'https://x/after' }, p);
  const t0 = Date.now();
  const r = await held;
  assert.ok(Date.now() - t0 < 1500, 'release was not noticed promptly');
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  const n = notes(r);
  assert.equal(n.length, 1, JSON.stringify(r));
  const here = await pageUrl('test-w');
  assert.notEqual(here, 'https://x/after');
  assert.match(n[0], /^Note from termbrowse: the user took control of this browser for [12] s \(while you waited, [12] s\)\. The page may have changed; it is now at /);
  assert.ok(n[0].endsWith(`it is now at ${here}. Re-check the page (e.g. take a snapshot) before continuing.`), n[0]);
  assert.deepEqual(notes(await w.call('list_pages')), [], 'a takeover is reported once');
  w.child.stdin.end();
  assert.equal(await w.exit, 0);
  await assert.rejects(stat(controlPath('test-w', p)), 'control file removed with the registry entry');
});

test('stale control from a dead viewer pid does not block', { skip, timeout: 120_000 }, async () => {
  const w = new Wrapper('test-s');
  await w.init();
  assert.ok(!(await w.call('list_pages')).result.isError);
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.once('exit', r));
  const now = Date.now();
  await mkdir(join(p.state, 'control'), { recursive: true });
  await writeFile(controlPath('test-s', p), JSON.stringify({
    holder: 'user', viewerPid: dead.pid, url: 'https://dead/', idleReturnMs: 60_000,
    since: now - 5000, lastInput: now - 1000, takeovers: 1, lastTakeover: null, agentBusySince: null,
  }));
  const t0 = Date.now();
  const r = await w.call('list_pages');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  const n = notes(r);
  assert.equal(n.length, 1, JSON.stringify(r));
  assert.match(n[0], / for 4 s \(since your last action\)\. /);
  assert.ok(n[0].includes(`now at ${await pageUrl('test-s')}. `), n[0]);
  w.child.stdin.end();
  assert.equal(await w.exit, 0);
});

test('a takeover with no call pending is reported on the next result, once; an old one never', { skip, timeout: 120_000 }, async () => {
  // A takeover from before this wrapper started is not news to a fresh agent.
  await mkdir(join(p.state, 'control'), { recursive: true });
  await writeFile(controlPath('test-t', p), JSON.stringify({
    holder: null, takeovers: 3, lastTakeover: { since: 1000, until: 61000, url: 'https://old/' }, agentBusySince: null,
  }));
  const w = new Wrapper('test-t');
  await w.init();
  const first = await w.call('list_pages');
  assert.ok(!first.error && !first.result.isError, JSON.stringify(first));
  assert.deepEqual(notes(first), []);
  await take('test-t', 'https://y/');
  await sleep(200);
  await releaseControl('test-t', { url: 'https://y/' }, p);
  const r = await w.call('list_pages');
  const n = notes(r);
  assert.equal(n.length, 1, JSON.stringify(r));
  assert.match(n[0], / for 1 s \(since your last action\)\. /);
  assert.ok(n[0].includes(`now at ${await pageUrl('test-t')}. `), n[0]);
  assert.deepEqual(notes(await w.call('list_pages')), []);
  w.child.stdin.end();
  assert.equal(await w.exit, 0);
});

test('a held call that is cancelled is never forwarded; later calls work', { skip, timeout: 120_000 }, async () => {
  const w = new Wrapper('test-x');
  await w.init();
  assert.ok(!(await w.call('list_pages')).result.isError);
  await take('test-x');
  w.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'tools/call', params: { name: 'new_page', arguments: { url: 'data:text/html,<title>cancelled</title>' } } })}\n`);
  await sleep(300);
  w.notify('notifications/cancelled', { requestId: 500, reason: 'test' });
  assert.deepEqual((await w.request('ping', undefined, 5000)).result, {});
  await releaseControl('test-x', { url: 'https://x/' }, p);
  const r = await w.call('list_pages');
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  assert.ok(!text(r).includes('cancelled'), 'the cancelled new_page ran');
  assert.ok(await noReplyFor(w, 500, 500), 'the cancelled call got a reply');
  const e = await findEntry('test-x', p);
  assert.ok(!(await listTargets(e.port)).some((t) => t.title === 'cancelled'));
  w.child.stdin.end();
  assert.equal(await w.exit, 0);
});

test('a call held longer than max_wait gets the wait error and is dropped', { skip, timeout: 60_000 }, async () => {
  const cfgFile = join(tmp, 'maxwait.toml');
  await writeFile(cfgFile, '[chrome]\nheadless = true\n\n[control]\nmax_wait = "300ms"\n');
  await take('test-m');
  const w = new Wrapper('test-m', { TERMBROWSE_CONFIG: cfgFile });
  try {
    await w.init();
    const t0 = Date.now();
    const r = await w.call('list_pages');
    assert.ok(Date.now() - t0 >= 300, `answered after ${Date.now() - t0} ms`);
    assert.deepEqual(r.error, WAIT_ERROR);
    assert.equal(await findEntry('test-m', p), null, 'the dropped call started Chrome');
  } finally {
    await releaseControl('test-m', {}, p);
    w.child.stdin.end();
    await w.exit;
  }
});

test('agentBusySince is set while a call is in flight and cleared by its response', { skip, timeout: 120_000 }, async () => {
  const w = new Wrapper('test-y');
  await w.init();
  const pages = await w.call('list_pages');
  assert.ok(!pages.result.isError);
  const pageId = Number(/^(\d+):/m.exec(text(pages))?.[1]);
  assert.ok(pageId, text(pages));
  assert.equal((await readControl('test-y', p)).agentBusySince, null);
  const slow = w.call('evaluate_script', { pageId, function: '() => new Promise((r) => setTimeout(() => r(1), 1500))' });
  assert.ok(await until(async () => typeof (await readControl('test-y', p)).agentBusySince === 'number', 3000), 'never busy');
  const r = await slow;
  assert.ok(!r.error && !r.result.isError, JSON.stringify(r));
  assert.match(text(r), /\b1\b/);
  assert.equal((await readControl('test-y', p)).agentBusySince, null);
  w.child.stdin.end();
  assert.equal(await w.exit, 0);
});

test('cancelling an in-flight call clears agentBusySince', { skip, timeout: 120_000 }, async () => {
  const w = new Wrapper('test-z');
  await w.init();
  const pages = await w.call('list_pages');
  const pageId = Number(/^(\d+):/m.exec(text(pages))?.[1]);
  assert.ok(pageId, text(pages));
  w.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 700, method: 'tools/call', params: { name: 'evaluate_script', arguments: { pageId, function: '() => new Promise((r) => setTimeout(() => r(1), 3000))' } } })}\n`);
  assert.ok(await until(async () => typeof (await readControl('test-z', p)).agentBusySince === 'number', 3000), 'never busy');
  w.notify('notifications/cancelled', { requestId: 700, reason: 'client timeout' });
  assert.ok(await until(async () => (await readControl('test-z', p)).agentBusySince === null, 2000), 'still busy after the cancel');
  // the next call sets and clears it again
  const slow = w.call('evaluate_script', { pageId, function: '() => new Promise((r) => setTimeout(() => r(2), 1500))' });
  assert.ok(await until(async () => typeof (await readControl('test-z', p)).agentBusySince === 'number', 3000), 'not busy for the next call');
  assert.ok(!(await slow).result.isError);
  assert.equal((await readControl('test-z', p)).agentBusySince, null);
  w.child.stdin.end();
  assert.equal(await w.exit, 0);
});

// In-process wrapper against a stub chrome-devtools-mcp that answers every request with "ok",
// with the agent's "Chrome" already in the registry (so none is launched) on `port`. body(call)
// runs the test; the wrapper is always shut down after it, pass or fail.
async function withStub(agent, port, control, body) {
  const { runMcp } = await import('../src/mcp.js');
  const { PassThrough } = await import('node:stream');
  const { upsertEntry, removeEntry } = await import('../src/registry.js');
  const script = join(tmp, 'echo-mcp.mjs');
  await writeFile(script, `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
});
`);
  const stand = spawn('sleep', ['60'], { stdio: 'ignore' }); // a live pid for the registry entry
  await upsertEntry({ agentId: agent, pid: stand.pid, port, profileDir: '/x', kind: 'agent' }, p);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let buf = '';
  stdout.on('data', (d) => { buf += d; });
  const done = runMcp([], { stdin, stdout, env: { ...env, TERMBROWSE_AGENT: agent }, mcpBin: script, stopGraceMs: 100, killGraceMs: 300, control });
  const call = async (id) => {
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'list_pages', arguments: {} } })}\n`);
    const line = await until(() => buf.split('\n').find((l) => l && JSON.parse(l).id === id), 5000);
    assert.ok(line, `no reply to ${id}`);
    return JSON.parse(line);
  };
  try {
    await body(call);
  } finally {
    stdin.end();
    const code = await done;
    stand.kill();
    await removeEntry(agent, p);
    assert.equal(code, 0);
  }
}

test('a control file that cannot be read counts as released: the call goes through at once', { timeout: 30_000 }, async () => {
  const failing = { readControl: async () => { throw new Error('registry lock busy'); }, setAgentBusy: async () => {} };
  const { freePort } = await import('../src/chrome.js');
  await withStub('test-rf', await freePort(), failing, async (call) => {
    const t0 = Date.now();
    const r = await call(1);
    assert.ok(Date.now() - t0 < 1000, `waited ${Date.now() - t0} ms`);
    assert.deepEqual(r.result.content, [{ type: 'text', text: 'ok' }]);
  });
});

test('the note gives the page the agent is on now, else where the user left it', { timeout: 30_000 }, async () => {
  const { startFakeCdp } = await import('./helpers/fake-cdp.js');
  const { freePort } = await import('../src/chrome.js');
  // Baseline read: no takeovers; every later read: one, ended, left at https://left/.
  const fakeControl = () => {
    let reads = 0;
    return {
      readControl: async () => (reads++ === 0
        ? { held: false, takeovers: 0, lastTakeover: null, agentBusySince: null }
        : { held: false, takeovers: 1, lastTakeover: { since: 0, until: 5000, url: 'https://left/' }, agentBusySince: null }),
      setAgentBusy: async () => {},
    };
  };
  const fake = await startFakeCdp(); // lists https://example.com/
  try {
    await withStub('test-nu', fake.port, fakeControl(), async (call) => {
      const n = notes(await call(1));
      assert.equal(n.length, 1);
      assert.match(n[0], /it is now at https:\/\/example\.com\/\. /);
    });
  } finally {
    await fake.close();
  }
  await withStub('test-nu2', await freePort(), fakeControl(), async (call) => { // nothing answers /json/list
    const n = notes(await call(1));
    assert.equal(n.length, 1);
    assert.match(n[0], /it is now at https:\/\/left\/\. /);
  });
});

test('a takeover whose control record has tabsChanged carries the tab-change sentence', { timeout: 30_000 }, async () => {
  const { freePort } = await import('../src/chrome.js');
  const fakeControl = (tabsChanged) => {
    let reads = 0;
    return {
      readControl: async () => (reads++ === 0
        ? { held: false, takeovers: 0, lastTakeover: null, agentBusySince: null }
        : { held: false, takeovers: 1, lastTakeover: { since: 0, until: 5000, url: 'https://left/', tabsChanged }, agentBusySince: null }),
      setAgentBusy: async () => {},
    };
  };
  await withStub('test-tc', await freePort(), fakeControl(true), async (call) => {
    const n = notes(await call(1));
    assert.equal(n.length, 1);
    assert.ok(n[0].endsWith(' The user changed tabs; call list_pages and select_page before continuing.'), n[0]);
  });
  await withStub('test-tc2', await freePort(), fakeControl(false), async (call) => {
    const n = notes(await call(1));
    assert.equal(n.length, 1);
    assert.ok(!n[0].includes('changed tabs'), n[0]);
  });
});

test('two takeovers between agent calls: a tab change in the first is still reported', { timeout: 30_000 }, async () => {
  const { freePort } = await import('../src/chrome.js');
  let reads = 0;
  const fake = {
    readControl: async () => (reads++ === 0
      ? { held: false, takeovers: 0, lastTakeover: null, agentBusySince: null, tabsChangedAt: 0 }
      : { held: false, takeovers: 2, lastTakeover: { since: 0, until: 5000, url: 'https://left/', tabsChanged: false }, agentBusySince: null, tabsChangedAt: 1 }),
    setAgentBusy: async () => {},
  };
  await withStub('test-tc3', await freePort(), fake, async (call) => {
    const n = notes(await call(1));
    assert.equal(n.length, 1);
    assert.ok(n[0].endsWith(' The user changed tabs; call list_pages and select_page before continuing.'), n[0]);
  });
});
