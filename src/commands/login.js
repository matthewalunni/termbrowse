// `termbrowse login [url] [--reset]`: a visible Chrome on the starter profile, which new agent
// and standalone profiles are copied from, so sign-ins made here carry over to them.
import { rm } from 'node:fs/promises';
import { paths } from '../paths.js';
import { loadConfig, effectiveHeadless } from '../config.js';
import { launchChrome } from '../chrome.js';
import { listTargets, browserVersion, CdpSession } from '../cdp.js';
import { normalizeUrl } from './browse.js';
import { UsageError, parse } from './usage.js';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const POLL_MS = 500;
const QUIT_GRACE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser.close shuts Chrome down the normal way, so cookies and logins are written to disk.
async function closeBrowser(port) {
  const wsUrl = (await browserVersion(port))?.webSocketDebuggerUrl;
  if (!wsUrl) return;
  try {
    const session = await CdpSession.connect(wsUrl);
    await session.send('Browser.close').catch(() => {});
    session.close();
  } catch {
    // fall through to the caller's kill
  }
}

export async function runLogin(
  args,
  { stdout = process.stdout, stderr = process.stderr, env = process.env, signals = process } = {},
) {
  const { values, positionals } = parse(args, { reset: { type: 'boolean' } });
  if (positionals.length > 1) throw new UsageError(`login: unexpected argument ${positionals[1]}`);
  const p = paths(env);
  const cfg = await loadConfig(env);
  // Always a window, even when headless is configured; only a missing display stops it.
  if (effectiveHeadless({ ...cfg, chrome: { ...cfg.chrome, headless: false } }, env)) {
    stderr.write('termbrowse: login needs a display (set DISPLAY or WAYLAND_DISPLAY) to open a Chrome window\n');
    return 1;
  }
  if (values.reset) {
    await rm(p.starter, { recursive: true, force: true });
    stdout.write(`removed the starter profile ${p.starter}\n`);
  }

  const chrome = await launchChrome({
    profileDir: p.starter,
    url: positionals[0] ? normalizeUrl(positionals[0]) : 'about:blank',
    headless: false,
    windowSize: cfg.chrome.windowSize,
    extraArgs: cfg.chrome.extraArgs,
  });
  stdout.write('Sign in to the sites your agents need, then close the window.\n');

  const exited = new Promise((resolve) => {
    if (chrome.child.exitCode !== null || chrome.child.signalCode !== null) resolve();
    else chrome.child.once('exit', resolve);
  });
  let quit = false;
  const onSignal = () => { quit = true; };
  for (const sig of SIGNALS) signals.on(sig, onSignal);
  try {
    // On macOS closing the last window leaves Chrome running, so "closed" means no pages left.
    for (;;) {
      const gone = await Promise.race([exited.then(() => true), sleep(POLL_MS).then(() => false)]);
      if (gone) break;
      const pages = await listTargets(chrome.port).then((t) => t.filter((x) => x.type === 'page').length, () => null);
      if (quit || pages === 0) {
        await closeBrowser(chrome.port);
        await Promise.race([exited, sleep(QUIT_GRACE_MS)]);
        break;
      }
    }
  } finally {
    for (const sig of SIGNALS) signals.off(sig, onSignal);
    await chrome.kill();
  }
  if (quit) return 130;
  stdout.write('Done. New agent profiles start from this one; existing profiles keep their own sign-ins.\n');
  return 0;
}
