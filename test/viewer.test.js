import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runViewer, nextEveryNth, keyQuits, followable } from '../src/viewer.js';
import { kittyQuery, leaveScreen, deleteAll } from '../src/kitty.js';
import { startFakeCdp } from './helpers/fake-cdp.js';

const ESC = '\x1b';

// A base64 PNG whose IHDR says width x height (pngSize only reads the header).
function fakePng(width = 1037, height = 1443) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

// Fake terminal: stdout is a TTY PassThrough; stdin answers CSI 16t/14t/DA1 and the Kitty query.
function fakeTerm({ kitty = true } = {}) {
  const size = { cols: 61, rows: 40, pxW: 1037, pxH: 1480 };
  const stdout = new PassThrough();
  stdout.isTTY = true;
  Object.defineProperty(stdout, 'columns', { get: () => size.cols });
  Object.defineProperty(stdout, 'rows', { get: () => size.rows });
  let out = '';
  stdout.on('data', (d) => { out += d; });
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.includes(kittyQuery())) {
      setImmediate(() => stdin.write(kitty ? `${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c` : `${ESC}[?62;c`));
    } else if (s.includes(`${ESC}[16t`)) {
      // cell size, window size, then DA1 as the end marker; split across chunks
      const cellH = Math.round(size.pxH / size.rows);
      const cellW = Math.round(size.pxW / size.cols);
      const reply = `${ESC}[6;${cellH};${cellW}t${ESC}[4;${size.pxH};${size.pxW}t${ESC}[?62;c`;
      setImmediate(() => { stdin.write(reply.slice(0, 5)); setImmediate(() => stdin.write(reply.slice(5))); });
    }
    return write(chunk, ...rest);
  };
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (d) => { err += d; });
  const signals = new EventEmitter();
  return { stdin, stdout, stderr, signals, size, out: () => out, err: () => err };
}

