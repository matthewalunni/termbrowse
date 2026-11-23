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

async function load(p) {
  let text;
  try {
    text = await fs.readFile(p.registry, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('not an array');
    return data;
  } catch {
    // Keep what was there rather than silently discarding it.
    await fs.writeFile(`${p.registry}.corrupt-${Date.now()}`, text).catch(() => {});
    return [];
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
    const list = await load(p);
    await save(change(list), p);
  });

export async function readRegistry(p = paths()) {
  const list = await load(p);
  const live = list.filter((e) => alive(e.pid));
  if (live.length === list.length) return live;
  // Re-read under the lock so a concurrent upsert is not overwritten.
  await modify(p, (cur) => cur.filter((e) => alive(e.pid)));
  return load(p);
}

export const upsertEntry = (e, p = paths()) =>
  modify(p, (list) => [...list.filter((x) => x.agentId !== e.agentId), e]);

export const removeEntry = (agentId, p = paths()) =>
  modify(p, (list) => list.filter((x) => x.agentId !== agentId));

export async function findEntry(agentId, p = paths()) {
  return (await readRegistry(p)).find((e) => e.agentId === agentId) ?? null;
}
