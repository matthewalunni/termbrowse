// Live viewer: draws one Chrome tab's screencast into the terminal with Kitty graphics.
import { pngSize, encodeFrame, deleteAll, enterScreen, leaveScreen } from './kitty.js';
import { fit, screencastSize, saneSize } from './layout.js';
import { listTargets, browserVersion, pickTarget, CdpSession } from './cdp.js';
import { termSize, detectKitty } from './tty.js';

const ESC = '\x1b';
export const NO_KITTY = "termbrowse: this terminal doesn't support Kitty graphics (try Kitty, Ghostty, WezTerm or Herdr)\n";

// Throttle decision from the base64 sizes of the frames received in the last second.
export function nextEveryNth(current, sizes) {
  if (sizes.length === 0) return current;
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  if (current === 1 && avg > 200_000 && sizes.length >= 45) return 2;
  if (current !== 1 && avg < 100_000) return 1;
  return current;
}

// Escape sequences a terminal sends: CSI (arrow keys, DA1 replies), OSC/APC/DCS strings
// (Kitty graphics replies), SS3, and two-byte ones.
const ESCAPE_SEQ = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^X][\s\S]*?(?:\x1b\\|\x07)|O.|[\s\S])/g;

// Whether a stdin chunk asks to quit: a q or Ctrl-C outside any escape sequence.
export function keyQuits(chunk) {
  const rest = String(chunk).replace(ESCAPE_SEQ, '');
  return rest.includes('q') || rest.includes('\x03');
}

// Whether a newly created target is a tab the user (or agent) opened, worth following.
// Not prerendered pages, extension pages or DevTools; chrome:// only for the new-tab page.
export function followable(info) {
  if (info?.type !== 'page' || info.subtype) return false;
  const url = info.url ?? '';
  if (/^(chrome-extension|devtools):/i.test(url)) return false;
  if (/^chrome:/i.test(url)) return /^chrome:\/\/(newtab|new-tab-page)\/?$/i.test(url);
  return true;
}

const RESIZE_DEBOUNCE_MS = 150;

