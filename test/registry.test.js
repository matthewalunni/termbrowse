import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/paths.js';
import { readRegistry, upsertEntry, removeEntry, findEntry, withLock } from '../src/registry.js';

async function tmpPaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-reg-'));
  const p = paths({ HOME: home });
  await fs.mkdir(p.state, { recursive: true });
  return p;
}
const entry = (agentId, over = {}) => ({
  agentId, pid: process.pid, port: 9300, profileDir: '/x/' + agentId,
  kind: 'agent', startedAt: new Date().toISOString(), wrapperPid: process.pid, ...over,
});

test('missing registry reads as empty', async () => {
  assert.deepEqual(await readRegistry(await tmpPaths()), []);
});

test('20 concurrent upserts lose nothing', async () => {
  const p = await tmpPaths();
  const ids = Array.from({ length: 20 }, (_, i) => `a${i}`);
  await Promise.all(ids.map((id, i) => upsertEntry(entry(id, { port: 9300 + i }), p)));
  const got = await readRegistry(p);
  assert.deepEqual(got.map((e) => e.agentId).sort(), [...ids].sort());
});

test('upsert replaces an entry with the same id', async () => {
  const p = await tmpPaths();
  await upsertEntry(entry('a', { port: 1 }), p);
  await upsertEntry(entry('a', { port: 2 }), p);
  const got = await readRegistry(p);
  assert.equal(got.length, 1);
  assert.equal((await findEntry('a', p)).port, 2);
  assert.equal(await findEntry('nope', p), null);
});

test('dead pid is dropped on read and the file rewritten', async () => {
  const p = await tmpPaths();
  await upsertEntry(entry('live'), p);
  await upsertEntry(entry('dead', { pid: 999999 }), p);
  assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), ['live']);
  const onDisk = JSON.parse(await fs.readFile(p.registry, 'utf8'));
  assert.deepEqual(onDisk.map((e) => e.agentId), ['live']);
});

test('removeEntry removes only its id', async () => {
  const p = await tmpPaths();
  await upsertEntry(entry('a'), p);
  await upsertEntry(entry('b'), p);
  await removeEntry('a', p);
  assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), ['b']);
});

test('corrupt registry reads as empty and a copy is kept', async () => {
  const p = await tmpPaths();
  await fs.writeFile(p.registry, '{not json');
  assert.deepEqual(await readRegistry(p), []);
  const files = (await fs.readdir(p.state)).filter((f) => f.startsWith('agents.json.corrupt-'));
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(path.join(p.state, files[0]), 'utf8'), '{not json');
  await upsertEntry(entry('a'), p); // still usable afterwards
  assert.equal((await readRegistry(p)).length, 1);
});

test('a lock older than 10s is broken', async () => {
  const p = await tmpPaths();
  const lock = p.registry + '.lock';
  await fs.writeFile(lock, '');
  const old = new Date(Date.now() - 30_000);
  await fs.utimes(lock, old, old);
  await upsertEntry(entry('a'), p);
  assert.equal((await readRegistry(p)).length, 1);
  await assert.rejects(fs.stat(lock)); // released
});

test('a fresh lock is respected until released', async () => {
  const p = await tmpPaths();
  const lock = p.registry + '.lock';
  await fs.writeFile(lock, '');
  let done = false;
  const pr = upsertEntry(entry('a'), p).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(done, false);
  await fs.unlink(lock);
  await pr;
  assert.equal(done, true);
});

test('repeated reads of a corrupt registry keep exactly one copy', async () => {
  const p = await tmpPaths();
  await fs.writeFile(p.registry, '{not json');
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await readRegistry(p), []);
    assert.equal(await findEntry('x', p), null);
  }
  const copies = (await fs.readdir(p.state)).filter((f) => f.includes('.corrupt-'));
  assert.equal(copies.length, 1);
  assert.deepEqual(await readRegistry(p), []);
});

test('an entry whose wrapper died has its Chrome process group killed and is dropped', async () => {
  const { spawn } = await import('node:child_process');
  const p = await tmpPaths();
  // A real dead pid: a process that has already exited (and been reaped).
  const gone = spawn('/bin/sh', ['-c', 'exit 0']);
  await new Promise((r) => gone.once('exit', r));
  // The "Chrome": a detached sleeper leading its own group, with a helper in that group.
  const chrome = spawn('/bin/sh', ['-c', 'sleep 60 & wait'], { detached: true, stdio: 'ignore' });
  const chromeExit = new Promise((r) => chrome.once('exit', r));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await upsertEntry(entry('orphan', { pid: chrome.pid, wrapperPid: gone.pid }), p);
    await upsertEntry(entry('owned'), p);
    const got = await readRegistry(p);
    assert.deepEqual(got.map((e) => e.agentId), ['owned']);
    await chromeExit;
    assert.equal(alive(chrome.pid), false);
    assert.throws(() => process.kill(-chrome.pid, 0), { code: 'ESRCH' }, 'process group still has members');
    assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), ['owned']);
  } finally {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
  }
});

test('entries with a pid that is not a positive integer count as dead', async () => {
  const p = await tmpPaths();
  await upsertEntry(entry('live'), p);
  // process.kill(0, 0) signals our own process group, so pid 0 would otherwise look alive.
  for (const [id, pid] of [['zero', 0], ['negative', -1], ['string', String(process.pid)], ['fraction', 1.5], ['missing', undefined]]) {
    await upsertEntry(entry(id, { pid, wrapperPid: undefined }), p);
  }
  assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), ['live']);
});

test('the state dir is created private (0700)', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-reg-'));
  const p = paths({ HOME: home });
  await upsertEntry(entry('a'), p);
  assert.equal((await fs.stat(p.state)).mode & 0o777, 0o700);
});

test('the lock is released when the work under it throws', async () => {
  const p = await tmpPaths();
  await assert.rejects(withLock(p, async () => { throw new Error('boom'); }), /boom/);
  await assert.rejects(fs.stat(p.registry + '.lock'), 'lock left behind');
  await upsertEntry(entry('after'), p);
  assert.deepEqual((await readRegistry(p)).map((e) => e.agentId), ['after']);
});

test('an orphaned entry whose pid now names an unrelated, later process is dropped but not killed', async () => {
  const { spawn } = await import('node:child_process');
  const p = await tmpPaths();
  const gone = spawn('/bin/sh', ['-c', 'exit 0']);
  await new Promise((r) => gone.once('exit', r));
  // The pid was reused: this sleeper started after the entry was recorded, and the port is dead.
  const sleeper = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const saved = process.stderr.write;
  let err = '';
  process.stderr.write = (s) => { err += s; return true; };
  try {
    const startedAt = new Date(Date.now() - 3600_000).toISOString();
    await upsertEntry(entry('reused', { pid: sleeper.pid, port: 1, startedAt, wrapperPid: gone.pid }), p);
    const got = await readRegistry(p);
    process.stderr.write = saved;
    assert.deepEqual(got, []);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(alive(sleeper.pid), true, 'unrelated process was killed');
    assert.equal(err.trim().split('\n').length, 1, err);
    assert.match(err, new RegExp(`not killing pid ${sleeper.pid}`));
  } finally {
    process.stderr.write = saved;
    sleeper.kill('SIGKILL');
  }
});
