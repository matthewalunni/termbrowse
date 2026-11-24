import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from '../src/paths.js';
import {
  controlPath, takeControl, touchControl, releaseControl, readControl, setAgentBusy,
} from '../src/control.js';

async function tmpPaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-ctl-'));
  return paths({ HOME: home });
}
const take = (p, over = {}) =>
  takeControl('a1', { viewerPid: process.pid, url: 'https://a.test/', idleReturnMs: 300_000, ...over }, p);
const touch = (p, over = {}) =>
  touchControl('a1', { viewerPid: process.pid, url: 'https://a.test/', idleReturnMs: 300_000, ...over }, p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('take then read is held with one takeover; taking again while held does not count', async () => {
  const p = await tmpPaths();
  await take(p);
  let c = await readControl('a1', p);
  assert.equal(c.held, true);
  assert.equal(c.takeovers, 1);
  await take(p);
  c = await readControl('a1', p);
  assert.equal(c.takeovers, 1);
});

test('release records lastTakeover and keeps takeovers; a second take+release makes 2', async () => {
  const p = await tmpPaths();
  await take(p);
  await releaseControl('a1', { url: 'https://b.test/' }, p);
  let c = await readControl('a1', p);
  assert.equal(c.held, false);
  assert.equal(c.takeovers, 1);
  assert.equal(c.lastTakeover.url, 'https://b.test/');
  assert.equal(typeof c.lastTakeover.since, 'number');
  assert.ok(c.lastTakeover.until >= c.lastTakeover.since);
  await take(p);
  await releaseControl('a1', { url: 'https://c.test/' }, p);
  c = await readControl('a1', p);
  assert.equal(c.takeovers, 2);
  assert.equal(c.lastTakeover.url, 'https://c.test/');
});

test('no file reads as not held', async () => {
  const c = await readControl('nobody', await tmpPaths());
  assert.deepEqual(c, { held: false, takeovers: 0, lastTakeover: null, agentBusySince: null });
});

test('dead viewer pid is released', async () => {
  const p = await tmpPaths();
  const child = spawn(process.execPath, ['-e', '0']);
  const pid = child.pid;
  await new Promise((r) => child.on('exit', r));
  await take(p, { viewerPid: pid, url: 'https://dead.test/' });
  const c = await readControl('a1', p);
  assert.equal(c.held, false);
  assert.equal(c.takeovers, 1);
  assert.equal(c.lastTakeover.url, 'https://dead.test/');
  assert.equal((await readControl('a1', p)).held, false);
});

test('idle past idleReturnMs is released, until = lastInput', async () => {
  const p = await tmpPaths();
  await take(p, { idleReturnMs: 50 });
  await sleep(80);
  const c = await readControl('a1', p);
  assert.equal(c.held, false);
  assert.ok(c.lastTakeover.until <= Date.now() - 50);
});

test('touchControl keeps a held control from going idle', async () => {
  const p = await tmpPaths();
  await take(p, { idleReturnMs: 150 });
  await sleep(100);
  await touch(p);
  await sleep(100);
  assert.equal((await readControl('a1', p)).held, true);
});

test('touchControl retakes a control that was released under the holder (idle or dead pid read)', async () => {
  const p = await tmpPaths();
  await take(p, { idleReturnMs: 50 });
  await sleep(80);
  assert.equal((await readControl('a1', p)).held, false); // the wrapper's read released it
  await touch(p, { url: 'https://again.test/' });
  const c = await readControl('a1', p);
  assert.equal(c.held, true);
  assert.equal(c.takeovers, 2);
  const raw = JSON.parse(await fs.readFile(controlPath('a1', p), 'utf8'));
  assert.equal(raw.viewerPid, process.pid);
  assert.equal(raw.url, 'https://again.test/');
  assert.equal(raw.idleReturnMs, 300_000);
  assert.ok(Date.now() - raw.since < 1000 && raw.lastInput >= raw.since);
});

test('releaseControl until: the takeover ends then, not at the release', async () => {
  const p = await tmpPaths();
  await take(p);
  const { since } = JSON.parse(await fs.readFile(controlPath('a1', p), 'utf8'));
  await sleep(120);
  await releaseControl('a1', { url: 'u', until: since + 10 }, p);
  assert.equal((await readControl('a1', p)).lastTakeover.until, since + 10);
  await take(p);
  await releaseControl('a1', { url: 'u', until: 0 }, p); // never before it began
  const t = (await readControl('a1', p)).lastTakeover;
  assert.equal(t.until, t.since);
});

test('agent busy flag sets and clears', async () => {
  const p = await tmpPaths();
  await setAgentBusy('a1', true, p);
  assert.equal(typeof (await readControl('a1', p)).agentBusySince, 'number');
  await setAgentBusy('a1', false, p);
  assert.equal((await readControl('a1', p)).agentBusySince, null);
});

test('busy flag survives take and release', async () => {
  const p = await tmpPaths();
  await setAgentBusy('a1', true, p);
  await take(p);
  await releaseControl('a1', { url: 'u' }, p);
  assert.equal(typeof (await readControl('a1', p)).agentBusySince, 'number');
});

test('control dir is private and ids cannot escape it', async () => {
  const p = await tmpPaths();
  const f = controlPath('../x', p);
  assert.equal(path.dirname(f), path.join(p.state, 'control'));
  await takeControl('../x', { viewerPid: process.pid, url: 'u', idleReturnMs: 1000 }, p);
  assert.ok((await fs.stat(f)).isFile());
  assert.equal((await fs.stat(path.join(p.state, 'control'))).mode & 0o777, 0o700);
});

test('concurrent touches and busy updates lose nothing', async () => {
  const p = await tmpPaths();
  await take(p);
  await Promise.all([
    ...Array.from({ length: 10 }, () => touch(p)),
    setAgentBusy('a1', true, p),
  ]);
  const c = await readControl('a1', p);
  assert.equal(c.held, true);
  assert.equal(typeof c.agentBusySince, 'number');
});
