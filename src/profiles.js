import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.js';
import { readRegistry } from './registry.js';

const MARKER = '.termbrowse-last-used';
const SKIP_FILES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', 'lockfile']);
const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache']);

const sanitize = (id) => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

async function copyFilter(src) {
  const name = path.basename(src);
  if (SKIP_FILES.has(name)) return false;
  if (SKIP_DIRS.has(name)) {
    const st = await fs.lstat(src).catch(() => null);
    if (st?.isDirectory()) return false;
  }
  return true;
}

export async function agentProfile(agentId, p = paths()) {
  const dir = path.join(p.profiles, sanitize(agentId));
  const exists = await fs.stat(dir).then(() => true, () => false);
  if (!exists) {
    const hasStarter = await fs.stat(p.starter).then((s) => s.isDirectory(), () => false);
    if (hasStarter) {
      await fs.cp(p.starter, dir, { recursive: true, filter: copyFilter });
    } else {
      await fs.mkdir(dir, { recursive: true });
    }
  }
  const now = new Date();
  const marker = path.join(dir, MARKER);
  await fs.writeFile(marker, '', { flag: 'a' });
  await fs.utimes(marker, now, now);
  return dir;
}

export async function pruneProfiles(days, p = paths(), now = Date.now()) {
  let names;
  try {
    names = await fs.readdir(p.profiles);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const liveIds = new Set((await readRegistry(p)).map((e) => sanitize(e.agentId)));
  const removed = [];
  for (const id of names) {
    if (liveIds.has(id)) continue;
    const st = await fs.stat(path.join(p.profiles, id, MARKER)).catch(() => null);
    if (!st || now - st.mtimeMs <= days * 86400_000) continue;
    await fs.rm(path.join(p.profiles, id), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}
