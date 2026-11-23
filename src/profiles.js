import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.js';
import { readRegistry } from './registry.js';

const MARKER = '.termbrowse-last-used';
const SKIP_FILES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort', 'lockfile']);
const SKIP_DIRS = new Set(['Cache', 'Code Cache', 'GPUCache']);

let tmpSeq = 0;

const sanitize = (id) => {
  const s = String(id).replace(/[^A-Za-z0-9._-]/g, '_');
  return s === '' || s === '.' || s === '..' ? '_' : s;
};

async function copyFilter(src) {
  const name = path.basename(src);
  if (SKIP_FILES.has(name)) return false;
  if (SKIP_DIRS.has(name)) {
    const st = await fs.lstat(src).catch(() => null);
    if (st?.isDirectory()) return false;
  }
  return true;
}

export const agentProfile = (agentId, p = paths()) => profileFromStarter(path.join(p.profiles, sanitize(agentId)), p);

// `termbrowse <url>` gets a fresh starter copy per run, named after the process that owns it.
const STANDALONE = /^standalone-(\d+)$/;
export const standaloneProfileDir = (pid, p = paths()) => path.join(p.profiles, `standalone-${pid}`);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Ensures `dir` exists as a Chrome profile, copied from the starter profile the first time
// (when there is one), and marks it used now.
export async function profileFromStarter(dir, p = paths()) {
  const exists = await fs.stat(dir).then(() => true, () => false);
  if (!exists) {
    const hasStarter = await fs.stat(p.starter).then((s) => s.isDirectory(), () => false);
    if (hasStarter) {
      // Copy aside, then rename into place, so a concurrent caller (e.g. a second wrapper
      // for the same agent) never sees or uses a half-copied profile.
      const tmp = `${dir}.tmp-${process.pid}-${++tmpSeq}`;
      try {
        await fs.cp(p.starter, tmp, { recursive: true, filter: copyFilter });
        await fs.rename(tmp, dir);
      } catch (e) {
        if (e.code !== 'EEXIST' && e.code !== 'ENOTEMPTY') throw e;
        // another caller won the race; its copy is complete
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
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
    const standalone = STANDALONE.exec(id);
    if (standalone && Number(standalone[1]) > 0 && !pidAlive(Number(standalone[1]))) {
      // Left behind by a run that died: it was only ever a copy, so age does not matter.
      await fs.rm(path.join(p.profiles, id), { recursive: true, force: true });
      removed.push(id);
      continue;
    }
    const st = await fs.stat(path.join(p.profiles, id, MARKER)).catch(() => null);
    if (!st || now - st.mtimeMs <= days * 86400_000) continue;
    await fs.rm(path.join(p.profiles, id), { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}
