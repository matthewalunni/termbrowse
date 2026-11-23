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

test('empty, "." and ".." ids stay strictly inside profiles', async () => {
  const p = await tmpPaths();
  for (const id of ['', '.', '..']) {
    const dir = await agentProfile(id, p);
    assert.equal(path.dirname(dir), p.profiles, JSON.stringify(id));
    assert.notEqual(dir, p.profiles);
  }
  assert.equal(await exists(path.join(p.state, '.termbrowse-last-used')), false);
  assert.equal(await exists(path.join(p.profiles, '.termbrowse-last-used')), false);
});

test('concurrent agentProfile calls for one id yield one complete copy and no tmp dirs', async () => {
  const p = await tmpPaths();
  await fs.mkdir(path.join(p.starter, 'Default'), { recursive: true });
  for (let i = 0; i < 200; i++) await fs.writeFile(path.join(p.starter, 'Default', `f${i}`), String(i));
  const dirs = await Promise.all(Array.from({ length: 8 }, () => agentProfile('same', p)));
  assert.ok(dirs.every((d) => d === path.join(p.profiles, 'same')));
  assert.equal((await fs.readdir(path.join(p.profiles, 'same', 'Default'))).length, 200);
  assert.deepEqual(await fs.readdir(p.profiles), ['same']);
});

test('pruneProfiles removes standalone-<pid> dirs of dead pids regardless of age', async () => {
  const p = await tmpPaths();
  const { spawn } = await import('node:child_process');
  const live = spawn('sleep', ['30'], { stdio: 'ignore' });
  const dead = spawn('true', { stdio: 'ignore' });
  await new Promise((r) => dead.once('exit', r));
  try {
    const deadDir = await fs.mkdir(path.join(p.profiles, `standalone-${dead.pid}`), { recursive: true }).then(() => path.join(p.profiles, `standalone-${dead.pid}`));
    const liveDir = path.join(p.profiles, `standalone-${live.pid}`);
    await fs.mkdir(liveDir, { recursive: true });
    const agentDir = await agentProfile(`standalone-x`, p); // not a pid: an ordinary (fresh) agent id
    const removed = await pruneProfiles(7, p);
    assert.deepEqual(removed, [`standalone-${dead.pid}`]);
    assert.equal(await exists(deadDir), false);
    assert.equal(await exists(liveDir), true);
    assert.equal(await exists(agentDir), true);
  } finally {
    live.kill('SIGKILL');
  }
});

test('pruneProfiles removes pid-<pid> dirs of dead pids regardless of age', async () => {
  const p = await tmpPaths();
  const { spawn } = await import('node:child_process');
  const live = spawn('sleep', ['30'], { stdio: 'ignore' });
  const dead = spawn('true', { stdio: 'ignore' });
  await new Promise((r) => dead.once('exit', r));
  try {
    const deadDir = await agentProfile(`pid-${dead.pid}`, p); // fresh marker: age alone would keep it
    const liveDir = await agentProfile(`pid-${live.pid}`, p);
    const otherDir = await agentProfile('pid-x', p);
    assert.deepEqual(await pruneProfiles(7, p), [`pid-${dead.pid}`]);
    assert.equal(await exists(deadDir), false);
    assert.equal(await exists(liveDir), true);
    assert.equal(await exists(otherDir), true);
  } finally {
    live.kill('SIGKILL');
  }
});

test('the state and profiles dirs are created private (0700), also when they already exist', async () => {
  const p = await tmpPaths();
  await agentProfile('a', p);
  assert.equal((await fs.stat(p.state)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(p.profiles)).mode & 0o777, 0o700);
  await fs.chmod(p.state, 0o755);
  await fs.chmod(p.profiles, 0o755);
  await agentProfile('b', p);
  assert.equal((await fs.stat(p.state)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(p.profiles)).mode & 0o777, 0o700);
});

test('pruneProfiles also deletes Chrome logs older than prune_days', async () => {
  const p = await tmpPaths();
  const now = Date.now();
  await fs.mkdir(p.logs, { recursive: true });
  const make = async (name, days) => {
    const f = path.join(p.logs, name);
    await fs.writeFile(f, 'x');
    const t = new Date(now - days * 86400_000);
    await fs.utimes(f, t, t);
    return f;
  };
  const oldLog = await make('chrome-999999.log', 8);
  const oldStarting = await make('chrome-starting-1-9222.log', 8);
  const freshLog = await make('chrome-1234.log', 1);
  const other = await make('notes.log', 30);
  await pruneProfiles(7, p, now);
  assert.equal(await exists(oldLog), false);
  assert.equal(await exists(oldStarting), false);
  assert.equal(await exists(freshLog), true);
  assert.equal(await exists(other), true, 'only chrome logs are pruned');
});

test('pruneProfiles sweeps profile .tmp- copies older than an hour', async () => {
  const p = await tmpPaths();
  const now = Date.now();
  await agentProfile('keep', p);
  const oldTmp = path.join(p.profiles, 'agent1.tmp-4242-1');
  const newTmp = path.join(p.profiles, 'agent2.tmp-4242-2');
  await fs.mkdir(path.join(oldTmp, 'Default'), { recursive: true });
  await fs.mkdir(newTmp, { recursive: true });
  const t = new Date(now - 2 * 3600_000);
  await fs.utimes(oldTmp, t, t);
  await pruneProfiles(7, p, now);
  assert.equal(await exists(oldTmp), false);
  assert.equal(await exists(newTmp), true, 'a copy in progress is left alone');
  assert.equal(await exists(path.join(p.profiles, 'keep')), true);
});
