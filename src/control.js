// Per-agent control file: who holds the agent's browser (the user in a viewer, or nobody).
// One small JSON file per agent under <state>/control/. Every write is a read-modify-write under
// the registry lock (withLock), so concurrent viewer and MCP-wrapper updates don't lose fields;
// the file itself is replaced atomically (tmp + rename) so unlocked readers never see a torn file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, ensureStateDir, controlPath } from './paths.js';
import { alive, withLock } from './registry.js';

export { controlPath };

async function load(file) {
  try {
    const d = JSON.parse(await fs.readFile(file, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch {
    return null; // missing or corrupt: treated as never controlled
  }
}

async function save(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

const blank = () => ({ holder: null, takeovers: 0, lastTakeover: null, agentBusySince: null });

// Read-modify-write under the lock. mutate(state) returns the new state, or null for no change.
async function update(agentId, p, mutate) {
  const file = controlPath(agentId, p);
  await withLock(p, async () => {
    const next = mutate((await load(file)) ?? blank());
    if (next) await save(file, next);
  });
}

const closed = (c, until, url) => ({
  ...c, holder: null, viewerPid: null, lastTakeover: { since: c.since, until, url: url ?? c.url ?? null },
});

const taken = (c, { viewerPid, url, idleReturnMs }, now) => ({
  ...c, holder: 'user', viewerPid, url, idleReturnMs, since: now, lastInput: now, takeovers: (c.takeovers ?? 0) + 1,
});

export async function takeControl(agentId, { viewerPid, url, idleReturnMs }, p = paths()) {
  await ensureStateDir(p);
  const now = Date.now();
  await update(agentId, p, (c) => {
    const heldNow = c.holder === 'user' && alive(c.viewerPid) && now - c.lastInput <= c.idleReturnMs;
    if (heldNow) return { ...c, viewerPid, url, idleReturnMs, lastInput: now };
    return taken(c, { viewerPid, url, idleReturnMs }, now);
  });
}

// The viewer still holds control and the user acted. If the file was released under it (the
// wrapper read it as idle, or it was removed), the user takes control again: a new takeover.
export const touchControl = (agentId, holder, p = paths()) => {
  const now = Date.now();
  return update(agentId, p, (c) => (c.holder === 'user' ? { ...c, lastInput: now } : taken(c, holder, now)));
};

// until: when the takeover ended (e.g. the last input, for an idle hand-back); default now.
export const releaseControl = (agentId, { url, until } = {}, p = paths()) =>
  update(agentId, p, (c) => (c.holder === 'user' ? closed(c, Math.max(until ?? Date.now(), c.since ?? 0), url) : null));

export async function readControl(agentId, p = paths(), now = Date.now()) {
  const file = controlPath(agentId, p);
  const view = (c) => ({
    held: c.holder === 'user', takeovers: c.takeovers ?? 0,
    lastTakeover: c.lastTakeover ?? null, agentBusySince: c.agentBusySince ?? null,
  });
  const stale = (c) => c.holder === 'user' && (!alive(c.viewerPid) || now - c.lastInput > c.idleReturnMs);
  const c = await load(file);
  if (!c) return view(blank());
  if (!stale(c)) return view(c);
  // Viewer gone or user idle: hand back, remembering the takeover ended at the last input.
  let out = c;
  await update(agentId, p, (cur) => {
    out = stale(cur) ? closed(cur, cur.lastInput) : cur;
    return out === cur ? null : out;
  });
  return view(out);
}

export const setAgentBusy = (agentId, busy, p = paths()) =>
  update(agentId, p, (c) => ({ ...c, agentBusySince: busy ? Date.now() : null }));
