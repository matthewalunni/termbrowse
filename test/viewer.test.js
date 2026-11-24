import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runViewer, nextEveryNth, keyQuits, followable, escFlushMs, MODES_OFF } from '../src/viewer.js';
import { kittyQuery, leaveScreen, deleteAll } from '../src/kitty.js';
import { startFakeCdp } from './helpers/fake-cdp.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cellToPage, fit } from '../src/layout.js';
import { paths } from '../src/paths.js';
import { parseKeySpec } from '../src/config.js';
import { controlPath, readControl, setAgentBusy } from '../src/control.js';

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
  // Tab discovery starts on its own connection, independent of the frames: wait for it.
  await until(() => methods(fake, 'Target.setDiscoverTargets').length >= 1);
  assert.equal(methods(fake, 'Target.setDiscoverTargets').length, 1);
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

test('fill on a large HiDPI pane: page has the image area aspect, image covers the whole area, clicks land inside', async () => {
  // Like Chrome: frames come at the screencast's max size, metadata reports the emulated CSS size.
  let set = null;
  fake = await startFakeCdp({
    handlers: {
      [SET]: (params) => { set = params; return {}; },
      'Page.startScreencast': (params) => {
        setTimeout(() => fake.send({ method: 'Page.screencastFrame', params: {
          data: fakePng(params.maxWidth, params.maxHeight), sessionId: 1,
          metadata: { deviceWidth: set?.width, deviceHeight: set?.height },
        } }), 10);
        return {};
      },
    },
  });
  const t = fakeTerm();
  Object.assign(t.size, { cols: 136, rows: 40, pxW: 136 * 18, pxH: 40 * 37 }); // area 2448 x 1443
  const { p } = start(t, { fill: true, interactive: true });
  await until(() => count(t.out(), 'a=T,f=100') === 1);
  const { width, height, deviceScaleFactor } = methods(fake, SET)[0].params;
  assert.equal(deviceScaleFactor, 1);
  assert.ok(width <= 2000 && height <= 1600, `${width}x${height}`);
  assert.ok(Math.abs(width / height / (2448 / 1443) - 1) < 0.01, `aspect ${width / height}`);
  const [sc] = methods(fake, 'Page.startScreencast');
  assert.deepEqual([sc.params.maxWidth, sc.params.maxHeight], [width, height]);
  assert.match(t.out(), /a=T,f=100,i=\d,p=1,c=136,r=39,/);
  click(t, 136, 39); // bottom-right image cell
  await until(() => mouse().length === 2);
  const [down] = mouse();
  assert.ok(down.x > width - width / 136 && down.x < width, `x ${down.x} of ${width}`);
  assert.ok(down.y > height - height / 39 && down.y < height, `y ${down.y} of ${height}`);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
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
test('interactive: q in the same chunk as a terminal reply still quits before any input', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  let done = false;
  p.then(() => { done = true; });
  t.stdin.write(`${ESC}_Gi=31;OK${ESC}\\`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(done, false, 'a reply alone quit');
  t.stdin.write(`${ESC}[?62;cq`);
  assert.equal(await p, 0);
});

test('watch only: q in the same chunk as a terminal reply still quits; an arrow key alone does not', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t, { interactive: false });
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
  assert.equal(followable({ type: 'page', url: 'chrome://newtab' }), true);
  assert.equal(followable({ type: 'page', url: 'chrome://new-tab-page/' }), true);
  assert.equal(followable({ type: 'page', url: 'chrome://newtab-footer/' }), false);
  assert.equal(followable({ type: 'page', url: 'chrome://new-tab-page-third-party/' }), false);
  assert.equal(followable({ type: 'page', subtype: 'prerender', url: 'https://a.example/' }), false);
  assert.equal(followable({ type: 'page', url: 'chrome://settings/' }), false);
  assert.equal(followable({ type: 'page', url: 'chrome-extension://x/p.html' }), false);
  assert.equal(followable({ type: 'page', url: 'devtools://devtools/x' }), false);
  assert.equal(followable({ type: 'service_worker', url: 'https://a.example/sw.js' }), false);
});

test('quitting leaves no viewer timers running', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  await new Promise((r) => setTimeout(r, 20)); // let until()'s own timer finish
  const before = timers(); // ref'd timers only (the status ticker is unref'd)
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.ok(timers() <= before, `a timer outlives the viewer: ${before} before quit, ${timers()} after`);
});

