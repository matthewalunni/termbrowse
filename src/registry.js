import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.js';

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists, not ours
  }
}

// Returns { list, corrupt }. With quarantine (only valid under the lock), a corrupt
// file is moved aside so it is kept once and the registry starts clean.
async function load(p, quarantine = false) {
  let text;
  try {
    text = await fs.readFile(p.registry, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { list: [], corrupt: false };
    throw e;
  }
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('not an array');
    return { list: data, corrupt: false };
  } catch {
    if (quarantine) await fs.rename(p.registry, `${p.registry}.corrupt-${Date.now()}`).catch(() => {});
    return { list: [], corrupt: true };
  }
}

async function save(list, p) {
  await fs.mkdir(path.dirname(p.registry), { recursive: true });
  const tmp = `${p.registry}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2));
  await fs.rename(tmp, p.registry);
}

async function withLock(p, fn) {
  await fs.mkdir(path.dirname(p.registry), { recursive: true });
  const lock = `${p.registry}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      (await fs.open(lock, 'wx')).close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`registry lock busy: ${lock}`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

const modify = (p, change) =>
  withLock(p, async () => {
    const { list } = await load(p, true);
    await save(change(list), p);
  });

const ORPHAN_GRACE_MS = 2000;

// The process that launched this Chrome (MCP wrapper or standalone termbrowse) died without
// cleaning up (SIGKILL, crash), yet the Chrome lives on in its own process group.
const orphaned = (e) => Number.isInteger(e.wrapperPid) && e.wrapperPid > 0 && alive(e.pid) && !alive(e.wrapperPid);

async function killGroup(pid) {
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  };
  signal('SIGTERM');
  const end = Date.now() + ORPHAN_GRACE_MS;
  while (alive(pid) && Date.now() < end) await sleep(50);
  if (alive(pid)) signal('SIGKILL');
}

export async function readRegistry(p = paths()) {
  const { list, corrupt } = await load(p);
  const orphans = list.filter(orphaned);
  // Killed outside the lock: the grace period could outlast the lock timeout of other callers.
  await Promise.all(orphans.map((e) => killGroup(e.pid)));
  const swept = new Set(orphans.map((e) => e.pid));
  const keep = (e) => alive(e.pid) && !swept.has(e.pid);
  const live = list.filter(keep);
  if (!corrupt && live.length === list.length) return live;
  // Re-read under the lock so a concurrent upsert is not overwritten.
  await modify(p, (cur) => cur.filter(keep));
  return (await load(p)).list;
}

export const upsertEntry = (e, p = paths()) =>
  modify(p, (list) => [...list.filter((x) => x.agentId !== e.agentId), e]);

export const removeEntry = (agentId, p = paths()) =>
  modify(p, (list) => list.filter((x) => x.agentId !== agentId));

export async function findEntry(agentId, p = paths()) {
  return (await readRegistry(p)).find((e) => e.agentId === agentId) ?? null;
}
