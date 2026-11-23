import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runViewer, nextEveryNth } from '../src/viewer.js';
import { kittyQuery, leaveScreen } from '../src/kitty.js';
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

// Fake terminal: stdout is a TTY PassThrough; stdin answers CSI 14t and the Kitty query.
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
    if (s.includes(`${ESC}[14t`)) {
      // split the reply across two chunks
      const reply = `${ESC}[4;${size.pxH};${size.pxW}t`;
      setImmediate(() => { stdin.write(reply.slice(0, 5)); setImmediate(() => stdin.write(reply.slice(5))); });
    }
    if (s.includes(kittyQuery())) {
      setImmediate(() => stdin.write(kitty ? `${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c` : `${ESC}[?62;c`));
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
    onReady: (c) => { controls = c; },
    ...opts,
  });
  return { p, controls: () => controls };
}

test('refuses non-kitty terminal', async () => {
  fake = await startFakeCdp();
  const t = fakeTerm({ kitty: false });
  const code = await runViewer({ port: fake.port, stdin: t.stdin, stdout: t.stdout, stderr: t.stderr, signals: t.signals });
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
  const code = await runViewer({ port: fake.port, stdin: t.stdin, stdout: t.stdout, stderr: t.stderr, signals: t.signals });
  assert.equal(code, 2);
  assert.equal(t.out(), '');
  assert.match(t.err(), /doesn't support Kitty graphics/);
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
  fake.closeSockets();
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
  for (const s of ['SIGINT', 'SIGTERM', 'SIGWINCH']) assert.equal(t.signals.listenerCount(s), 0);
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
  fake = await startFakeCdpWith([
    { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example' },
    { id: 'T2', type: 'page', url: 'https://popup.example/', title: 'Popup' },
  ]);
  const t = fakeTerm();
  const { p } = start(t);
  await until(() => methods(fake, 'Target.setDiscoverTargets').length === 1 && methods(fake, 'Page.startScreencast').length === 1);
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T9', type: 'page', openerId: 'OTHER', url: 'x' } } });
  fake.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'T2', type: 'page', openerId: 'T1', url: 'https://popup.example/' } } });
  await until(() => methods(fake, 'Page.startScreencast').length === 2);
  await until(() => t.out().includes('https://popup.example/'));
  t.stdin.write('q');
  assert.equal(await p, 0);
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
