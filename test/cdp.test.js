import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { listTargets, browserVersion, waitForPort, CdpSession, pickTarget } from '../src/cdp.js';
import { startFakeCdp } from './helpers/fake-cdp.js';

let fake;
before(async () => {
  fake = await startFakeCdp({
    handlers: {
      'Bad.method': () => { throw new Error('nope, bad method'); },
      'X': () => ({ ok: true }),
    },
  });
});
after(() => fake.close());

async function closedPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('listTargets and browserVersion read the discovery endpoints', async () => {
  const targets = await listTargets(fake.port);
  assert.equal(targets[0].id, 'T1');
  const v = await browserVersion(fake.port);
  assert.equal(v.Browser, 'Chrome/Fake');
  assert.equal(v.webSocketDebuggerUrl, fake.wsUrl);
});

test('browserVersion is null when the port refuses connections', async () => {
  assert.equal(await browserVersion(await closedPort()), null);
});

test('waitForPort resolves for an open port', async () => {
  await waitForPort(fake.port, 1000);
});

test('waitForPort rejects on a closed port', async () => {
  const port = await closedPort();
  const t0 = Date.now();
  await assert.rejects(
    waitForPort(port, 300),
    new Error(`Chrome did not open its debugging port ${port} within 300 ms`),
  );
  assert.ok(Date.now() - t0 < 800);
});

test('send resolves results and rejects with the CDP error message', async () => {
  const s = await CdpSession.connect(fake.wsUrl);
  assert.deepEqual(await s.send('X'), { ok: true });
  assert.deepEqual(await s.send('Y', { a: 1 }), {});
  assert.deepEqual(fake.received.at(-1).params, { a: 1 });
  await assert.rejects(s.send('Bad.method'), /nope, bad method/);
  s.close();
});

test('CDP events surface as event CustomEvents', async () => {
  const s = await CdpSession.connect(fake.wsUrl);
  const got = new Promise((resolve) => s.addEventListener('event', (e) => resolve(e.detail), { once: true }));
  fake.send({ method: 'Page.screencastFrame', params: { sessionId: 7 } });
  assert.deepEqual(await got, { method: 'Page.screencastFrame', params: { sessionId: 7 } });
  s.close();
});

test('server closing the socket emits close, and later sends reject', async () => {
  const s = await CdpSession.connect(fake.wsUrl);
  const closed = new Promise((resolve) => s.addEventListener('close', resolve, { once: true }));
  fake.closeSockets();
  await closed;
  await assert.rejects(s.send('X'), /closed/i);
});

test('pending sends reject when the socket closes', async () => {
  const slow = await startFakeCdp({ handlers: { Slow: () => new Promise(() => {}) } });
  try {
    const s = await CdpSession.connect(slow.wsUrl);
    const p = s.send('Slow');
    const settled = assert.rejects(p, /closed/i);
    slow.closeSockets();
    await settled;
  } finally {
    await slow.close();
  }
});

test('pickTarget prefers a match, skips non-pages, falls back to first page', () => {
  const targets = [
    { id: 'sw', type: 'service_worker', url: 'https://match.dev/sw.js', title: 'match' },
    { id: 'a', type: 'page', url: 'https://a.test/', title: 'Alpha' },
    { id: 'b', type: 'page', url: 'https://b.test/', title: 'Beta Docs' },
  ];
  assert.equal(pickTarget(targets, 'MATCH'), targets[1]);
  assert.equal(pickTarget(targets, 'beta').id, 'b');
  assert.equal(pickTarget(targets, 'B.TEST').id, 'b');
  assert.equal(pickTarget(targets).id, 'a');
  assert.equal(pickTarget([targets[0]]), null);
  assert.equal(pickTarget([]), null);
});
