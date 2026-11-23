// `termbrowse login [url] [--reset]`: a visible Chrome on the starter profile, which new agent
// and standalone profiles are copied from, so sign-ins made here carry over to them.
import { rm } from 'node:fs/promises';
import { paths } from '../paths.js';
import { loadConfig, effectiveHeadless } from '../config.js';
import { launchChrome } from '../chrome.js';
import { listTargets, browserVersion, CdpSession } from '../cdp.js';
import { normalizeUrl } from './browse.js';
import { UsageError, parse } from './usage.js';

const POLL_MS = 500;
const CLOSE_GRACE_MS = 10_000;
// Chrome writes cookies to disk on a ~30 s timer, not when it quits: a sign-in made just
// before quitting is lost unless Chrome keeps running past the next write (checked by hand:
// a cookie set 3 s before Browser.close or SIGTERM never reached the Cookies file; after 35 s it had).
const SAVE_DELAY_MS = 35_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser.close shuts Chrome down the normal way.
async function closeBrowser(port) {
  const wsUrl = (await browserVersion(port))?.webSocketDebuggerUrl;
  if (!wsUrl) return;
  try {
    const session = await CdpSession.connect(wsUrl);
    await session.send('Browser.close').catch(() => {});
    session.close();
  } catch {
    // the caller kills it
  }
}

export async function runLogin(
  args,
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    signals = process,
    saveDelayMs = SAVE_DELAY_MS,
    chromeOptions = {}, // extra launchChrome options (tests run it headless)
  } = {},
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
    ...chromeOptions,
  });
  const exited = new Promise((resolve) => {
    if (chrome.child.exitCode !== null || chrome.child.signalCode !== null) resolve();
    else chrome.child.once('exit', resolve);
  });

  // Every way to finish feeds one queue of events: enter, closed (no pages left), exited,
  // sigint, quit (SIGTERM/SIGHUP: the terminal is going away, so no time to save).
  let wake;
  const events = [];
  const emit = (e) => { events.push(e); wake?.(); };
  const next = (ms) => {
    if (events.length) return Promise.resolve(events.shift());
    return new Promise((resolve) => {
      const timer = ms === undefined ? null : setTimeout(() => { wake = null; resolve('timeout'); }, ms);
      wake = () => { wake = null; clearTimeout(timer); resolve(events.shift()); };
    });
  };
  const onData = (chunk) => { if (String(chunk).includes('\n') || String(chunk).includes('\r')) emit('enter'); };
  const onInt = () => emit('sigint');
  const onQuit = () => emit('quit');
  exited.then(() => emit('exited'));
  let polling = true;
  (async () => {
    let seenPage = false; // a Chrome still starting may list no pages yet
    while (polling) {
      await sleep(POLL_MS);
      if (!polling) break;
      // On macOS closing the last window leaves Chrome running, so "closed" means no pages left.
      const pages = await listTargets(chrome.port).then((t) => t.filter((x) => x.type === 'page').length, () => null);
      if (pages > 0) seenPage = true;
      if (pages === 0 && seenPage) { emit('closed'); break; }
    }
  })();
  const wasFlowing = stdin.readableFlowing === true;
  stdin.on('data', onData);
  stdin.resume();
  signals.on('SIGINT', onInt);
  for (const sig of ['SIGTERM', 'SIGHUP']) signals.on(sig, onQuit);

  let code = 0;
  try {
    stdout.write('Sign in to the sites your agents need, then press Enter here (or close the browser window).\n');
    const first = await next();
    polling = false;
    if (first === 'quit') {
      code = 130;
    } else if (first !== 'exited') {
      stdout.write('Saving your sign-ins…\n');
      const end = Date.now() + saveDelayMs;
      let asked = false;
      for (;;) {
        const left = end - Date.now();
        if (left <= 0) break;
        const e = await next(left);
        if (e === 'timeout' || e === 'exited') break;
        if (e === 'quit' || (e === 'sigint' && asked)) {
          stderr.write('termbrowse: quitting now; recent sign-ins may not be saved\n');
          code = 130;
          break;
        }
        if (e === 'sigint') {
          asked = true;
          stderr.write(`termbrowse: still saving your sign-ins (${Math.ceil((end - Date.now()) / 1000)} s left); press Ctrl-C again to quit now\n`);
        }
      }
    }
    await closeBrowser(chrome.port);
    await Promise.race([exited, sleep(CLOSE_GRACE_MS)]);
  } finally {
    polling = false;
    stdin.off('data', onData);
    if (!wasFlowing) stdin.pause();
    signals.off('SIGINT', onInt);
    for (const sig of ['SIGTERM', 'SIGHUP']) signals.off(sig, onQuit);
    await chrome.kill();
  }
  if (code === 0) stdout.write('Done. New agent profiles start from this one; existing profiles keep their own sign-ins.\n');
  return code;
}