// --- double buffering: alternate image ids so the old frame stays up until the new one is placed ---
test('frames alternate image ids 1,2,1; the new image is placed before the previous one is deleted', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  const writes = [];
  const realWrite = t.stdout.write;
  t.stdout.write = (chunk, ...rest) => { writes.push(String(chunk)); return realWrite(chunk, ...rest); };
  for (let i = 1; i <= 3; i++) {
    fake.send({ method: 'Page.screencastFrame', params: { data: fakePng(), sessionId: i, metadata: {} } });
    await until(() => writes.filter((w) => w.includes('a=T,f=100')).length === i);
  }
  const frames = writes.filter((w) => w.includes('a=T,f=100'));
  assert.deepEqual(frames.map((w) => /a=T,f=100,i=(\d),p=1/.exec(w)[1]), ['1', '2', '1']);
  assert.ok(!frames[0].includes('a=d'), 'first frame deletes nothing');
  assert.ok(!frames[0].includes(deleteAll()));
  for (const [i, prev] of [[1, 1], [2, 2]]) {
    const w = frames[i];
    assert.ok(w.indexOf('a=T,f=100') < w.indexOf(`a=d,d=I,i=${prev}`), `frame ${i + 1} deletes image ${prev} after placing`);
    assert.equal(count(w, 'a=d'), 1);
    assert.ok(w.indexOf(`a=d,d=I,i=${prev}`) < w.indexOf(`${ESC}[40;1H`), 'status row still last');
    assert.ok(w.endsWith(w.slice(w.indexOf(`${ESC}[40;1H`))) && /\x1b\[40;1H\x1b\[2K.* fps · Ctrl-] q quit$/.test(w));
  }
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.ok(t.out().endsWith(leaveScreen()) && leaveScreen().includes(deleteAll()), 'exit clears every image');
});

test('after a resize repaint everything is cleared and the next frame starts clean', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  const send = (id) => fake.send({ method: 'Page.screencastFrame', params: { data: fakePng(), sessionId: id, metadata: {} } });
  send(1);
  await until(() => count(t.out(), 'a=T,f=100') === 1);
  Object.assign(t.size, { cols: 80, rows: 25, pxW: 800, pxH: 500 });
  t.signals.emit('SIGWINCH');
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  const from = t.out().length;
  send(2);
  await until(() => t.out().slice(from).includes('a=T,f=100'));
  const w = t.out().slice(from);
  assert.ok(w.indexOf(deleteAll()) < w.indexOf('a=T,f=100'), 'repaint clears all first');
  assert.ok(!w.includes('a=d,d=I'), 'no per-image delete right after a full clear');
  t.stdin.write('q');
  assert.equal(await p, 0);
});

// --- interactive input: mouse, keys, paste, reserved keys, control of agent browsers ---
const W = 1037; // CSS viewport the fake frames report (metadata.deviceWidth/Height)
const H = 1443;

// A fake CDP whose screencast sends one frame of png size w x h, so the viewer has an image placed.
async function startDrawing(w = 1037, h = 1443) {
  const f = await startFakeCdp({
    handlers: {
      'Page.startScreencast': () => {
        setTimeout(() => f.send({ method: 'Page.screencastFrame', params: { data: fakePng(w, h), sessionId: 1, metadata: { deviceWidth: W, deviceHeight: H } } }), 10);
        return {};
      },
    },
  });
  return f;
}

async function tmpHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tb-view-'));
}

async function startInteractive(opts = {}, png = [1037, 1443]) {
  fake = await startDrawing(...png);
  const t = fakeTerm();
  const v = start(t, opts);
  await until(() => count(t.out(), 'a=T,f=100') === 1);
  return { t, ...v };
}

const expectAt = (t, col, row, png = [1037, 1443]) =>
  cellToPage(col, row, fit({ width: png[0], height: png[1] }, t.size), t.size, { width: W, height: H });