async function until(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const count = (s, sub) => s.split(sub).length - 1;
const methods = (fake, m) => fake.received.filter((x) => x.method === m);

let fake;
afterEach(async () => { await fake?.close(); fake = null; });

function start(t, opts = {}) {
  let controls;
  const p = runViewer({
    port: fake.port,
    stdin: t.stdin,
    stdout: t.stdout,
    stderr: t.stderr,
    signals: t.signals,
    env: {},
    onReady: (c) => { controls = c; },
    ...opts,
  });
  return { p, controls: () => controls };
}

test('refuses non-kitty terminal', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm({ kitty: false });
  const code = await runViewer({ port: fake.port, stdin: t.stdin, stdout: t.stdout, stderr: t.stderr, signals: t.signals, env: {} });
  assert.equal(code, 2);
  assert.equal(t.out(), kittyQuery());
  assert.match(t.err(), /termbrowse: this terminal doesn't support Kitty graphics \(try Kitty, Ghostty, WezTerm or Herdr\)/);
  assert.equal(fake.received.length, 0);
  assert.equal(t.stdin.isRaw, false);
});

test('refuses when stdout is not a TTY, writing nothing to it', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  t.stdout.isTTY = false;
  const code = await runViewer({ port: fake.port, stdin: t.stdin, stdout: t.stdout, stderr: t.stderr, signals: t.signals, env: {} });
  assert.equal(code, 2);
  assert.equal(t.out(), '');
  assert.match(t.err(), /doesn't support Kitty graphics/);
});

test('a known Kitty terminal skips the query', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm({ kitty: false }); // would answer DA1 only
  const { p } = start(t, { env: { HC_TERMINAL_ID: 't9' } });
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  assert.ok(!t.out().includes(kittyQuery()));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('draws frames', async () => {
  fake = await startFakeCdp({
    handlers: {
      'Page.startScreencast': () => {
        setTimeout(() => {
          for (let i = 1; i <= 3; i++) {
            fake.send({ method: 'Page.screencastFrame', params: { data: fakePng(), sessionId: i, metadata: {} } });
          }
        }, 20);
        return {};
      },
    },
  });
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.screencastFrameAck').length === 3 && count(t.out(), 'a=T,f=100') === 3);
  const [sc] = methods(fake, 'Page.startScreencast');
  assert.equal(sc.params.format, 'png');
  assert.equal(sc.params.maxWidth, 1037);
  assert.equal(sc.params.maxHeight, 1443);
  assert.equal(sc.params.everyNthFrame, 1);
  assert.deepEqual(methods(fake, 'Page.screencastFrameAck').map((m) => m.params.sessionId), [1, 2, 3]);
  assert.ok(methods(fake, 'Target.setDiscoverTargets').length === 1);
  assert.match(t.out(), new RegExp(`${ESC}\\[40;1H${ESC}\\[2Khttps://example.com/  \\d+ fps`));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('disconnect restores terminal', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  const dead = fake;
  fake = null;
  await dead.close(); // Chrome gone: sockets drop and /json/version stops answering
  assert.equal(await p, 1);
  assert.ok(t.out().endsWith(leaveScreen()));
  assert.match(t.out(), /disconnected/);
  assert.equal(t.stdin.isRaw, false);
  assert.equal(t.signals.listenerCount('SIGINT'), 0);
});

test('ctrl-c restores terminal', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  t.stdin.write('\x03');
  assert.equal(await p, 0);
  assert.equal(methods(fake, 'Page.stopScreencast').length, 1);
  assert.ok(t.out().endsWith(leaveScreen()));
  assert.equal(t.stdin.isRaw, false);
  assert.equal(t.stdin.listenerCount('data'), 0);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGWINCH']) assert.equal(t.signals.listenerCount(s), 0);
});

test('SIGTERM restores terminal and resolves 0', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  let exitCode;
  const { p } = start(t, { onExit: (c) => { exitCode = c; } });
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
  assert.equal(exitCode, 0);
  assert.ok(t.out().endsWith(leaveScreen()));
});

test('SIGHUP restores terminal and resolves 0', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  t.signals.emit('SIGHUP');
  assert.equal(await p, 0);
  assert.ok(t.out().endsWith(leaveScreen()));
  assert.equal(t.signals.listenerCount('SIGHUP'), 0);
});

