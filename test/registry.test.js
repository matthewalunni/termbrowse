import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/paths.js';
import { readRegistry, upsertEntry, removeEntry, findEntry } from '../src/registry.js';

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
