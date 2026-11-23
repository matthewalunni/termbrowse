// `termbrowse <url>`: a Chrome for Testing of its own, drawn in this terminal until you quit.
import { join } from 'node:path';
import { paths } from '../paths.js';
import { loadConfig, effectiveHeadless } from '../config.js';
import { ensureChrome, launchChrome } from '../chrome.js';
import { runHook } from '../hook.js';
import { profileFromStarter } from '../profiles.js';
import { readRegistry, upsertEntry, removeEntry } from '../registry.js';
import { listTargets } from '../cdp.js';
import { runViewer } from '../viewer.js';

const NO_TTY = "termbrowse: this terminal doesn't support Kitty graphics (try Kitty, Ghostty, WezTerm or Herdr)\n";
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
  { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, signals = process } = {},
) {
  // The viewer would refuse a non-terminal anyway; refuse before starting a Chrome for nothing.
  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write(NO_TTY);
    return 2;
  }
  const url = normalizeUrl(input);
  const p = paths(env);
  const cfg = await loadConfig(env);
  const other = (await readRegistry(p)).find((e) => e.kind === 'standalone');
  if (other) {
    stderr.write(`termbrowse: another termbrowse <url> is running (${other.agentId}, pid ${other.wrapperPid}); they share a profile, so quit it first\n`);
    return 1;
  }

  // A signal before the viewer is up: exit at once if no Chrome is starting yet, else clean up below.
  let interrupted = false;
  let chrome = null;
  let launching = false;
  const onSignal = () => {
    interrupted = true;
    if (!chrome && !launching) process.exit(130);
  };
  for (const sig of SIGNALS) signals.on(sig, onSignal);

  const agentId = `standalone-${process.pid}`;
  try {
    const { executablePath } = await ensureChrome(cfg, p);
    const profileDir = await profileFromStarter(join(p.state, 'standalone'), p);
    launching = true;
    try {
      chrome = await launchChrome({
        profileDir,
        url,
        headless: effectiveHeadless(cfg, env),
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
    announce(cfg, chrome); // fire and forget: the viewer must not wait on a hook (runHook never rejects)
    return await runViewer({ port: chrome.port, stdin, stdout, stderr, env, signals });
  } finally {
    for (const sig of SIGNALS) signals.off(sig, onSignal);
    if (chrome) {
      await chrome.kill();
      await removeEntry(agentId, p).catch(() => {});
    }
  }
}

async function announce(cfg, chrome) {
  if (!cfg.hooks.onLaunch) return;
  for (let i = 0; i < 50; i++) {
    const targets = await listTargets(chrome.port).catch(() => []);
    if (targets.some((t) => t.type === 'page')) break;
    await sleep(100);
  }
  await runHook(cfg.hooks.onLaunch, { pid: chrome.pid, port: chrome.port, agent: '', kind: 'standalone' });
}