const mouse = () => methods(fake, 'Input.dispatchMouseEvent').map((m) => m.params);
const keyDowns = () => methods(fake, 'Input.dispatchKeyEvent').map((m) => m.params).filter((k) => k.type !== 'keyUp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (t, col, row, b = 0) => t.stdin.write(`${ESC}[<${b};${col};${row}M${ESC}[<${b};${col};${row}m`);
const agentOpts = (home, extra = {}) => ({
  env: { HOME: home }, control: { agentId: 'ag1', idleReturnMs: 300_000, ...extra },
});
const MODES_ON = `${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h${ESC}[>29u`;

test('interactive: enables mouse, paste and Kitty keyboard on start and restores them on q', async () => {
  const { t, p } = await startInteractive();
  assert.ok(t.out().includes(MODES_ON));
  t.stdin.write('q');
  assert.equal(await p, 0);
  const tail = t.out().slice(t.out().lastIndexOf(MODES_ON));
  assert.ok(t.out().includes(`${ESC}[?1004h`), 'focus reporting on');
  for (const off of [`${ESC}[<u`, `${ESC}[?1003l`, `${ESC}[?1006l`, `${ESC}[?2004l`, `${ESC}[?1004l`]) assert.ok(tail.includes(off), `missing ${JSON.stringify(off)}`);
  assert.ok(tail.indexOf(`${ESC}[<u`) < tail.indexOf(`${ESC}[?1049l`), 'Kitty keyboard popped before leaving the alternate screen');
  assert.ok(t.out().endsWith(leaveScreen()));
});

test('interactive: a click goes to the page at the cell centre', async () => {
  const { t, p } = await startInteractive();
  click(t, 10, 5);
  await until(() => mouse().length === 2);
  const [down, up] = mouse();
  const at = expectAt(t, 10, 5);
  assert.deepEqual([down.type, up.type], ['mousePressed', 'mouseReleased']);
  for (const m of [down, up]) {
    assert.equal(m.x, at.x);
    assert.equal(m.y, at.y);
    assert.equal(m.button, 'left');
    assert.equal(m.clickCount, 1);
  }
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: two clicks within 400 ms make a double click', async () => {
  const { t, p } = await startInteractive();
  click(t, 10, 5);
  await sleep(50);
  click(t, 10, 5);
  await until(() => mouse().length === 4);
  assert.deepEqual(mouse().map((m) => m.clickCount), [1, 1, 2, 2]);
  await sleep(450);
  click(t, 10, 5);
  await until(() => mouse().length === 6);
  assert.equal(mouse()[4].clickCount, 1, 'a click after 400 ms starts over');
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: click outside image ignored (status row, letterbox) and takes no control', async () => {
  const home = await tmpHome();
  const png = [500, 1443]; // narrow page: letterboxed on the right
  const { t, p } = await startInteractive(agentOpts(home), png);
  const place = fit({ width: png[0], height: png[1] }, t.size);
  click(t, 10, t.size.rows); // status row
  click(t, place.cols + 5, 5); // right of the image
  t.stdin.write(`${ESC}[<65;${place.cols + 5};5M`); // wheel there too
  await sleep(150);
  assert.equal(mouse().length, 0);
  await assert.rejects(fs.access(controlPath('ag1', paths({ HOME: home }))));
  t.stdin.write('q'); // still before the first input
  assert.equal(await p, 0);
});

test('interactive: wheel down scrolls 100 px; shift-wheel scrolls sideways', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write(`${ESC}[<65;10;5M`);
  t.stdin.write(`${ESC}[<69;10;5M`); // shift + wheel down
  await until(() => mouse().length === 2);
  const [w, s] = mouse();
  assert.equal(w.type, 'mouseWheel');
  assert.equal(w.deltaY, 100);
  assert.equal(w.deltaX, 0);
  assert.equal(w.x, expectAt(t, 10, 5).x);
  assert.equal(s.deltaX, 100);
  assert.equal(s.deltaY, 0);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: typed string arrives in order', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write('abc');
  await until(() => keyDowns().length === 3);
  assert.deepEqual(keyDowns().map((k) => [k.type, k.key, k.text]), [['keyDown', 'a', 'a'], ['keyDown', 'b', 'b'], ['keyDown', 'c', 'c']]);
  const all = methods(fake, 'Input.dispatchKeyEvent').map((m) => `${m.params.type}:${m.params.key}`);
  assert.deepEqual(all, ['keyDown:a', 'keyUp:a', 'keyDown:b', 'keyUp:b', 'keyDown:c', 'keyUp:c']);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: paste and non-ASCII text are inserted as text', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write(`${ESC}[200~hello\nworld${ESC}[201~`);
  t.stdin.write('é');
  await until(() => methods(fake, 'Input.insertText').length === 2);
  assert.deepEqual(methods(fake, 'Input.insertText').map((m) => m.params.text), ['hello\nworld', 'é']);
  assert.equal(methods(fake, 'Input.dispatchKeyEvent').length, 0);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: before any input Ctrl-C quits', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write('\x03');
  assert.equal(await p, 0);
  assert.equal(methods(fake, 'Input.dispatchKeyEvent').length, 0);
});

