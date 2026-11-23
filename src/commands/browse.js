// `termbrowse <url>`: a Chrome for Testing of its own, drawn in this terminal until you quit.
// Each run starts from a fresh copy of the starter profile, deleted afterwards: sign-ins that
// should last are made with `termbrowse login`.
import { rm } from 'node:fs/promises';
import { paths } from '../paths.js';
import { loadConfig, effectiveHeadless } from '../config.js';
import { ensureChrome, launchChrome } from '../chrome.js';
import { runHook } from '../hook.js';
import { profileFromStarter, standaloneProfileDir, pruneProfiles } from '../profiles.js';
import { upsertEntry, removeEntry } from '../registry.js';
import { listTargets } from '../cdp.js';
import { runViewer, NO_KITTY } from '../viewer.js';
import { detectKitty } from '../tty.js';
import { resolveFill } from './fill.js';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeUrl(input) {
  const s = String(input).trim();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|blob|javascript|view-source|chrome):/i.test(s)) return s;
  return `https://${s}`;
}

export async function runBrowse(
  input,
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    signals = process,
    pid = process.pid, // names this run's registry entry and profile
    fill: fillOverride, // --fill (true) / --no-fill (false); undefined: from the config
  } = {},
) {
  // The viewer would refuse a terminal it can't draw in anyway; refuse before downloading or
  // starting a Chrome for nothing.
  if (!stdout.isTTY || !stdin.isTTY || !(await detectKitty(stdin, stdout, 800, env))) {
    stderr.write(NO_KITTY);
    return 2;
  }
  const url = normalizeUrl(input);
  const p = paths(env);
  const cfg = await loadConfig(env);
  await pruneProfiles(cfg.agents.pruneDays, p).catch((err) => stderr.write(`termbrowse: pruning profiles failed: ${err.message}\n`));

  // A signal before the viewer is up: exit at once if no Chrome is starting yet, else clean up
  // below. One that lands while the viewer starts (its own handlers are not attached until its
  // terminal queries and CDP connect are done) is passed on to the viewer once they are.
  let interrupted = null; // the signal, once one arrived
  let chrome = null;
  let launching = false;
  const onSignal = (sig) => {
    interrupted ??= sig;
    if (!chrome && !launching) process.exit(130);
  };
  const handlers = SIGNALS.map((sig) => [sig, () => onSignal(sig)]);
  for (const [sig, fn] of handlers) signals.on(sig, fn);
  // EIO/EPIPE once the terminal is gone (SIGHUP) must not crash before Chrome and the profile are cleaned up.
  const onStdoutError = () => {};
  stdout.on('error', onStdoutError);

  const headless = effectiveHeadless(cfg, env);
  const agentId = `standalone-${pid}`;
  const profileDir = standaloneProfileDir(pid, p);
  try {
    const { executablePath } = await ensureChrome(cfg, p);
    // Fresh every run, even if a crashed run with a since-reused pid left this dir behind.
    await rm(profileDir, { recursive: true, force: true });
    await profileFromStarter(profileDir, p);
    launching = true;
    try {
      chrome = await launchChrome({
        profileDir,
        url,
        headless,
        background: cfg.chrome.background,
        windowSize: cfg.chrome.windowSize,
        extraArgs: cfg.chrome.extraArgs,
        executablePath,
      });
    } catch (err) {
      stderr.write(`termbrowse: could not start Chrome: ${err.message}\n`);
      return 1;
    } finally {
      launching = false;
    }
    // wrapperPid: if this process dies without cleaning up, the registry's orphan sweep closes this Chrome.
    await upsertEntry(
      { agentId, pid: chrome.pid, port: chrome.port, profileDir, kind: 'standalone', startedAt: new Date().toISOString(), wrapperPid: process.pid },
      p,
    ).catch((err) => stderr.write(`termbrowse: could not record Chrome in the registry: ${err.message}\n`));
    if (interrupted) return 130;
    announce(cfg, chrome, headless); // fire and forget: the viewer must not wait on a hook (runHook never rejects)
    return await runViewer({
      port: chrome.port,
      stdin,
      stdout,
      stderr,
      env,
      signals,
      fill: resolveFill({ kind: 'standalone', ...cfg.view, flag: fillOverride }),
      // Signals after this point reach the viewer directly; replay one it could not see.
      onReady: () => { if (interrupted) signals.emit(interrupted, interrupted); },
    });
  } finally {
    for (const [sig, fn] of handlers) signals.off(sig, fn);
    if (chrome) {
      await chrome.kill();
      await removeEntry(agentId, p).catch(() => {});
    }
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    stdout.off('error', onStdoutError);
  }
}

async function announce(cfg, chrome, headless) {
  if (!cfg.hooks.onLaunch) return;
  for (let i = 0; i < 50; i++) {
    const targets = await listTargets(chrome.port).catch(() => []);
    if (targets.some((t) => t.type === 'page')) break;
    await sleep(100);
  }
  await runHook(cfg.hooks.onLaunch, { pid: chrome.pid, port: chrome.port, agent: '', kind: 'standalone', headless });
}
