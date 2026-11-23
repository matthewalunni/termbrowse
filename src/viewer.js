// Live viewer: draws one Chrome tab's screencast into the terminal with Kitty graphics.
import { pngSize, encodeFrame, deleteAll, enterScreen, leaveScreen } from './kitty.js';
import { fit, screencastSize, saneSize } from './layout.js';
import { listTargets, browserVersion, pickTarget, CdpSession } from './cdp.js';
import { termSize, detectKitty } from './tty.js';

const ESC = '\x1b';
const NO_KITTY = "termbrowse: this terminal doesn't support Kitty graphics (try Kitty, Ghostty, WezTerm or Herdr)\n";

// Throttle decision from the base64 sizes of the frames received in the last second.
export function nextEveryNth(current, sizes) {
  if (sizes.length === 0) return current;
  const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  if (current === 1 && avg > 200_000 && sizes.length >= 45) return 2;
  if (current !== 1 && avg < 100_000) return 1;
  return current;
}

export async function runViewer({
  port,
  match,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  signals = process,
  onExit,
  onReady,
}) {
  const finishEarly = (code, msg) => {
    if (msg) stderr.write(msg);
    onExit?.(code);
    return code;
  };
  if (!stdout.isTTY || !stdin.isTTY) return finishEarly(2, NO_KITTY);
  if (!(await detectKitty(stdin, stdout))) return finishEarly(2, NO_KITTY);

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
    prune(Date.now());
    return `${drawn.length} fps`;
  };

  const startScreencast = () => page.send('Page.startScreencast', {
    format: 'png', ...screencastSize(term), everyNthFrame: everyNth,
  }).catch(() => {});
  const stopScreencast = () => page.send('Page.stopScreencast').catch(() => {});
  const restartScreencast = async () => {
    await stopScreencast();
    await startScreencast();
  };

  const onFrame = ({ data, sessionId }) => {
    page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (closing) return;
    const now = Date.now();
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
    if (!stdout.write(frame + statusSeq(status))) {
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
    stdin.removeListener('data', onKey);
    for (const [sig, fn] of sigHandlers) signals.removeListener(sig, fn);
    if (code === 0) {
      await Promise.race([stopScreencast(), new Promise((r) => setTimeout(r, 500))]);
    } else {
      setStatus('disconnected', true);
      await new Promise((r) => setTimeout(r, 1000));
    }
    stdout.write(leaveScreen());
    if (typeof stdin.setRawMode === 'function' && !!stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
    if (!wasFlowing) stdin.pause();
    page.close();
    browser?.close();
    onExit?.(code);
    resolveRun(code);
  };

  const attachPage = (session) => {
    session.addEventListener('event', (e) => { if (session === page) onPageEvent(e.detail); });
    session.addEventListener('close', () => { if (session === page) finish(1); });
  };

  const switchTo = async (targetId, newUrl) => {
    let wsUrl;
    try {
      wsUrl = (await listTargets(port)).find((t) => t.id === targetId)?.webSocketDebuggerUrl;
    } catch { /* fall back below */ }
    wsUrl ??= `ws://127.0.0.1:${port}/devtools/page/${targetId}`;
    let next;
    try {
      next = await CdpSession.connect(wsUrl);
    } catch {
      return; // keep the current page
    }
    if (closing) { next.close(); return; }
    const old = page;
    page = next;
    target = { id: targetId };
    url = newUrl ?? '';
    attachPage(next);
    old.close();
    await page.send('Page.enable').catch(() => {});
    if (!paused) {
      await startScreencast();
      setStatus(fpsSuffix());
    }
  };

  let resizing = Promise.resolve();
  const resize = () => {
    resizing = resizing.then(async () => {
      if (closing) return;
      const next = await termSize(stdin, stdout);
      if (closing) return;
      term = next;
      stdout.write(`${deleteAll()}${ESC}[2J`);
      if (!saneSize(term)) {
        paused = true;
        await stopScreencast();
        setStatus('paused', true);
      } else {
        paused = false;
        await restartScreencast();
        setStatus(fpsSuffix(), true);
      }
    });
    return resizing;
  };

  const onKey = (chunk) => {
    const s = String(chunk);
    if (s.includes(ESC)) return; // terminal replies, arrow keys, ...
    if (s.includes('q') || s.includes('\x03')) finish(0);
  };

  const sigHandlers = [
    ['SIGWINCH', () => { resize(); }],
    ['SIGINT', () => finish(0)],
    ['SIGTERM', () => finish(0)],
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
    await startScreencast();
    setStatus(fpsSuffix(), true);
  } else {
    paused = true;
    setStatus('paused', true);
  }

  // Follow popups: a second session on the browser endpoint reports new targets.
  (async () => {
    const wsUrl = (await browserVersion(port))?.webSocketDebuggerUrl;
    if (!wsUrl || closing) return;
    try {
      browser = await CdpSession.connect(wsUrl);
    } catch {
      return;
    }
    if (closing) { browser.close(); return; }
    browser.addEventListener('event', (e) => {
      const { method, params } = e.detail;
      const info = params?.targetInfo;
      if (method === 'Target.targetCreated' && info?.type === 'page' && info.openerId === target.id) {
        switchTo(info.targetId, info.url);
      }
    });
    await browser.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
  })();

  onReady?.({ resize });
  return done;
}