test('interactive: after a click, q goes to the page and the viewer keeps running', async () => {
  const { t, p } = await startInteractive();
  let done = false;
  p.then(() => { done = true; });
  click(t, 10, 5);
  t.stdin.write('q');
  t.stdin.write('\x03');
  await until(() => keyDowns().length === 2);
  assert.deepEqual(keyDowns().map((k) => [k.key, k.modifiers]), [['q', 0], ['c', 2]]);
  await sleep(100);
  assert.equal(done, false);
  t.stdin.write(`\x1dq`); // prefix, quit
  assert.equal(await p, 0);
});

test('interactive: prefix then q quits; status shows prefix… while armed', async () => {
  const { t, p } = await startInteractive();
  click(t, 10, 5);
  t.stdin.write('\x1d');
  await until(() => t.out().includes('prefix…'));
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(keyDowns().length, 0);
});

test('interactive: prefix twice sends the prefix key; anything else cancels it', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write('\x1d\x1d');
  await until(() => keyDowns().length === 1);
  assert.equal(keyDowns()[0].key, ']');
  assert.equal(keyDowns()[0].modifiers, 2);
  t.stdin.write('\x1dx'); // cancelled: x is dropped
  t.stdin.write('y');
  await until(() => keyDowns().length === 2);
  assert.equal(keyDowns()[1].key, 'y');
  t.stdin.write(`${ESC}[93;5u`); // Kitty keyboard form of Ctrl-]
  t.stdin.write(`${ESC}[113u`); // q
  assert.equal(await p, 0);
});

test('interactive: the prefix disarms after 2 s', async () => {
  const { t, p } = await startInteractive();
  click(t, 10, 5);
  t.stdin.write('\x1d');
  await sleep(2100);
  t.stdin.write('q');
  await until(() => keyDowns().length === 1);
  assert.equal(keyDowns()[0].key, 'q');
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: on an agent browser the first click takes control; prefix g hands it back', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home));
  await until(() => /agent · https:\/\/example\.com\/ · \d+ fps/.test(t.out()));
  click(t, 10, 5);
  await untilAsync(async () => (await readControl('ag1', p0)).held);
  const c = JSON.parse(await fs.readFile(controlPath('ag1', p0), 'utf8'));
  assert.equal(c.viewerPid, process.pid);
  assert.equal(c.url, 'https://example.com/');
  assert.equal(c.idleReturnMs, 300_000);
  await until(() => t.out().includes('you have control · Ctrl-] g to hand back'));
  const from = t.out().length;
  t.stdin.write('\x1dg');
  await untilAsync(async () => !(await readControl('ag1', p0)).held);
  const after = await readControl('ag1', p0);
  assert.equal(after.takeovers, 1);
  assert.equal(after.lastTakeover.url, 'https://example.com/');
  await until(() => /agent · https:\/\/example\.com\/ · /.test(t.out().slice(from)));
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: hover is forwarded on an agent browser only while holding control', async () => {
  const home = await tmpHome();
  const { t, p } = await startInteractive(agentOpts(home));
  t.stdin.write(`${ESC}[<35;12;6M`);
  await sleep(100);
  assert.equal(mouse().length, 0, 'hover before taking control');
  assert.equal((await readControl('ag1', paths({ HOME: home }))).held, false, 'hover does not take control');
  click(t, 10, 5);
  await until(() => mouse().length === 2);
  for (let i = 0; i < 20; i++) t.stdin.write(`${ESC}[<35;${12 + (i % 5)};6M`);
  await sleep(200);
  const moves = mouse().filter((m) => m.type === 'mouseMoved');
  assert.ok(moves.length >= 1 && moves.length <= 8, `throttled hover: ${moves.length} moves`);
  const last = moves.at(-1);
  assert.equal(last.x, expectAt(t, 12 + (19 % 5), 6).x, 'the last position is delivered');
  assert.equal(last.button, 'none');
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: a standalone browser forwards hover always and never writes a control file', async () => {
  const home = await tmpHome();
  const { t, p } = await startInteractive({ env: { HOME: home }, control: { agentId: null, idleReturnMs: 300_000 } });
  t.stdin.write(`${ESC}[<35;12;6M`);
  await until(() => mouse().length === 1);
  assert.equal(mouse()[0].type, 'mouseMoved');
  click(t, 10, 5);
  t.stdin.write('abc');
  await until(() => keyDowns().length === 3);
  await sleep(100);
  await assert.rejects(fs.readdir(path.join(paths({ HOME: home }).state, 'control')));
  assert.ok(!t.out().includes('you have control'));
  t.stdin.write('\x1dg'); // nothing to hand back
  t.stdin.write('\x1dq');
  assert.equal(await p, 0);
});

