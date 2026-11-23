// `termbrowse mcp`: runs the pinned chrome-devtools-mcp against this agent's own Chrome for
// Testing and proxies newline-delimited JSON-RPC between the agent and it.
//
// Chrome starts lazily. chrome-devtools-mcp 1.13.0 only connects to --browserUrl when a tool
// runs (checked: with nothing listening it still answers initialize and tools/list), so the
// child starts at once and Chrome is launched just before the first tools/call is forwarded.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { paths } from './paths.js';
import { loadConfig, effectiveHeadless } from './config.js';
import { freePort, launchChrome } from './chrome.js';
import { runHook } from './hook.js';
import { agentProfile, pruneProfiles } from './profiles.js';
import { findEntry, upsertEntry, removeEntry } from './registry.js';
import { listTargets } from './cdp.js';
import { agentId } from './agent-id.js';

const require = createRequire(import.meta.url);
const STOP_GRACE_MS = 2000; // after stdin ends, before SIGTERM
const KILL_GRACE_MS = 3000; // after SIGTERM, before SIGKILL

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

export async function runMcp(
  extraArgs = [],
  {
    stdin = process.stdin,
    stdout = process.stdout,
    env = process.env,
    mcpBin: bin = mcpBin(),
    stopGraceMs = STOP_GRACE_MS,
    killGraceMs = KILL_GRACE_MS,
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
  const out = (line) => stdout.write(line);
  const output = lineSplitter(out);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => output.push(d));
  child.stdout.on('end', () => output.flush());

  // Input: forwarded strictly in order; while Chrome starts, later lines wait in the queue.
  const queue = [];
  let pumping = null;
  let inputEnded = false;
  let stopping = false;
  let killedByUs = false;
  let killTimer;

  function stop() {
    if (stopping) return;
    stopping = true;
    child.stdin.end();
    killTimer = setTimeout(() => {
      killedByUs = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    }, stopGraceMs);
  }

  async function drain() {
    while (queue.length && !stopping) {
      const line = queue.shift();
      const msg = parse(line);
      if (msg !== undefined && isToolsCall(msg)) {
        try {
          await ensureChrome();
        } catch (err) {
          log(`could not start Chrome: ${err.message}`);
          if (!Array.isArray(msg)) {
            // A notification (no id) gets no reply, even an error; it is dropped.
            if (msg.id !== undefined) {
              out(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `termbrowse: could not start Chrome: ${err.message}` } })}\n`);
            }
            continue;
          }
          // A batch goes through anyway; chrome-devtools-mcp reports the missing browser per call.
        }
      }
      child.stdin.write(line);
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
    queue.push(line);
    pump();
  });
  const onData = (chunk) => input.push(chunk);
  const onEnd = () => {
    input.flush();
    inputEnded = true;
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
