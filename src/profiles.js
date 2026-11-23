import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, ensureStateDir } from './paths.js';
import { readRegistry, alive as pidAlive } from './registry.js';

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
// An agent known only by its parent pid (no TERMBROWSE_AGENT, no Herdr) can't come back once
// that process is gone, so its profile goes with it too.
const PID_NAMED = /^(?:standalone|pid)-(\d+)$/;
export const standaloneProfileDir = (pid, p = paths()) => path.join(p.profiles, `standalone-${pid}`);

// Ensures `dir` exists as a Chrome profile, copied from the starter profile the first time
// (when there is one), and marks it used now.
export async function profileFromStarter(dir, p = paths()) {
  await ensureStateDir(p);
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

const CHROME_LOG = /^chrome-(?:starting-\d+-\d+|(\d+))\.log$/;
const TMP_COPY = /\.tmp-\d+-\d+$/; // profileFromStarter's copy in progress
const TMP_COPY_STALE_MS = 3600_000;

// Chrome's logs (chrome-<pid>.log, chrome-starting-<pid>-<port>.log) unchanged for `days`,
// unless that Chrome still runs.
async function pruneLogs(days, p, now) {
  const names = await fs.readdir(p.logs).catch(() => []);
  for (const name of names) {
    const m = CHROME_LOG.exec(name);
    if (!m || (m[1] && pidAlive(Number(m[1])))) continue;
    const file = path.join(p.logs, name);
    const st = await fs.stat(file).catch(() => null);
    if (st && now - st.mtimeMs > days * 86400_000) await fs.rm(file, { force: true });
  }
}

export async function pruneProfiles(days, p = paths(), now = Date.now()) {
  await pruneLogs(days, p, now);
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
    if (TMP_COPY.test(id)) {
      // Left by a copy that was killed midway; a copy still running is younger than this.
      const st = await fs.stat(path.join(p.profiles, id)).catch(() => null);
      if (st && now - st.mtimeMs > TMP_COPY_STALE_MS) await fs.rm(path.join(p.profiles, id), { recursive: true, force: true });
      continue;
    }
    if (liveIds.has(id)) continue;
    const owner = PID_NAMED.exec(id);
    if (owner && !pidAlive(Number(owner[1]))) {
      // Its process is gone and nothing can ask for this profile again, so age does not matter.
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