test('interactive: SIGTERM while holding control releases it and restores modes', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home));
  click(t, 10, 5);
  await untilAsync(async () => (await readControl('ag1', p0)).held);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
  assert.equal((await readControl('ag1', p0)).held, false);
  const raw = JSON.parse(await fs.readFile(controlPath('ag1', p0), 'utf8'));
  assert.equal(raw.holder, null);
  assert.ok(t.out().includes(`${ESC}[<u`) && t.out().includes(`${ESC}[?1003l`) && t.out().includes(`${ESC}[?2004l`));
  assert.ok(t.out().endsWith(leaveScreen()));
});

test('interactive: idle return hands control back on its own', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home, { idleReturnMs: 100 }));
  click(t, 10, 5);
  await untilAsync(async () => (await readControl('ag1', p0)).held);
  const raw = () => fs.readFile(controlPath('ag1', p0), 'utf8').then(JSON.parse);
  await untilAsync(async () => (await raw()).holder === null, 1000);
  await until(() => /agent · https:\/\/example\.com\/ · [^\n]*$/.test(t.out()));
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: taking control while the agent is acting says so for a moment', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  await setAgentBusy('ag1', true, p0);
  const { t, p } = await startInteractive(agentOpts(home));
  click(t, 10, 5);
  await until(() => t.out().includes('agent was acting…'));
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: a failed take of control is shown and never claimed', async () => {
  const home = await tmpHome();
  const state = paths({ HOME: home }).state;
  await fs.mkdir(path.dirname(state), { recursive: true });
  await fs.writeFile(state, 'not a directory'); // every control-file write fails
  const { t, p } = await startInteractive(agentOpts(home));
  click(t, 10, 5);
  await until(() => mouse().length === 2, 3000);
  await until(() => t.out().includes("couldn't take control: "));
  assert.ok(!t.out().includes('you have control'));
  t.stdin.write(`${ESC}[<35;12;6M`); // not holding: hover is not forwarded
  await sleep(100);
  assert.equal(mouse().length, 2);
  await sleep(3100); // the message passes; back to the agent status
  assert.match(t.out().slice(t.out().lastIndexOf(`${ESC}[40;1H`)), /agent · https:\/\/example\.com\/ · /);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: a failed hand back is shown', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home));
  click(t, 10, 5);
  await until(() => t.out().includes('you have control'));
  await fs.rm(p0.profiles, { recursive: true });
  await fs.writeFile(p0.profiles, 'not a directory'); // the locked write fails from now on
  t.stdin.write('\x1dg');
  await until(() => t.out().includes("couldn't hand back control: "));
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: a click in the same chunk as a size reply is still delivered', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write(`${ESC}[6;37;17t${ESC}[<0;10;5M${ESC}[?62;c${ESC}[<0;10;5m`);
  await until(() => mouse().length === 2);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('watch only (interactive: false): no modes, q quits after other keys', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm();
  const { p } = start(t, { interactive: false });
  await until(() => methods(fake, 'Page.startScreencast').length === 1);
  t.stdin.write(`${ESC}[<0;10;5Mab`);
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.ok(!t.out().includes(`${ESC}[?1003h`));
  assert.equal(methods(fake, 'Input.dispatchMouseEvent').length + methods(fake, 'Input.dispatchKeyEvent').length, 0);
});