// Waits for promise, at most ms; the timer is cleared either way, so it never holds the process open.
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((r) => { timer = setTimeout(r, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runViewer({
  port,
  match,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  signals = process,
  env = process.env,
  onExit,
  onReady,
  fill = false, // lay the page out at the pane's size (Emulation.setDeviceMetricsOverride)
}) {
  // EIO/EPIPE once the terminal is gone (SIGHUP) must not crash the process mid-cleanup.
  const onStdoutError = () => {};
  stdout.on('error', onStdoutError);
  const finishEarly = (code, msg) => {
    stdout.off('error', onStdoutError);
    if (msg) stderr.write(msg);
    onExit?.(code);
    return code;
  };
  if (!stdout.isTTY || !stdin.isTTY) return finishEarly(2, NO_KITTY);
  if (!(await detectKitty(stdin, stdout, 800, env))) return finishEarly(2, NO_KITTY);

  let term = await termSize(stdin, stdout);

  let target;
  let page;
  try {
    target = pickTarget(await listTargets(port), match);
    if (!target) return finishEarly(1, `termbrowse: no page to view on port ${port}\n`);
    page = await CdpSession.connect(target.webSocketDebuggerUrl);
  } catch (err) {
    return finishEarly(1, `termbrowse: ${err.message}\n`);
  }

  const wasRaw = !!stdin.isRaw;
  const wasFlowing = stdin.readableFlowing === true;
  let url = target.url ?? '';
  let everyNth = 1;
  let paused = false;
  let busy = false; // stdout has not drained since the last frame
  let closing = false;
  let status = '';
  let browser = null;
  let lastFrameAt = 0; // when the last frame arrived (Chrome sends none while the page is still)
  let filled = null; // the page session the size override was set on
  let repaint = false; // the pane changed size: clear it together with the next frame drawn
  const received = []; // {t, size} for frames received in the last second
  const drawn = []; // timestamps of frames drawn in the last second
  let resolveRun;
  const done = new Promise((r) => { resolveRun = r; });

  const prune = (now) => {
    while (received.length && now - received[0].t > 1000) received.shift();
    while (drawn.length && now - drawn[0] > 1000) drawn.shift();
  };

  const statusText = (suffix) => {
    const room = Math.max(0, term.cols - suffix.length - 2);
    return `${url.slice(0, room)}  ${suffix}`.slice(0, Math.max(0, term.cols));
  };
  const statusSeq = (text) => `${ESC}[${term.rows};1H${ESC}[2K${text}`;
  const setStatus = (suffix, force = false) => {
    const text = statusText(suffix);
    if (!force && text === status) return;
    status = text;
    stdout.write(statusSeq(text));
  };
  const fpsSuffix = () => {
    const now = Date.now();
    prune(now);
    return now - lastFrameAt > 1000 ? 'idle' : `${drawn.length} fps`;
  };

  const startScreencast = () => page.send('Page.startScreencast', {
    format: 'png', ...screencastSize(term), everyNthFrame: everyNth,
  }).catch(() => {});
  const stopScreencast = () => page.send('Page.stopScreencast').catch(() => {});
  // The page lays out at the image area the screencast is sized to, so frames fill the pane.
  const applyFill = async () => {
    if (!fill || !saneSize(term) || closing) return;
    const { maxWidth: width, maxHeight: height } = screencastSize(term);
    const session = page;
    filled = session;
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    // The viewer finished while the override was on its way: take it back off.
    if (closing) await clearOverride(session);
  };
  // Best effort, never throws, at most 500 ms.
  const clearOverride = (session) => within(session.send('Emulation.clearDeviceMetricsOverride').catch(() => {}), 500);
  const clearFill = async () => {
    const session = filled;
    filled = null;
    if (session) await clearOverride(session);
  };
  const restartScreencast = async () => {
    await stopScreencast();
    await startScreencast();
  };

  const onFrame = ({ data, sessionId }) => {
    page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (closing) return;
    const now = Date.now();
    lastFrameAt = now;
    received.push({ t: now, size: data.length });
    prune(now);
    const n = nextEveryNth(everyNth, received.map((f) => f.size));
    if (n !== everyNth) {
      everyNth = n;
      received.length = 0;
      restartScreencast();
    }
    if (paused || busy) return;
    let frame;
    try {
      frame = encodeFrame(data, fit(pngSize(data), term));
    } catch {
      return; // not a PNG we can read
    }
    drawn.push(now);
    status = statusText(`${drawn.length} fps`);
    const clear = repaint ? `${deleteAll()}${ESC}[2J` : '';
    repaint = false;
    if (!stdout.write(clear + frame + statusSeq(status))) {
      busy = true;
      stdout.once('drain', () => { busy = false; });
    }
  };

  const onPageEvent = ({ method, params }) => {
    if (method === 'Page.screencastFrame') onFrame(params);
    else if (method === 'Page.frameNavigated' && params?.frame && !params.frame.parentId) {
      url = params.frame.url ?? url;
      if (!paused && !closing) setStatus(fpsSuffix());
    }
  };

  const finish = async (code) => {
    if (closing) return;
    closing = true;
    clearInterval(ticker);
    clearTimeout(resizeTimer);
    stdin.removeListener('data', onKey);
    for (const [sig, fn] of sigHandlers) signals.removeListener(sig, fn);
    // A size query in flight puts raw mode back as it found it when it ends: let it end first.
    await within(resizing, 1000);
    if (code === 0) {
      await within(Promise.all([stopScreencast(), clearFill()]), 500);
    } else {
      setStatus('disconnected', true);
      await Promise.all([clearFill(), new Promise((r) => setTimeout(r, 1000))]);
    }
    stdout.write(leaveScreen());
    if (typeof stdin.setRawMode === 'function' && !!stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
    if (!wasFlowing) stdin.pause();
    page.close();
    browser?.close();
    stdout.off('error', onStdoutError);
    onExit?.(code);
    resolveRun(code);
  };

  const attachPage = (session) => {
    session.addEventListener('event', (e) => { if (session === page) onPageEvent(e.detail); });
    session.addEventListener('close', () => { if (session === page) onPageClosed(); });
  };

  // Make `next` the viewed page: hook it up, drop the old session, start drawing.
  const adopt = async (next, info) => {
    const old = page;
    if (old !== next) await clearFill();
    if (closing) { if (old !== next) next.close(); return; }
    page = next;
    target = info;
    url = info.url ?? '';
    attachPage(next);
    if (old !== next) old.close();
    await page.send('Page.enable').catch(() => {});
    if (closing || page !== next) return;
    if (!paused) {
      await applyFill();
      if (closing || page !== next) return;
      await startScreencast();
      setStatus(fpsSuffix(), true);
    }
  };

  const wsFor = async (targetId) => {
    let wsUrl;
    try {
      wsUrl = (await listTargets(port)).find((t) => t.id === targetId)?.webSocketDebuggerUrl;
    } catch { /* fall back below */ }
    return wsUrl ?? `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
  };

  // New tabs are switched to one at a time, in the order they were created; one that is
  // superseded by a later tab before it is connected is dropped, so the latest one wins.
  let switching = Promise.resolve();
  let latestSwitch = 0;
  const follow = (targetId, newUrl) => {
    const seq = ++latestSwitch;
    switching = switching.then(() => (seq === latestSwitch ? switchTo(targetId, newUrl, seq) : undefined));
  };

  const switchTo = async (targetId, newUrl, seq) => {
    let next;
    try {
      next = await CdpSession.connect(await wsFor(targetId));
    } catch {
      return; // keep the current page
    }
    if (closing || seq !== latestSwitch) { next.close(); return; }
    // openerId: the tab to go back to when this one closes (the one viewed until now).
    await adopt(next, { id: targetId, url: newUrl, openerId: target.id });
  };

  // The viewed tab's socket closed. If Chrome is still up, view another tab (the one it was followed from first);
  // otherwise report the disconnect.
  const onPageClosed = async () => {
    if (closing) return;
    const closed = target;
    try {
      if (!(await browserVersion(port))) throw new Error('browser gone');
      const pages = (await listTargets(port)).filter((t) => t.type === 'page' && t.id !== closed.id);
      const next = pages.find((t) => t.id === closed.openerId) ?? pickTarget(pages, match);
      if (!next) throw new Error('no page left');
      const session = await CdpSession.connect(next.webSocketDebuggerUrl);
      if (closing) { session.close(); return; }
      await adopt(session, { id: next.id, url: next.url });
    } catch {
      finish(1);
    }
  };

  // The last frame stays up until the first one at the new size replaces it (repaint), so a
  // resize does not blank the pane.
  let resizing = Promise.resolve();
  const resize = () => {
    resizing = resizing.then(async () => {
      if (closing) return;
      const next = await termSize(stdin, stdout);
      if (closing) return;
      term = next;
      if (!saneSize(term)) {
        paused = true;
        repaint = false;
        stdout.write(`${deleteAll()}${ESC}[2J`);
        await stopScreencast();
        setStatus('paused', true);
      } else {
        paused = false;
        repaint = true;
        await applyFill();
        await restartScreencast();
        setStatus(fpsSuffix(), true);
      }
    });
    return resizing;
  };

  // A drag-resize sends a burst of SIGWINCH: act once it settles.
  let resizeTimer;
  const scheduleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { resize(); }, RESIZE_DEBOUNCE_MS);
  };

  const onKey = (chunk) => {
    if (keyQuits(chunk)) finish(0);
  };

  const sigHandlers = [
    ['SIGWINCH', scheduleResize],
    ['SIGINT', () => finish(0)],
    ['SIGTERM', () => finish(0)],
    ['SIGHUP', () => finish(0)],
  ];

  attachPage(page);
  stdout.write(enterScreen());
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  stdin.on('data', onKey);
  stdin.resume();
  for (const [sig, fn] of sigHandlers) signals.on(sig, fn);
  const ticker = setInterval(() => { if (!paused && !closing) setStatus(fpsSuffix()); }, 1000);
  ticker.unref?.();

  await page.send('Page.enable').catch(() => {});
  if (saneSize(term)) {
    await applyFill();
    await startScreencast();
    setStatus(fpsSuffix(), true);
  } else {
    paused = true;
    setStatus('paused', true);
  }

  // Follow every new tab (popups, and new_page from chrome-devtools-mcp, which has no opener):
  // a second session on the browser endpoint reports new targets. Turning discovery on also
  // reports the tabs that already exist, so the ones listed before it are skipped.
  (async () => {
    const wsUrl = (await browserVersion(port))?.webSocketDebuggerUrl;
    if (!wsUrl || closing) return;
    try {
      browser = await CdpSession.connect(wsUrl);
    } catch {
      return;
    }
    if (closing) { browser.close(); return; }
    const existing = new Set((await listTargets(port).catch(() => [])).map((t) => t.id));
    browser.addEventListener('event', (e) => {
      const { method, params } = e.detail;
      const info = params?.targetInfo;
      if (closing || method !== 'Target.targetCreated' || !followable(info)) return;
      if (existing.has(info.targetId) || info.targetId === target.id) return;
      follow(info.targetId, info.url);
    });
    await browser.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  })();

  onReady?.({ resize });
  return done;
}
