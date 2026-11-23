import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/paths.js';
import { agentProfile, pruneProfiles } from '../src/profiles.js';
import { upsertEntry } from '../src/registry.js';

async function tmpPaths() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tb-prof-'));
  return paths({ HOME: home });
}
const exists = (f) => fs.lstat(f).then(() => true, () => false);

test('copies starter without locks or caches, once', async () => {
  const p = await tmpPaths();
  await fs.mkdir(path.join(p.starter, 'Default', 'Cache'), { recursive: true });
  await fs.mkdir(path.join(p.starter, 'Default', 'Code Cache'), { recursive: true });
  await fs.mkdir(path.join(p.starter, 'Default', 'GPUCache'), { recursive: true });
  await fs.writeFile(path.join(p.starter, 'Default', 'Cookies'), 'c');
  await fs.writeFile(path.join(p.starter, 'Default', 'Cache', 'x'), 'x');
  await fs.writeFile(path.join(p.starter, 'DevToolsActivePort'), '9222\n/devtools');
  await fs.writeFile(path.join(p.starter, 'lockfile'), '');
  // A live Chrome's lock files are dangling symlinks; copying them must not break the copy.
  for (const n of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    await fs.symlink('host-12345', path.join(p.starter, n));
  }
  const dir = await agentProfile('agent1', p);
  assert.equal(dir, path.join(p.profiles, 'agent1'));
  assert.equal(await fs.readFile(path.join(dir, 'Default', 'Cookies'), 'utf8'), 'c');
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort',
    'lockfile', 'Default/Cache', 'Default/Code Cache', 'Default/GPUCache']) {
    assert.equal(await exists(path.join(dir, f)), false, f);
  }
  assert.equal(await exists(path.join(dir, '.termbrowse-last-used')), true);
  await fs.writeFile(path.join(p.starter, 'later'), '1');
  await agentProfile('agent1', p);
  assert.equal(await exists(path.join(dir, 'later')), false);
});

test('no starter creates an empty profile', async () => {
  const p = await tmpPaths();
  const dir = await agentProfile('a', p);
  assert.deepEqual(await fs.readdir(dir), ['.termbrowse-last-used']);
});

test('ids are sanitized and stay inside profiles', async () => {
  const p = await tmpPaths();
  const dir = await agentProfile('t2p/../x', p);
  assert.equal(dir, path.join(p.profiles, 't2p_.._x'));
  assert.equal(path.dirname(dir), p.profiles);
});

test('pruneProfiles removes only stale, non-live profiles', async () => {
  const p = await tmpPaths();
  const now = Date.now();
  const age = async (id, days) => {
    const dir = await agentProfile(id, p);
    const t = new Date(now - days * 86400_000);
    await fs.utimes(path.join(dir, '.termbrowse-last-used'), t, t);
  };
  await age('old', 8);
  await age('recent', 1);
  await age('oldlive', 8);
  await fs.mkdir(p.state, { recursive: true });
  await upsertEntry({ agentId: 'oldlive', pid: process.pid, port: 1, profileDir: '', kind: 'agent',
    startedAt: '', wrapperPid: process.pid }, p);
  assert.deepEqual(await pruneProfiles(7, p, now), ['old']);
  assert.equal(await exists(path.join(p.profiles, 'old')), false);
  assert.equal(await exists(path.join(p.profiles, 'recent')), true);
  assert.equal(await exists(path.join(p.profiles, 'oldlive')), true);
});

test('pruneProfiles with no profiles dir returns []', async () => {
  assert.deepEqual(await pruneProfiles(7, await tmpPaths()), []);
});