// --- final-review fixes ---
const lastStatus = (t) => {
  const all = [...t.out().matchAll(new RegExp(`${ESC}\\[${t.size.rows};1H${ESC}\\[2K([^\\x1b]*)`, 'g'))];
  return all.at(-1)?.[1];
};

test('interactive: after handing back, q and Ctrl-C quit again (nothing to the page, no new takeover)', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home));
  click(t, 10, 5);
  await untilAsync(async () => (await readControl('ag1', p0)).held);
  t.stdin.write('\x1dg');
  await untilAsync(async () => !(await readControl('ag1', p0)).held);
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(keyDowns().length, 0);
  const c = await readControl('ag1', p0);
  assert.equal(c.held, false);
  assert.equal(c.takeovers, 1);
});

test('interactive: status rows always say how to quit', async () => {
  const home = await tmpHome();
  {
    const { t, p } = await startInteractive();
    await until(() => /https:\/\/example\.com\/  \d+ fps · Ctrl-] q quit$/.test(lastStatus(t) ?? ''));
    t.signals.emit('SIGTERM');
    assert.equal(await p, 0);
    await fake.close();
  }
  {
    const { t, p } = await startInteractive(agentOpts(home));
    await until(() => /^agent · https:\/\/example\.com\/ · \d+ fps · Ctrl-] q quit$/.test(lastStatus(t) ?? ''));
    t.signals.emit('SIGTERM');
    assert.equal(await p, 0);
    await fake.close();
  }
  {
    // Custom keys are named; a narrow pane shortens the URL, never past the width.
    fake = await startDrawing();
    const t = fakeTerm();
    t.size.cols = 30;
    t.size.pxW = 30 * 17;
    const { p } = start(t, { ...agentOpts(home), keys: { prefix: parseKeySpec('ctrl-a'), giveBack: parseKeySpec('g'), quit: parseKeySpec('x') } });
    await until(() => count(t.out(), 'a=T,f=100') === 1 && (lastStatus(t) ?? '').startsWith('agent · '));
    const row = lastStatus(t);
    assert.ok(row.length <= 30, row);
    assert.equal(row.length, 30, row);
    assert.match(row, /^agent · .* · Ctrl-a x quit$/);
    t.signals.emit('SIGTERM');
    assert.equal(await p, 0);
  }
});

test('watch only: the status row says q quits', async () => {
  fake = await startDrawing();
  const t = fakeTerm();
  const { p } = start(t, { interactive: false });
  await until(() => /https:\/\/example\.com\/  \d+ fps · q quit$/.test(lastStatus(t) ?? ''));
  t.stdin.write('q');
  assert.equal(await p, 0);
});

test('interactive: the click that focuses the pane is not delivered and takes no control', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home));
  t.stdin.write(`${ESC}[I`);
  click(t, 10, 5);
  await sleep(100);
  assert.equal(mouse().length, 0);
  await assert.rejects(fs.access(controlPath('ag1', p0)));
  await sleep(100); // 200 ms after the focus-in: a real click
  click(t, 10, 5);
  await until(() => mouse().length === 2);
  assert.deepEqual(mouse().map((m) => m.type), ['mousePressed', 'mouseReleased']);
  await untilAsync(async () => (await readControl('ag1', p0)).held);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('interactive: wheel while the terminal reports focus out is ignored', async () => {
  const home = await tmpHome();
  const { t, p } = await startInteractive(agentOpts(home));
  t.stdin.write(`${ESC}[O`);
  t.stdin.write(`${ESC}[<65;10;5M`);
  await sleep(100);
  assert.equal(mouse().length, 0);
  await assert.rejects(fs.access(controlPath('ag1', paths({ HOME: home }))));
  t.stdin.write(`${ESC}[I`);
  t.stdin.write(`${ESC}[<65;10;5M`);
  await until(() => mouse().length === 1);
  assert.equal(mouse()[0].type, 'mouseWheel');
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('watch only (interactive: false) on an agent browser: no modes, clicks and keys never take control', async () => {
  const home = await tmpHome();
  fake = await startDrawing();
  const t = fakeTerm();
  const { p } = start(t, { ...agentOpts(home), interactive: false });
  await until(() => count(t.out(), 'a=T,f=100') === 1);
  t.stdin.write(`${ESC}[<0;10;5M${ESC}[<0;10;5mab`);
  await sleep(100);
  t.stdin.write('q');
  assert.equal(await p, 0);
  for (const mode of ['?1003h', '?1006h', '?2004h', '>29u', '?1004h']) assert.ok(!t.out().includes(`${ESC}[${mode}`), mode);
  assert.equal(mouse().length + keyDowns().length, 0);
  await assert.rejects(fs.access(controlPath('ag1', paths({ HOME: home }))));
});

test('interactive: idle hand back ends the takeover at the last input, not after the wait', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home, { idleReturnMs: 400 }));
  click(t, 10, 5);
  const raw = () => fs.readFile(controlPath('ag1', p0), 'utf8').then(JSON.parse);
  await untilAsync(async () => (await raw()).holder === 'user');
  await untilAsync(async () => (await raw()).holder === null, 2000);
  const { since, until: end } = (await raw()).lastTakeover;
  assert.ok(end - since < 200, `takeover lasted ${end - since} ms`);
  t.stdin.write('q'); // back to watching
  assert.equal(await p, 0);
});

