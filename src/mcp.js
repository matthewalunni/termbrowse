// `termbrowse mcp`: runs the pinned chrome-devtools-mcp against this agent's own Chrome for
// Testing and proxies newline-delimited JSON-RPC between the agent and it.
//
// Chrome starts lazily. chrome-devtools-mcp 1.13.0 only connects to --browserUrl when a tool
// runs (checked: with nothing listening it still answers initialize and tools/list), so the
// child starts at once and Chrome is launched just before the first tools/call is forwarded.
//
// While the user holds control of this agent's browser in a viewer (control.js), tools/call
// requests wait here, unforwarded; other messages still pass. The first result after a takeover
// carries a note telling the agent the page may have changed.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { paths, controlPath } from './paths.js';
import { loadConfig, effectiveHeadless } from './config.js';
import { freePort, launchChrome } from './chrome.js';
import { runHook } from './hook.js';
import { agentProfile, pruneProfiles } from './profiles.js';
import { findEntry, upsertEntry, removeEntry } from './registry.js';
import { listTargets } from './cdp.js';
import { agentId } from './agent-id.js';
import * as controlFile from './control.js';

const require = createRequire(import.meta.url);
const STOP_GRACE_MS = 2000; // after stdin ends, before SIGTERM
const KILL_GRACE_MS = 3000; // after SIGTERM, before SIGKILL
const CONTROL_POLL_MS = 1000; // fallback re-check of the control file while a call waits
const WAIT_ERROR = { code: -32000, message: 'termbrowse: the user has control of the browser; try again later' };