test('re-attaches to another tab when the viewed tab closes but Chrome stays up', async () => {
  fake = await startFakeCdpWith([
    { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' },
    { id: 'T2', type: 'page', url: 'https://other.example/', title: 'Other' },
  ]);
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  fake.closeSockets(); // the tab's socket drops; /json/version still answers
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  await until(() => t.out().includes('https://other.example/'));
  assert.doesNotMatch(t.out(), /disconnected/);
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('when a followed popup closes, goes back to its opener', async () => {
  const targets = [
    { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' },
    { id: 'T2', type: 'page', url: 'https://other.example/', title: 'Other' },
  ];
  fake = await startFakeCdpWith(targets);
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  targets.push({ id: 'T3', type: 'page', url: 'https://popup.example/', title: 'Popup', webSocketDebuggerUrl: fake.wsUrl });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3', type: 'page', openerId: 'T1', url: 'https://popup.example/' } } });
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  targets.push(targets.shift()); // opener no longer first, so only the opener rule picks it
  fake.closeSockets();
  await until(() => methods(fake, 'Page.startScreencast').length === 3);
  await until(() => t.out().lastIndexOf('https://example.com/') > t.out().lastIndexOf('https://popup.example/'));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('pauses on bogus size, resumes on a sane one', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p, controls } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  Object.assign(t.size, { cols: 600, rows: 40, pxW: 10200, pxH: 1480 });
  await controls().resize();
  assert.equal(methods(fake, 'Page.stopScreencast').length, 1);
  assert.match(t.out(), /paused/);

  Object.assign(t.size, { cols: 80, rows: 25, pxW: 800, pxH: 500 });
  t.signals.emit('SIGWINCH');
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  const sc = methods(fake, 'Page.startScreencast')[1];
  assert.equal(sc.params.maxWidth, 800);
  assert.equal(sc.params.maxHeight, 480);
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('follows a popup opened by the current page', async () => {
  const targets = [{ id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' }];
  fake = await startFakeCdpWith(targets);
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  targets.push({ id: 'T2', type: 'page', url: 'https://popup.example/', title: 'Popup', webSocketDebuggerUrl: fake.wsUrl });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T9', type: 'service_worker', url: 'x' } } });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', openerId: 'T1', url: 'https://popup.example/' } } });
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  await until(() => t.out().includes('https://popup.example/'));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('follows a new page that has no opener (chrome-devtools-mcp new_page)', async () => {
  const targets = [{ id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' }];
  fake = await startFakeCdpWith(targets);
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  targets.push({ id: 'T2', type: 'page', url: 'https://new.example/', title: 'New', webSocketDebuggerUrl: fake.wsUrl });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', url: 'https://new.example/' } } });
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  await until(() => t.out().includes('https://new.example/'));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('pages that already exist when discovery starts are not followed', async () => {
  const targets = [
    { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' },
    { id: 'T2', type: 'page', url: 'https://old.example/', title: 'Old' },
  ];
  fake = await startFakeCdp({
    targets,
    handlers: {
      // Chrome reports every existing target as created before it answers setDiscoverTargets.
      'Target.setDiscoverTargets': () => {
        for (const x of targets) fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: x.id, type: 'page', url: x.url } } });
        return {};
      },
    },
  });
  for (const x of targets) x.webSocketDebuggerUrl = fake.wsUrl;
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(methods(fake, 'Page.startScreencast').length, 1);
  assert.ok(!t.out().includes('https://old.example/'));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('a stdout error (EIO after the terminal hangs up) while finishing does not crash the viewer', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const write = t.stdout.write;
  t.stdout.write = (chunk, ...rest) => {
    if (String(chunk).includes(leaveScreen())) t.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
    return write(chunk, ...rest);
  };
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  t.signals.emit('SIGHUP');
  assert.equal(await p, 0);
  assert.equal(t.stdout.listenerCount('error'), 0, 'the error handler is removed on finish');
});

// The fake picks its port at listen time, so build the target list from the live port.
async function startFakeCdpWith(targets) {
  const f = await startFakeCdp({ targets });
  for (const x of targets) x.webSocketDebuggerUrl = f.wsUrl;
  return f;
}

test('nextEveryNth throttles heavy fast streams and recovers', () => {
  const heavy = Array.from({ length: 50 }, () => 250_000);
  const light = Array.from({ length: 50 }, () => 50_000);
  assert.equal(nextEveryNth(1, heavy), 2);
  assert.equal(nextEveryNth(1, heavy.slice(0, 44)), 1, 'under 45 fps');
  assert.equal(nextEveryNth(1, Array.from({ length: 50 }, () => 150_000)), 1);
  assert.equal(nextEveryNth(2, Array.from({ length: 25 }, () => 150_000)), 2, 'hysteresis');
  assert.equal(nextEveryNth(2, light.slice(0, 25)), 1);
  assert.equal(nextEveryNth(2, []), 2, 'no frames: no change');
});

const SET = 'Emulation.setDeviceMetricsOverride';
const CLEAR = 'Emulation.clearDeviceMetricsOverride';

test('fill: the page is laid out at the pane image area, again on resize, cleared on exit', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p, controls } = start(t, { fill: true });
  await until(() => methods(fake, 'Page.startScreencast').length === 1 && methods(fake, SET).length === 1);
  assert.deepEqual(methods(fake, SET)[0].params, { width: 1037, height: 1443, deviceScaleFactor: 1, mobile: false });
  Object.assign(t.size, { cols: 80, rows: 25, pxW: 800, pxH: 500 });
  await controls().resize();
  await until(() => methods(fake, SET).length === 2);
  assert.deepEqual(methods(fake, SET)[1].params, { width: 800, height: 480, deviceScaleFactor: 1, mobile: false });
  assert.equal(methods(fake, CLEAR).length, 0);
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(methods(fake, CLEAR).length, 1);
});

test('fill: switching tabs clears the old page and fits the new one', async () => {
  const targets = [{ id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' }];
  fake = await startFakeCdpWith(targets);
  const t = fakeTerm();
  const { p } = start(t, { fill: true });
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, SET).length === 1);
  const oldConn = methods(fake, SET)[0].conn;
  targets.push({ id: 'T2', type: 'page', url: 'https://popup.example/', title: 'Popup', webSocketDebuggerUrl: fake.wsUrl });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', openerId: 'T1', url: 'https://popup.example/' } } });
  await until(() => methods(fake, SET).length === 2 && methods(fake, CLEAR).length === 1);
  assert.equal(methods(fake, CLEAR)[0].conn, oldConn, 'cleared on the page that was fitted');
  assert.notEqual(methods(fake, SET)[1].conn, oldConn, 'fitted on the new page');
  assert.deepEqual(methods(fake, SET)[1].params, { width: 1037, height: 1443, deviceScaleFactor: 1, mobile: false });
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(methods(fake, CLEAR).length, 2);
  assert.equal(methods(fake, CLEAR)[1].conn, methods(fake, SET)[1].conn);
});

test('fill off: the page size is never touched', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p, controls } = start(t, { fill: false });
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  Object.assign(t.size, { cols: 80, rows: 25, pxW: 800, pxH: 500 });
  await controls().resize();
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(methods(fake, SET).length, 0);
  assert.equal(methods(fake, CLEAR).length, 0);
});

test('status says idle, not 0 fps, once frames stop', async () => {
  fake = await startFakeCdp({
    handlers: {
      'Page.startScreencast': () => {
        setTimeout(() => fake.send({ method: 'Page.screencastFrame', params: { data: fakePng(), sessionId: 1, metadata: {} } }), 20);
        return {};
      },
    },
  });
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => count(t.out(), 'a=T,f=100') === 1);
  assert.match(t.out(), /https:\/\/example\.com\/  1 fps/);
  await until(() => /https:\/\/example\.com\/  idle/.test(t.out().slice(t.out().lastIndexOf('a=T,f=100'))), 3000);
  assert.doesNotMatch(t.out(), / 0 fps/);
  t.stdin.write('q');
  assert.equal(await p, 0);
});

// --- resize debounce (no flicker) ---
test('a burst of resizes restarts once and keeps the last frame until a new one draws', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t, { fill: true });
  await until(() => methods(fake, 'Page.startScreencast').length === 1 && methods(fake, SET).length === 1);
  const from = t.out().length;
  Object.assign(t.size, { cols: 80, rows: 25, pxW: 800, pxH: 500 });
  for (let i = 0; i < 10; i++) {
    t.signals.emit('SIGWINCH');
    await new Promise((r) => setTimeout(r, 10));
  }
  const burst = t.out().slice(from);
  assert.ok(!burst.includes(deleteAll()) && !burst.includes(`${ESC}[2J`), 'cleared during the burst');
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(methods(fake, 'Page.startScreencast').length, 2, 'one restart');
  assert.equal(methods(fake, SET).length, 2, 'one re-fit');
  assert.ok(!t.out().slice(from).includes(deleteAll()), 'old frame kept while no new frame has come');
  // The next frame clears and draws in one write.
  fake.send({ method: 'Page.screencastFrame', params: { data: fakePng(800, 480), sessionId: 9, metadata: {} } });
  await until(() => t.out().slice(from).includes('a=T,f=100'));
  const after = t.out().slice(from);
  assert.ok(after.indexOf(deleteAll()) >= 0 && after.indexOf(deleteAll()) < after.indexOf('a=T,f=100'));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

// --- which new tabs are followed ---
test('prerender targets and non-web URLs are not followed; chrome://newtab is', async () => {
  const targets = [{ id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' }];
  fake = await startFakeCdpWith(targets);
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  const skipped = [
    { targetId: 'P1', type: 'page', subtype: 'prerender', url: 'https://example.com/next' },
    { targetId: 'X1', type: 'page', url: 'chrome-extension://abc/popup.html' },
    { targetId: 'D1', type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
    { targetId: 'C1', type: 'page', url: 'chrome://settings/' },
  ];
  for (const info of skipped) {
    targets.push({ id: info.targetId, type: 'page', url: info.url, webSocketDebuggerUrl: fake.wsUrl });
    fake.send({ method: 'Target.targetCreated', params: { targetInfo: info } });
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(methods(fake, 'Page.startScreencast').length, 1, 'followed a tab it should not');
  targets.push({ id: 'N1', type: 'page', url: 'chrome://newtab/', webSocketDebuggerUrl: fake.wsUrl });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'N1', type: 'page', url: 'chrome://newtab/' } } });
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  await until(() => t.out().includes('chrome://newtab/'));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('two tabs created back to back: the viewer ends on the later one', async () => {
  const targets = [{ id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' }];
  // The first new tab's socket is slow to open, so without ordering it would be adopted last.
  fake = await startFakeCdp({ targets, connectDelay: (url) => (url.includes('slow') ? 300 : 0) });
  targets[0].webSocketDebuggerUrl = fake.wsUrl;
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  targets.push({ id: 'T2', type: 'page', url: 'https://first.example/', webSocketDebuggerUrl: `${fake.wsUrl}?slow` });
  targets.push({ id: 'T3', type: 'page', url: 'https://second.example/', webSocketDebuggerUrl: fake.wsUrl });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', url: 'https://first.example/' } } });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T3', type: 'page', url: 'https://second.example/' } } });
  await until(() => t.out().includes('https://second.example/'));
  await new Promise((r) => setTimeout(r, 600)); // the slow one has connected by now
  const out = t.out();
  assert.ok(out.lastIndexOf('https://second.example/') > out.lastIndexOf('https://first.example/'), 'ended on the earlier tab');
  t.stdin.write('q');
  assert.equal(await p, 0);
});

// --- fill override on every way out ---
const lastOverride = (conn) => fake.received.filter((m) => m.conn === conn && (m.method === SET || m.method === CLEAR)).at(-1)?.method;

test('fill: SIGTERM clears the override', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t, { fill: true });
  await until(() => methods(fake, SET).length === 1);
  const conn = methods(fake, SET)[0].conn;
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
  assert.equal(lastOverride(conn), CLEAR);
});

test('fill: re-applied on re-attach after the tab closes, and cleared on exit', async () => {
  fake = await startFakeCdpWith([
    { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' },
    { id: 'T2', type: 'page', url: 'https://other.example/', title: 'Other' },
  ]);
  const t = fakeTerm();
  const { p } = start(t, { fill: true });
  await until(() => methods(fake, SET).length === 1);
  const first = methods(fake, SET)[0].conn;
  fake.closeSockets();
  await until(() => methods(fake, SET).some((m) => m.conn !== first));
  const second = methods(fake, SET).at(-1).conn;
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(lastOverride(second), CLEAR);
});

test('fill: SIGTERM while re-attaching leaves no override behind', async () => {
  let enables = 0;
  const targets = [
    { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' },
    { id: 'T2', type: 'page', url: 'https://other.example/', title: 'Other' },
  ];
  let t;
  fake = await startFakeCdp({
    targets,
    handlers: {
      'Page.enable': async () => {
        if (++enables < 2) return {};
        setImmediate(() => t.signals.emit('SIGTERM')); // quit while the new tab is being set up
        await new Promise((r) => setTimeout(r, 100));
        return {};
      },
      'Page.stopScreencast': () => new Promise((r) => setTimeout(() => r({}), 300)),
    },
  });
  for (const x of targets) x.webSocketDebuggerUrl = fake.wsUrl;
  t = fakeTerm();
  const { p } = start(t, { fill: true });
  await until(() => methods(fake, SET).length === 1);
  const closedTab = methods(fake, SET)[0].conn; // its override went with the tab
  fake.closeSockets();
  assert.equal(await p, 0);
  await new Promise((r) => setTimeout(r, 200));
  const conns = new Set(fake.received.map((m) => m.conn).filter((c) => c !== closedTab));
  assert.ok(conns.size > 0);
  for (const c of conns) assert.notEqual(lastOverride(c), SET, `override left on connection ${c}`);
});

test('fill: Chrome going away (exit 1) with fill on still restores the terminal', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t, { fill: true });
  await until(() => methods(fake, SET).length === 1);
  const dead = fake;
  fake = null;
  await dead.close();
  assert.equal(await p, 1);
  assert.ok(t.out().endsWith(leaveScreen()));
  assert.equal(t.stdin.isRaw, false);
});

// --- keys and finishing ---
test('q in the same chunk as a terminal reply still quits; an arrow key alone does not', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  let done = false;
  p.then(() => { done = true; });
  t.stdin.write(`${ESC}[A`);
  t.stdin.write(`${ESC}_Gi=31;OK${ESC}\\`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(done, false, 'an escape sequence alone quit');
  t.stdin.write(`${ESC}[?62;cq`);
  assert.equal(await p, 0);
});

test('quitting during a resize waits for it, so raw mode is restored as it was', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p, controls } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  const write = t.stdout.write;
  t.stdout.write = (chunk, ...rest) => {
    if (!String(chunk).includes(`${ESC}[16t`)) return write(chunk, ...rest);
    // A size query the terminal is slow to answer: quit while it is pending.
    setImmediate(() => t.signals.emit('SIGTERM'));
    return true;
  };
  controls().resize();
  assert.equal(await p, 0);
  await new Promise((r) => setTimeout(r, 1000)); // past the query's own timeout
  assert.equal(t.stdin.isRaw, false);
});

test('keyQuits ignores q inside escape sequences only', () => {
  assert.equal(keyQuits('q'), true);
  assert.equal(keyQuits('\x03'), true);
  assert.equal(keyQuits(`${ESC}[A`), false);
  assert.equal(keyQuits(`${ESC}[?62;c`), false);
  assert.equal(keyQuits(`${ESC}_Gi=31;OK${ESC}\\`), false);
  assert.equal(keyQuits(`${ESC}]11;rgb:qqqq/0000/0000${ESC}\\`), false);
  assert.equal(keyQuits(`${ESC}[?62;cq`), true);
  assert.equal(keyQuits(`q${ESC}[6;24;12t`), true);
});

test('followable: web pages and the new-tab page, not prerenders, extensions or DevTools', () => {
  assert.equal(followable({ type: 'page', url: 'https://a.example/' }), true);
  assert.equal(followable({ type: 'page', url: 'about:blank' }), true);
  assert.equal(followable({ type: 'page', url: 'chrome://newtab/' }), true);
  assert.equal(followable({ type: 'page', subtype: 'prerender', url: 'https://a.example/' }), false);
  assert.equal(followable({ type: 'page', url: 'chrome://settings/' }), false);
  assert.equal(followable({ type: 'page', url: 'chrome-extension://x/p.html' }), false);
  assert.equal(followable({ type: 'page', url: 'devtools://devtools/x' }), false);
  assert.equal(followable({ type: 'service_worker', url: 'https://a.example/sw.js' }), false);
});