test('interactive: reserved letters match either case (Caps Lock); the pre-input quit is keys.quit', async () => {
  const home = await tmpHome();
  const p0 = paths({ HOME: home });
  const { t, p } = await startInteractive(agentOpts(home));
  click(t, 10, 5);
  await untilAsync(async () => (await readControl('ag1', p0)).held);
  t.stdin.write('\x1dG');
  await untilAsync(async () => !(await readControl('ag1', p0)).held);
  t.stdin.write('Q');
  assert.equal(await p, 0);
  assert.equal(keyDowns().length, 0);
  await fake.close();

  const v = await startInteractive({ keys: { prefix: parseKeySpec('ctrl-]'), giveBack: parseKeySpec('g'), quit: parseKeySpec('x') } });
  v.t.stdin.write('x');
  assert.equal(await v.p, 0);
  assert.equal(keyDowns().length, 0);
});

test('escFlushMs: long with the Kitty keyboard protocol or over ssh, short otherwise', () => {
  assert.equal(escFlushMs({ kittyKeyboard: true, env: {} }), 300);
  assert.equal(escFlushMs({ kittyKeyboard: false, env: {} }), 50);
  assert.equal(escFlushMs({ kittyKeyboard: false, env: { SSH_CONNECTION: '1 2 3 4' } }), 300);
});

test('interactive: a lone ESC waits 300 ms once the terminal acknowledges the Kitty keyboard protocol', async () => {
  const { t, p } = await startInteractive();
  t.stdin.write(ESC);
  await until(() => keyDowns().length === 1, 200); // plain terminal: 50 ms
  assert.equal(keyDowns()[0].key, 'Escape');
  t.stdin.write(`${ESC}[?29u`); // keyboard flags reply
  await sleep(20);
  t.stdin.write(ESC);
  await sleep(150);
  assert.equal(keyDowns().length, 1, 'flushed too soon');
  await until(() => keyDowns().length === 2, 500);
  t.signals.emit('SIGTERM');
  assert.equal(await p, 0);
});

test('a process exit before finish still restores the terminal; finish removes that listener', async () => {
  {
    const { t, p } = await startInteractive();
    assert.equal(t.signals.listenerCount('exit'), 1);
    t.signals.emit('exit', 1); // e.g. process.exit from elsewhere
    assert.ok(t.out().endsWith(MODES_OFF + leaveScreen()));
    assert.equal(t.stdin.isRaw, false);
    assert.equal(t.signals.listenerCount('exit'), 0);
    const len = t.out().length;
    t.signals.emit('SIGTERM');
    assert.equal(await p, 0);
    assert.ok(!t.out().slice(len).includes(leaveScreen()), 'restored twice');
    await fake.close();
  }
  const { t, p } = await startInteractive();
  t.stdin.write('q');
  assert.equal(await p, 0);
  assert.equal(t.signals.listenerCount('exit'), 0);
});

async function untilAsync(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await cond().catch(() => false))) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