const log = (msg) => process.stderr.write(`termbrowse mcp: ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mcpBin() {
  const pkgFile = require.resolve('chrome-devtools-mcp/package.json');
  const { bin } = require(pkgFile);
  return join(dirname(pkgFile), typeof bin === 'string' ? bin : bin['chrome-devtools-mcp']);
}

// Calls onLine with each complete line (newline included); a chunk may hold part of a line or many.
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i + 1));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

const isToolsCall = (msg) => (Array.isArray(msg) ? msg : [msg]).some((m) => m?.method === 'tools/call');
const isResponse = (m) => m && typeof m === 'object' && m.method === undefined && m.id !== undefined && ('result' in m || 'error' in m);

export const formatDuration = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s >= 600) return `${Math.round(s / 60)} min`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
};

// durationMs: from the takeover to when the agent got the browser back. waitedMs: how long this
// call was held (when waited). how/activeMs: an idle or dead-viewer return says when the user's
// last input was, so the agent knows the page sat untouched after it.
export const takeoverNote = ({ durationMs, waited, waitedMs, url, tabsChanged, how = 'handback', activeMs }) => {
  const why = waited ? `while you waited${waitedMs ? `, ${formatDuration(waitedMs)}` : ''}` : 'since your last action';
  const active = activeMs ?? durationMs;
  const lastInput = active < 1000 ? 'Their last input was in the first second' : `Their last input was ${formatDuration(active)} in`;
  let ended = '';
  if (how === 'idle') {
    ended = ` ${lastInput}; control came back automatically after ${formatDuration(durationMs - active)} with no input.`;
  } else if (how === 'viewer-gone') {
    ended = ` Their viewer closed without handing back. ${lastInput}.`;
  }
  return `Note from termbrowse: the user took control of this browser for ${formatDuration(durationMs)} (${why}).${ended}`
    + ` The page may have changed; it is now at ${url}. Re-check the page (e.g. take a snapshot) before continuing.`
    + (tabsChanged ? ' The user changed tabs; call list_pages and select_page before continuing.' : '');
};

// Adds the note to one response object: a text item on result.content, or, on a JSON-RPC error
// (which has no content), error.data.note with the error otherwise unchanged.
function addNote(m, note) {
  if (m.error && typeof m.error === 'object') {
    const { data } = m.error;
    m.error.data = data && typeof data === 'object' && !Array.isArray(data) ? { ...data, note } : { ...(data !== undefined && { value: data }), note };
  } else if (m.result && typeof m.result === 'object') {
    m.result.content = [...(Array.isArray(m.result.content) ? m.result.content : []), { type: 'text', text: note }];
  }
}

export function appendNote(responseLine, note) {
  const msg = parse(responseLine);
  if (!isResponse(msg)) return responseLine;
  addNote(msg, note);
  return `${JSON.stringify(msg)}${responseLine.endsWith('\n') ? '\n' : ''}`;
}

// chrome-devtools-mcp's new_page defaults to background: false, which brings the tab to the
// front and activates Chrome (a window manager then jumps to its workspace). When the agent
// leaves `background` unset, set it to true. Only the modified line is re-serialized; anything
// unparsable or untouched is returned as it came.
export function backgroundNewPages(line) {
  const msg = parse(line);
  if (msg === undefined || msg === null) return line;
  let changed = false;
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    if (m?.method !== 'tools/call' || m.params?.name !== 'new_page') continue;
    const args = m.params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args) || args.background !== undefined) continue;
    m.params.arguments = { ...args, background: true };
    changed = true;
  }
  if (!changed) return line;
  return `${JSON.stringify(msg)}${line.endsWith('\n') ? '\n' : ''}`;
}

export async function runMcp(
  extraArgs = [],
  {
    stdin = process.stdin,
    stdout = process.stdout,
    env = process.env,
    mcpBin: bin = mcpBin(),
    stopGraceMs = STOP_GRACE_MS,
    killGraceMs = KILL_GRACE_MS,
    control: { readControl, setAgentBusy } = controlFile, // injectable for tests
  } = {},
) {
  const id = agentId(env);
  const p = paths(env);
  const cfg = await loadConfig(env);
  await pruneProfiles(cfg.agents.pruneDays, p).catch((e) => log(`pruning profiles failed: ${e.message}`));

  // Another wrapper for this agent (e.g. an MCP restart overlapping the old one) may own a live
  // Chrome: share its port. Otherwise pick a port now; chrome-devtools-mcp is pinned to it.
  const existing = await findEntry(id, p);
  const port = existing?.port ?? (await freePort());
  let chrome = null; // the Chrome this wrapper launched, while it is alive
  const headless = effectiveHeadless(cfg, env);
  // Same condition as the background launch (see launchPlan in chrome.js).
  const backgroundTabs = cfg.chrome.background && !headless && process.platform === 'darwin';

  // Control. A failed read (e.g. a stuck lock) counts as released: an agent is never blocked by it.
  const control = () => readControl(id, p).catch((err) => {
    log(`could not read the control file: ${err.message}`);
    return null;
  });
  // Takeovers counted so far, so each is reported once. Starts from the file, so a takeover from
  // before this wrapper isn't news to a fresh agent (one still in progress is, once it ends).
  let reported = null;
  const baseline = (c) => {
    if (reported === null) reported = c.held ? c.takeovers - 1 : c.takeovers;
  };
  const initial = await control();
  if (initial) baseline(initial);
  let busyChain = Promise.resolve();
  const setBusy = (busy) =>
    (busyChain = busyChain.then(() => setAgentBusy(id, busy, p)).catch((err) => log(`could not update the control file: ${err.message}`)));

  // The page the agent is on now (Chrome lists the most recently active tab first), else where
  // the user left it.
  async function noteUrl(takeover) {
    const targets = await listTargets(port).catch(() => []);
    return targets.find((t) => t.type === 'page')?.url ?? takeover.url ?? 'an unknown page';
  }

  // The note for a tools/call response, if a takeover ended since the last one reported.
  async function takeoverNoteNow(waitedMs) {
    const c = await control();
    if (!c) return null;
    if (reported === null) {
      baseline(c);
      return null;
    }
    if (c.held) return null; // the user took control mid-call: told once it ends
    if (c.takeovers < reported) reported = 0; // the file was removed and started over
    if (c.takeovers <= reported || !c.lastTakeover) return null;
    // A takeover since the last report changed tabs, even if a later one didn't.
    const tabsChanged = !!c.lastTakeover.tabsChanged || (c.tabsChangedAt ?? 0) > reported;
    reported = c.takeovers;
    const t = c.lastTakeover;
    const end = t.returnedAt ?? t.until; // a file from before returnedAt existed
    return takeoverNote({
      durationMs: end - t.since, waited: waitedMs !== null, waitedMs, url: await noteUrl(t), tabsChanged,
      how: t.how ?? 'handback', activeMs: t.until - t.since,
    });
  }

  async function announce(c) {
    if (!cfg.hooks.onLaunch) return;
    for (let i = 0; i < 50; i++) {
      const targets = await listTargets(c.port).catch(() => []);
      if (targets.some((t) => t.type === 'page')) break;
      await sleep(100);
    }
    await runHook(cfg.hooks.onLaunch, { pid: c.pid, port: c.port, agent: id, kind: 'agent', headless });
  }

  async function ensureChrome() {
    if (chrome) return;
    const e = await findEntry(id, p);
    if (e?.port === port) return; // the other wrapper's Chrome is up on our port
    if (e) throw new Error(`agent ${id} already has a Chrome on port ${e.port} (wrapper pid ${e.wrapperPid})`);
    const profileDir = await agentProfile(id, p);
    const c = await launchChrome({
      profileDir,
      headless,
      background: cfg.chrome.background,
      windowSize: cfg.chrome.windowSize,
      extraArgs: cfg.chrome.extraArgs,
      port,
    });
    chrome = c;
    c.child.once('exit', () => {
      if (chrome === c) chrome = null; // the next tools/call relaunches
    });
    await upsertEntry(
      { agentId: id, pid: c.pid, port, profileDir, kind: 'agent', startedAt: new Date().toISOString(), wrapperPid: process.pid },
      p,
    ).catch((err) => log(`could not record Chrome in the registry: ${err.message}`));
    announce(c); // fire and forget: a slow hook must not hold up the tool call (runHook never rejects)
  }

  const child = spawn(process.execPath, [bin, '--browserUrl', `http://127.0.0.1:${port}`, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
  const childExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (err) => {
      log(`could not start chrome-devtools-mcp: ${err.message}`);
      resolve({ code: 1, signal: null });
    });
  });
  child.stdin.on('error', () => {}); // EPIPE if the child is gone; its exit is handled above
  const onStdoutError = () => {};
  stdout.on('error', onStdoutError);

  // Output: whole lines only, so a reply we write ourselves never lands inside one of the child's.
  // Lines go out in order through one chain, since a tools/call response first waits for the
  // control file (busy flag, takeover note).
  const inFlight = new Map(); // forwarded tools/call id -> ms it waited for the user, or null
  let outChain = Promise.resolve();
  const emit = (fn) => {
    outChain = outChain.then(fn).catch((err) => log(`output failed: ${err.message}`));
  };
  const out = (line) => emit(() => stdout.write(line));
  const reply = (id_, error) => out(`${JSON.stringify({ jsonrpc: '2.0', id: id_, error })}\n`);

  async function fromChild(line) {
    const msg = parse(line);
    const done = (Array.isArray(msg) ? msg : [msg]).filter((m) => isResponse(m) && inFlight.has(m.id));
    if (!done.length) return stdout.write(line);
    let waitedMs = null;
    for (const m of done) {
      const w = inFlight.get(m.id);
      if (w !== null) waitedMs = Math.max(waitedMs ?? 0, w);
      inFlight.delete(m.id);
    }
    if (!inFlight.size) await setBusy(false);
    const note = await takeoverNoteNow(waitedMs);
    if (!note) return stdout.write(line);
    if (!Array.isArray(msg)) return stdout.write(appendNote(line, note));
    addNote(done[0], note);
    return stdout.write(`${JSON.stringify(msg)}\n`);
  }
  const output = lineSplitter((line) => emit(() => fromChild(line)));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => output.push(d));
  child.stdout.on('end', () => output.flush());

  // Input: forwarded strictly in order; while Chrome starts, later lines wait in the queue.
  const queue = [];
  let pumping = null;
  let held = null; // the tools/call waiting for the user: { id, cancelled, wake }
  let inputEnded = false;
  let stopping = false;
  let killedByUs = false;
  let killTimer;

  function stop() {
    if (stopping) return;
    stopping = true;
    held?.wake();
    child.stdin.end();
    killTimer = setTimeout(() => {
      killedByUs = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, stopGraceMs);
  }

  // Writes a line to the child. A cancellation of a call already forwarded ends it for us too:
  // the child sends no response for a request it cancelled, so the busy flag is cleared here.
  function toChild(line, msg) {
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m?.method !== 'notifications/cancelled' || !inFlight.delete(m.params?.requestId)) continue;
      if (!inFlight.size) setBusy(false);
    }
    child.stdin.write(line);
  }

  const callIds = (msg) => (Array.isArray(msg) ? msg : [msg]).filter((m) => m?.method === 'tools/call' && m.id !== undefined).map((m) => m.id);

  // A line that need not wait behind a held call. A cancellation of a call that hasn't been
  // forwarded drops that call (it never gets a reply, per MCP) and isn't forwarded itself.
  function passNow(line, msg) {
    if (msg?.method === 'notifications/cancelled' && msg.params?.requestId !== undefined) {
      const rid = msg.params.requestId;
      if (held && held.id === rid) {
        held.cancelled = true;
        held.wake();
        return;
      }
      const i = queue.findIndex((l) => {
        const m = parse(l);
        return m?.method === 'tools/call' && m.id === rid;
      });
      if (i >= 0) {
        queue.splice(i, 1);
        return;
      }
    }
    toChild(line, msg);
  }

  // Waits while the user holds control. Resolves 'free' (never held), 'waited' (released),
  // 'cancelled', 'ended' (input closed or stopping) or 'timeout' (max_wait). waitStart is set to
  // when the wait began.
  let waitStart = 0;
  async function untilReleased(msg) {
    if (!(await control())?.held) return 'free';
    const start = Date.now();
    waitStart = start;
    const h = { id: Array.isArray(msg) ? undefined : msg.id, cancelled: false, wake: () => {} };
    held = h;
    // Lines already queued behind this call that need not wait go now.
    const rest = queue.splice(0);
    for (const l of rest) {
      const m = parse(l);
      if (m !== undefined && isToolsCall(m)) queue.push(l);
      else passNow(l, m);
    }
    let watcher = null;
    try {
      watcher = watch(dirname(controlPath(id, p)), () => h.wake());
      watcher.on('error', () => {});
    } catch {
      // the 1 s poll still notices
    }
    try {
      for (;;) {
        const left = cfg.control.maxWaitMs - (Date.now() - start);
        if (h.cancelled) return 'cancelled';
        if (stopping || inputEnded) return 'ended';
        if (left <= 0) return 'timeout';
        let timer;
        await new Promise((r) => {
          h.wake = r;
          timer = setTimeout(r, Math.min(CONTROL_POLL_MS, left));
        });
        clearTimeout(timer);
        if (h.cancelled) return 'cancelled';
        if (!(await control())?.held) return 'waited';
      }
    } finally {
      held = null;
      watcher?.close();
    }
  }

  async function drain() {
    while (queue.length && !stopping) {
      const line = queue.shift();
      const msg = parse(line);
      const call = msg !== undefined && isToolsCall(msg);
      let waitedMs = null;
      if (call) {
        const r = await untilReleased(msg);
        if (r === 'cancelled' || r === 'ended') continue;
        if (r === 'timeout') {
          for (const cid of callIds(msg)) reply(cid, WAIT_ERROR);
          continue;
        }
        if (r === 'waited') waitedMs = Date.now() - waitStart;
        try {
          await ensureChrome();
        } catch (err) {
          log(`could not start Chrome: ${err.message}`);
          if (!Array.isArray(msg)) {
            // A notification (no id) gets no reply, even an error; it is dropped.
            if (msg.id !== undefined) reply(msg.id, { code: -32000, message: `termbrowse: could not start Chrome: ${err.message}` });
            continue;
          }
          // A batch goes through anyway; chrome-devtools-mcp reports the missing browser per call.
        }
      }
      if (call) {
        const ids = callIds(msg);
        if (ids.length && !inFlight.size) await setBusy(true);
        for (const cid of ids) inFlight.set(cid, waitedMs);
      }
      toChild(backgroundTabs && msg !== undefined ? backgroundNewPages(line) : line, msg);
    }
  }
  function pump() {
    if (pumping) return;
    pumping = drain().finally(() => {
      pumping = null;
      if (queue.length && !stopping) pump();
      else if (inputEnded) stop();
    });
  }

  const input = lineSplitter((line) => {
    if (held) {
      const msg = parse(line);
      if (msg === undefined || !isToolsCall(msg)) return passNow(line, msg);
    }
    queue.push(line);
    pump();
  });
  const onData = (chunk) => input.push(chunk);
  const onEnd = () => {
    input.flush();
    inputEnded = true;
    held?.wake();
    if (!pumping) stop();
  };
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  // SIGHUP: closing the agent's terminal pane hangs up its foreground process group, us included.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stop);

  const { code } = await childExit;
  clearTimeout(killTimer);
  const stopRequested = stopping;
  stopping = true;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(sig, stop);
  stdin.off('data', onData);
  stdin.off('end', onEnd);
  stdin.pause();
  await pumping; // a launch in flight finishes, so its Chrome is closed below too
  await outChain;

  if (chrome) {
    const c = chrome;
    const e = await findEntry(id, p).catch(() => null);
    await c.kill();
    if (!e || e.pid === c.pid) await removeEntry(id, p).catch((err) => log(`could not update the registry: ${err.message}`));
  }
  stdout.off('error', onStdoutError);
  if (killedByUs || (stopRequested && code === null)) return 0;
  return code ?? 1;
}
