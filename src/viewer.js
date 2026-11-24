// Live viewer: draws one Chrome tab's screencast into the terminal with Kitty graphics.
import { pngSize, encodeFrame, deleteAll, deleteImage, enterScreen, leaveScreen } from './kitty.js';
import { fit, fillPlace, screencastSize, saneSize, cellToPage } from './layout.js';
import { listTargets, browserVersion, pickTarget, CdpSession } from './cdp.js';
import { termSize, detectKitty, knownKittyTerminal } from './tty.js';
import { InputParser } from './input.js';
import { toKeyEvents, isPrintable } from './keymap.js';
import { paths } from './paths.js';
import { takeControl, touchControl, releaseControl, readControl } from './control.js';
import { createModes } from './modes.js';
import * as ops from './pageops.js';

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

// Interactive mode: SGR any-event mouse, bracketed paste, then Kitty keyboard flags pushed
// (1 disambiguate + 4 alternate keys + 8 all keys as escapes + 16 associated text = 29), focus
// reporting, and a query of the keyboard flags (a terminal that answers speaks the protocol).
// Kitty keeps a keyboard-flag stack per screen, so it is pushed on the alternate screen and
// popped before leaving it.
export const MODES_ON = `${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h${ESC}[>29u${ESC}[?1004h${ESC}[?u`;
export const MODES_OFF = `${ESC}[<u${ESC}[?1004l${ESC}[?2004l${ESC}[?1003l${ESC}[?1006l`;
const FOCUS_CLICK_MS = 150; // a press this soon after the terminal gains focus only focused the pane

// How long a lone ESC waits before it counts as the Escape key rather than the start of a
// sequence. With the Kitty keyboard protocol Escape itself arrives as a sequence, so a bare ESC
// is always a split sequence: wait long. Over ssh sequences split more often.
export function escFlushMs({ kittyKeyboard = false, env = {} } = {}) {
  return kittyKeyboard || env.SSH_CONNECTION ? 300 : 50;
}
const CLICK_MS = 400; // double/triple click window
const HOVER_MS = 1000 / 30; // at most 30 pointer moves a second
const TOUCH_MS = 1000; // refresh the control file's lastInput at most once a second
const BUSY_NOTE_MS = 2000;
const FAIL_NOTE_MS = 3000;
const BUTTON_BITS = { left: 1, right: 2, middle: 4 };
const MATCH_NOTE_MS = 3000;
const GATE_MS = 2500; // longest a page check / hint pick / tab op holds key events
const PAGE_CLEANUP_MS = 2100; // hint labels / find highlights on exit (pageops gives up after 2 s)

// The vim-mode keys, for the help page (?, :help) and the README.
export const KEY_HELP = [
  ['j k / h l', 'scroll down / up / left / right'],
  ['d u', 'half a page down / up'],
  ['gg G', 'top / bottom'],
  ['f F', 'link hints: type a label to click it (F: in a new tab)'],
  ['gi', 'focus the first text field (Insert)'],
  ['i', 'Insert: keys go to the page'],
  ['Esc', 'Insert → Normal; in Normal, hand control back'],
  ['/ n N', 'find; next / previous match'],
  ['H L', 'back / forward'],
  ['r', 'reload'],
  ['J gT / K gt', 'previous / next tab'],
  ['t x', 'new tab / close tab'],
  ['yy', 'copy the URL'],
  [':o <url>', 'open a URL'],
  [':done', 'hand control back to the agent'],
  [':esc', 'send Escape to the page'],
  [':q', 'quit (Ctrl-C too, in Normal)'],
  ['?', 'this help'],
];

export function helpLines(cols, rows) {
  const lines = ['termbrowse keys (any key closes this)', ''];
  for (const [keys, what] of KEY_HELP) lines.push(`  ${keys.padEnd(12)} ${what}`);
  return lines.slice(0, Math.max(0, rows)).map((l) => l.slice(0, Math.max(0, cols)));
}

// The Normal status row: the URL shrinks first, then the hints go, never the way out.
export function normalStatus(lead, url, width) {
  let parts = [...lead];
  let hints = ['f links', 'i insert', ':q quit', '? help'];
  const join = (u) => [...parts, ...(u ? [u] : []), ...hints].join(' · ');
  if (join(url).length <= width) return join(url);
  const room = width - join('').length - 3;
  if (url && room >= 12) return join(`${url.slice(0, room - 1)}…`);
  for (const drop of ['? help', 'i insert', 'f links']) {
    if (join('').length <= width) break;
    hints = hints.filter((h) => h !== drop);
  }
  if (join('').length > width) parts = parts.slice(0, 1);
  return join('').slice(0, width);
}

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
  interactive = true, // vim-mode keys, mouse and paste; false: watch only (q / Ctrl-C quit)
  // agentId: the agent whose browser this is (control file), null for a standalone browser.
  control: { agentId = null, idleReturnMs = 300_000 } = {},
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
  let shownId = null; // image id on screen (frames alternate 1 and 2); null when nothing is drawn
  let place = null; // cells the image on screen covers from the top left, null when nothing is drawn
  let viewport = null; // CSS size of the page the image shows
  // Input state (interactive mode).
  const parser = new InputParser();
  let escTimer = null;
  let lastInputAt = 0;
  let kittyKeyboard = knownKittyTerminal(env); // a bare ESC never means the Escape key
  let focusKnown = false; // the terminal reports focus (?1004); until it does, assume focused
  let focused = true;
  let focusInAt = -Infinity;
  let lastTouch = 0;
  let idleTimer = null;
  let confirmed = false; // the control file says the user holds it (status says so only then)
  let note = null; // {text, until}: a passing status message (agent was acting, a control failure)
  let noteTimer = null;
  let lastClick = null; // {button, col, row, at, count}
  const pressed = new Set(); // mouse buttons down on the page
  let lastMoveAt = 0;
  let pendingMove = null;
  let moveTimer = null;
  // Vim mode (interactive).
  let holding = false; // the user holds control of the agent's browser
  const modes = createModes({ agent: !!agentId, holding: () => holding });
  let hintsOn = false; // hint labels may be in the page
  let hintTyped = '';
  let hintNewTab = false;
  let hintScroll = null; // the page's scroll offset when the labels were drawn
  let lastScroll = null; // the scroll offset of the last frame (screencast metadata)
  let findOn = false; // find highlights may be in the page
  let helpShown = false;
  let tabsChanged = false; // the user changed tabs during this takeover
  let closingTab = null; // the tab id the user is closing (its socket closing is expected)
  let pageDead = false; // the viewed tab was closed by x and the switch is still on its way
  let gone = false; // the browser went away: the status row says so
  let controlOps = Promise.resolve(); // control file writes, in order
  const statePaths = agentId ? paths(env) : null;
  const received = []; // {t, size} for frames received in the last second
  const drawn = []; // timestamps of frames drawn in the last second
  let resolveRun;
  const done = new Promise((r) => { resolveRun = r; });

  const prune = (now) => {
    while (received.length && now - received[0].t > 1000) received.shift();
    while (drawn.length && now - drawn[0] > 1000) drawn.shift();
  };

  // Watch only: q (and Ctrl-C) quit.
  const quitHint = ' · q quit';
  const statusText = (suffix) => {
    const width = Math.max(0, term.cols);
    if (interactive) return vimStatus(width);
    if (note && note.until > Date.now()) return note.text.slice(0, width);
    // The URL shrinks first; past that the rest is cut before the quit hint is.
    const fitted = (row) => (row.length + quitHint.length <= width ? row : row.slice(0, Math.max(0, width - quitHint.length))) + quitHint;
    if (agentId) {
      const room = Math.max(0, width - suffix.length - quitHint.length - 'agent ·  · '.length);
      return fitted(`agent · ${url.slice(0, room)} · ${suffix}`).slice(0, width);
    }
    const room = Math.max(0, width - suffix.length - quitHint.length - 2);
    return fitted(`${url.slice(0, room)}  ${suffix}`).slice(0, width);
  };
  // Interactive: mode, who drives, the way out (see global constraints in the vim-mode plan).
  const vimStatus = (width) => {
    if (gone) return 'disconnected'.slice(0, width);
    if (helpShown) return 'help · any key to close'.slice(0, width);
    const { mode, line } = modes.state();
    if (paused && mode !== 'command') return 'paused (pane too small or too large) · :q quit'.slice(0, width);
    if (mode === 'command' || mode === 'find') {
      const text = `${mode === 'command' ? ':' : '/'}${line}█`;
      return text.length > width ? text.slice(text.length - width) : text; // keep the cursor end in view
    }
    if (note && note.until > Date.now()) return note.text.slice(0, width);
    if (mode === 'hints') return 'f: type a label'.slice(0, width);
    const mine = !!agentId && holding && confirmed;
    if (mode === 'insert') return (mine ? 'INSERT · you have control · Esc normal' : 'INSERT · Esc normal').slice(0, width);
    if (mine) return `NORMAL · you have control · Esc or :done hand back · ${url}`.slice(0, width);
    return normalStatus(agentId ? ['NORMAL', 'agent driving'] : ['NORMAL'], url, width);
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

  const onFrame = ({ data, sessionId, metadata }) => {
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
    if (Number.isFinite(metadata?.scrollOffsetX) && Number.isFinite(metadata?.scrollOffsetY)) {
      lastScroll = { x: metadata.scrollOffsetX, y: metadata.scrollOffsetY };
      // The page scrolled under the hint labels: they no longer sit on their elements.
      if (hintsOn && hintScroll && (hintScroll.x !== lastScroll.x || hintScroll.y !== lastScroll.y)) {
        cancelHints();
        showStatus();
      }
    }
    if (paused || busy || helpShown) return;
    let frame;
    let size;
    let fitted;
    try {
      size = pngSize(data);
      // Fill: the page was laid out at the image area's aspect, so the image takes all of it.
      fitted = filled ? fillPlace(term) : fit(size, term);
      frame = encodeFrame(data, fitted, shownId === 1 ? 2 : 1);
    } catch {
      return; // not a PNG we can read
    }
    place = fitted;
    viewport = metadata?.deviceWidth > 0 && metadata?.deviceHeight > 0
      ? { width: metadata.deviceWidth, height: metadata.deviceHeight }
      : size;
    drawn.push(now);
    status = statusText(`${drawn.length} fps`);
    // Double buffer: the new image is placed under the other id before the old one is deleted,
    // so the terminal never has a moment with no image.
    const clear = repaint ? `${deleteAll()}${ESC}[2J` : '';
    const drop = !repaint && shownId !== null ? deleteImage(shownId) : '';
    shownId = shownId === 1 ? 2 : 1;
    repaint = false;
    if (!stdout.write(clear + frame + drop + statusSeq(status))) {
      busy = true;
      stdout.once('drain', () => { busy = false; });
    }
  };

  const onPageEvent = ({ method, params }) => {
    if (method === 'Page.screencastFrame') onFrame(params);
    else if (method === 'Page.frameNavigated' && params?.frame && !params.frame.parentId) {
      url = params.frame.url ?? url;
      // A new document has no labels or highlights.
      findOn = false;
      if (hintsOn) cancelHints();
      if (!paused && !closing) setStatus(fpsSuffix(), true);
    }
  };

  const finish = async (code) => {
    if (closing) return;
    closing = true;
    clearInterval(ticker);
    clearTimeout(resizeTimer);
    for (const timer of [escTimer, idleTimer, noteTimer, moveTimer]) clearTimeout(timer);
    note = null;
    stdin.removeListener('data', onKey);
    for (const [sig, fn] of sigHandlers) signals.removeListener(sig, fn);
    // Hint labels and find highlights out of the page (best effort, never more than ~2 s).
    const cleanup = code === 0 ? leavePage() : Promise.resolve();
    // Hand the agent its browser back first, so it doesn't wait on the rest of the cleanup.
    if (holding) {
      holding = false;
      release(url, undefined, tabsChanged);
    }
    // A size query in flight puts raw mode back as it found it when it ends: let it end first.
    await within(resizing, 1000);
    if (code === 0) {
      await Promise.all([within(Promise.all([stopScreencast(), clearFill()]), 500), within(cleanup, PAGE_CLEANUP_MS)]);
    } else {
      gone = true;
      setStatus('disconnected', true);
      await Promise.all([clearFill(), new Promise((r) => setTimeout(r, 1000))]);
    }
    await within(controlOps, 1000);
    restoreTerminal();
    if (!wasFlowing) stdin.pause();
    page.close();
    browser?.close();
    stdout.off('error', onStdoutError);
    onExit?.(code);
    resolveRun(code);
  };

  // Terminal modes off and the normal screen back: once, from finish, or as a last resort when
  // the process exits without finish having got this far (a throw, process.exit elsewhere).
  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    signals.removeListener('exit', restoreTerminal);
    try {
      stdout.write((interactive ? MODES_OFF : '') + leaveScreen());
      if (typeof stdin.setRawMode === 'function' && !!stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
    } catch { /* the terminal is gone */ }
  };

  const attachPage = (session) => {
    session.addEventListener('event', (e) => { if (session === page) onPageEvent(e.detail); });
    session.addEventListener('close', () => { if (session === page) onPageClosed(); });
  };

  // Make `next` the viewed page: hook it up, drop the old session, start drawing.
  const adopt = async (next, info) => {
    const old = page;
    if (old !== next) await Promise.all([clearFill(), within(leavePage(), PAGE_CLEANUP_MS)]);
    if (closing) { if (old !== next) next.close(); return; }
    page = next;
    pageDead = false;
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

  // The tab's socket URL and its URL as listed, if it is.
  const lookup = async (targetId) => {
    let t;
    try {
      t = (await listTargets(port)).find((x) => x.id === targetId);
    } catch { /* fall back below */ }
    return { wsUrl: t?.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/devtools/page/${targetId}`, url: t?.url };
  };

  // New tabs are switched to one at a time, in the order they were created; one that is
  // superseded by a later tab before it is connected is dropped, so the latest one wins.
  let switching = Promise.resolve();
  let latestSwitch = 0;
  let following = null; // the tab a switch is on its way to (a tab op and discovery may both name it)
  const follow = (targetId, newUrl) => {
    if (targetId === following) return;
    following = targetId;
    const seq = ++latestSwitch;
    switching = switching.then(() => (seq === latestSwitch ? switchTo(targetId, newUrl, seq) : undefined));
  };

  const switchTo = async (targetId, newUrl, seq) => {
    try {
      if (targetId === target.id) return;
      let next;
      let listed;
      try {
        listed = await lookup(targetId);
        next = await CdpSession.connect(listed.wsUrl);
      } catch {
        // Keep the current page, unless it is the tab x just closed: then fall back like a
        // closed tab (another page, or disconnected).
        if (pageDead) {
          pageDead = false;
          onPageClosed();
        } else if (closingTab === target.id) closingTab = null; // its close, when seen, falls back
        return;
      }
      if (closing || seq !== latestSwitch) { next.close(); return; }
      // openerId: the tab to go back to when this one closes (the one viewed until now).
      await adopt(next, { id: targetId, url: newUrl ?? listed.url, openerId: target.id });
    } finally {
      if (following === targetId) following = null;
    }
  };

  // The viewed tab's socket closed. If Chrome is still up, view another tab (the one it was followed from first);
  // otherwise report the disconnect.
  const onPageClosed = async () => {
    if (closing) return;
    const closed = target;
    if (closed.id === closingTab) { // x: the tab op shows the next one
      closingTab = null;
      pageDead = true;
      return;
    }
    pageDead = false;
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
        shownId = null;
        place = null;
        stdout.write(`${deleteAll()}${ESC}[2J`);
        await stopScreencast();
        setStatus('paused', true);
      } else {
        paused = false;
        repaint = true;
        await applyFill();
        await restartScreencast();
        if (helpShown) drawHelp();
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

  // --- input (interactive mode) ---
  const queueControl = (op) => {
    controlOps = controlOps.then(op).catch(() => {});
    return controlOps;
  };
  const showStatus = () => { if (!closing) setStatus(paused ? 'paused' : fpsSuffix(), true); };
  const send = (method, params) => { page.send(method, params).catch(() => {}); };

  // A passing status message, e.g. a control-file failure the user must not miss.
  const flash = (text, ms) => {
    if (closing) return;
    note = { text, until: Date.now() + ms };
    clearTimeout(noteTimer);
    noteTimer = setTimeout(showStatus, ms + 10);
    showStatus();
  };

  // Release in the file, retrying once; a failure is shown (the agent stays blocked until this
  // viewer exits, when its dead pid releases it).
  const release = (at, until, tabs) => queueControl(async () => {
    const what = { url: at, until, tabsChanged: tabs };
    try {
      await releaseControl(agentId, what, statePaths);
    } catch {
      try {
        await releaseControl(agentId, what, statePaths);
      } catch (err) {
        flash(`couldn't hand back control: ${err.message}`, FAIL_NOTE_MS);
      }
    }
  });

  // --- page cleanup: hint labels and find highlights never stay in the page ---
  // Each resolves once done or given up (pageops rejects after 2 s); never throws.
  // A removal already on its way is returned again, so an exit waits for it too.
  let removingHints = Promise.resolve();
  let clearingFind = Promise.resolve();
  const cancelHints = () => {
    if (modes.state().mode === 'hints') modes.setMode('normal');
    if (!hintsOn) return removingHints;
    hintsOn = false;
    hintTyped = '';
    removingHints = ops.removeHints(page).catch(() => {});
    return removingHints;
  };
  const clearFindNow = () => {
    findOn = false;
    clearingFind = ops.clearFind(page).catch(() => {});
    return clearingFind;
  };
  // Before leaving a page (quit, hand back, another tab): take our marks out of it.
  const leavePage = () => Promise.all([cancelHints(), findOn ? clearFindNow() : clearingFind]);

  let takeSeq = 0; // which take a result belongs to (a give-back may come before it lands)
  // Hand control back (Esc in Normal, :done, idle; until: when the takeover ended) and return
  // to watching.
  const giveBack = (until) => {
    clearTimeout(idleTimer);
    if (!holding) return;
    holding = false;
    confirmed = false;
    takeSeq++;
    leavePage();
    if (modes.state().mode === 'insert') modes.setMode('normal');
    release(url, until, tabsChanged);
    tabsChanged = false;
    showStatus();
  };

  // The user acts on the page (a click, wheel, or a key whose action changes the page). On an
  // agent browser that takes control (the input itself is sent at once, not after the file write).
  const acted = () => {
    const now = Date.now();
    lastInputAt = now;
    if (!agentId) return;
    clearTimeout(idleTimer);
    // Idle: the takeover ended at the last input, not after the wait.
    idleTimer = setTimeout(() => giveBack(lastInputAt), idleReturnMs);
    if (!holding) {
      holding = true;
      confirmed = false;
      tabsChanged = false;
      lastTouch = now;
      const at = url;
      const seq = ++takeSeq;
      queueControl(async () => {
        try {
          await takeControl(agentId, { viewerPid: process.pid, url: at, idleReturnMs }, statePaths);
        } catch (err) {
          // Never claim control the user doesn't have: the agent isn't blocked.
          if (seq !== takeSeq) return;
          holding = false;
          clearTimeout(idleTimer);
          flash(`couldn't take control: ${err.message}`, FAIL_NOTE_MS);
          return;
        }
        if (seq !== takeSeq || closing) return;
        confirmed = true;
        const busy = (await readControl(agentId, statePaths).catch(() => ({}))).agentBusySince;
        if (busy) flash('agent was acting…', BUSY_NOTE_MS);
        else showStatus();
      });
    } else if (now - lastTouch >= TOUCH_MS) {
      lastTouch = now;
      queueControl(() => touchControl(agentId, { viewerPid: process.pid, url, idleReturnMs }, statePaths));
    }
  };

  const modifiers = (ev) => (ev.alt ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.meta ? 4 : 0) | (ev.shift ? 8 : 0);
  const buttonsMask = () => [...pressed].reduce((m, b) => m | (BUTTON_BITS[b] ?? 0), 0);
  // Page coordinates for a cell; outside the image null, unless clamped (a drag or release that
  // left the image still reaches the page at its edge).
  const pageAt = (col, row, clamp = false) => {
    if (!place || !viewport || paused) return null;
    if (clamp) {
      col = Math.min(Math.max(col, 1), place.cols);
      row = Math.min(Math.max(row, 1), place.rows);
    }
    return cellToPage(col, row, place, term, viewport);
  };

  // --- key and paste events wait while a page check runs ---
  // After a click, a hint pick or gi the viewer asks the page whether a text field has focus;
  // keys typed meanwhile must land in the mode that answer sets, so they are held until then.
  let gate = null;
  let gateSeq = 0;
  const held = [];
  const gated = (work) => {
    const seq = ++gateSeq;
    // Bounded: a page stuck on alert() never answers a click or a Target call, and keys
    // (:q included) must not wait on it for ever.
    const g = (gate ?? Promise.resolve()).then(() => within(Promise.resolve().then(work).catch(() => {}), GATE_MS)).then(() => {
      if (seq !== gateSeq) return; // a later check drains
      gate = null;
      drain();
    });
    gate = g;
    return g;
  };
  const drain = () => {
    while (held.length && !gate && !closing) runActions(modes.handle(held.shift(), Date.now()));
  };

  // Only focus the user caused switches modes: called after their click, hint pick, gi, or a
  // Tab / paste passed to the page; never on the agent's or the page's own focus changes.
  const checkFocusNow = async () => {
    const session = page;
    let editable;
    try {
      editable = await ops.activeIsEditable(session);
    } catch {
      return; // the page didn't answer: keep the mode
    }
    if (closing || session !== page) return;
    const { mode } = modes.state();
    if (mode !== 'normal' && mode !== 'insert') return;
    modes.setMode(editable ? 'insert' : 'normal');
    showStatus();
  };
  const checkFocus = () => gated(checkFocusNow);

  // A page operation; a failure is shown, never thrown.
  const pageOp = (fn) => {
    const session = page;
    Promise.resolve().then(() => fn(session)).catch((err) => flash(err.message, FAIL_NOTE_MS));
  };
  // Where keys scroll: the centre of the page (what a wheel there would scroll).
  const centre = () => (viewport ? { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) } : undefined);
  const showMatch = (r) => flash(r?.total ? `match ${r.index}/${r.total}` : 'no matches', MATCH_NOTE_MS);

  // --- link hints ---
  const startHints = (newTab) => {
    hintNewTab = newTab;
    hintTyped = '';
    hintsOn = true;
    hintScroll = lastScroll;
    showStatus();
    gated(async () => {
      const session = page;
      let hints = [];
      try {
        hints = await ops.showHints(session);
      } catch (err) {
        flash(err.message, FAIL_NOTE_MS);
      }
      if (closing || session !== page) return;
      if (!hintsOn || modes.state().mode !== 'hints') return; // cancelled meanwhile
      if (!hints.length) {
        await cancelHints();
        flash('no links to hint', FAIL_NOTE_MS);
      }
    });
  };

  const clickAt = async (session, x, y, mods) => {
    const base = { x, y, button: 'left', clickCount: 1, modifiers: mods };
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  };

  const pickHint = async (match) => {
    const session = page;
    const newTab = hintNewTab;
    await cancelHints(); // the labels go before the click lands
    if (closing || session !== page) return;
    // Cmd-click (Ctrl-click off macOS) opens a link in a new tab; the viewer follows it.
    const mods = newTab ? (process.platform === 'darwin' ? 4 : 2) : 0;
    await clickAt(session, match.x, match.y, mods).catch(() => {});
    if (!newTab) await checkFocusNow();
    showStatus();
  };

  const hintKey = (key) => gated(async () => {
    if (!hintsOn || modes.state().mode !== 'hints') return;
    if (key === 'Backspace') hintTyped = [...hintTyped].slice(0, -1).join('');
    else if (key !== 'Enter') hintTyped += key.toLowerCase();
    const session = page;
    let r = await ops.filterHints(session, hintTyped);
    if (closing || session !== page || !hintsOn) return;
    if (r.match) {
      await pickHint(r.match);
      return;
    }
    if (r.remaining === 0 && hintTyped) {
      // Not a label: drop the key, like Vimium.
      hintTyped = [...hintTyped].slice(0, -1).join('');
      r = await ops.filterHints(session, hintTyped);
    }
  });

  // --- tabs ---
  const tabOp = (op) => {
    if (!browser) {
      flash('tabs are not ready yet', FAIL_NOTE_MS);
      return;
    }
    gated(async () => {
      const current = target.id;
      await leavePage();
      if (op === 'close') closingTab = current;
      let r;
      try {
        r = await ops.tabs(browser, op, current);
      } catch (err) {
        closingTab = null;
        flash(err.message, FAIL_NOTE_MS);
        return;
      }
      if (!r) {
        closingTab = null;
        flash(op === 'close' ? "won't close the last tab" : 'no other tab', FAIL_NOTE_MS);
        return;
      }
      if (agentId && holding) {
        tabsChanged = true;
        queueControl(() => touchControl(agentId, { viewerPid: process.pid, url, idleReturnMs, tabsChanged: true }, statePaths));
      }
      if (r.targetId !== current) follow(r.targetId);
    });
  };

  // --- help: a text page in the terminal (never in the agent's page) ---
  const drawHelp = () => {
    shownId = null;
    const lines = helpLines(term.cols, Math.max(0, term.rows - 1));
    status = statusText();
    stdout.write(`${deleteAll()}${ESC}[2J${ESC}[H${lines.join('\r\n')}${statusSeq(status)}`);
  };
  const showHelp = () => {
    helpShown = true;
    drawHelp();
  };
  const closeHelp = () => {
    if (!helpShown) return;
    helpShown = false;
    repaint = true; // the next frame clears the text
    showStatus();
    // Chrome sends no frame while the page is still: restarting sends the current one.
    if (!paused && !closing) restartScreencast();
  };

  // --- the actions modes.js returns ---
  const run = (a) => {
    switch (a.type) {
      case 'line': showStatus(); break;
      case 'scroll': pageOp((s) => ops.scrollBy(s, a.dx, a.dy, centre())); break;
      case 'halfPage': pageOp((s) => ops.halfPage(s, a.dir, centre())); break;
      case 'scrollTo': pageOp((s) => ops.scrollTo(s, a.where)); break;
      case 'history':
        pageOp(async (s) => {
          if (!(await ops.history(s, a.dir))) flash(a.dir < 0 ? 'no page back' : 'no page forward', FAIL_NOTE_MS);
        });
        break;
      case 'reload': pageOp((s) => ops.reload(s)); break;
      case 'open': pageOp((s) => s.send('Page.navigate', { url: ops.normalizeUrl(a.url) })); break;
      case 'sendEscape': pageOp((s) => ops.sendEscape(s)); break;
      case 'tab': tabOp(a.op); break;
      case 'find':
        findOn = true;
        gated(() => ops.find(page, a.text).then(showMatch, (err) => flash(err.message, FAIL_NOTE_MS)));
        break;
      case 'findNext':
        gated(() => ops.findNext(page, a.dir).then(showMatch, (err) => flash(err.message, FAIL_NOTE_MS)));
        break;
      case 'findCancel': showStatus(); clearFindNow(); break;
      case 'hints': startHints(!!a.newTab); break;
      case 'hintKey': hintKey(a.key); break;
      case 'hintsCancel': cancelHints(); showStatus(); break;
      case 'enterInsert': showStatus(); break;
      case 'exitInsert': pageOp((s) => ops.blurActive(s)); showStatus(); break;
      case 'focusFirstInput':
        gated(async () => {
          const session = page;
          const ok = await ops.focusFirstInput(session).catch(() => false);
          if (closing || session !== page) return;
          if (ok) {
            modes.setMode('insert');
            showStatus();
          } else flash('no text field', FAIL_NOTE_MS);
        });
        break;
      case 'pageKey':
        sendKey(a.ev);
        if (a.ev.key === 'Tab' && modes.state().mode === 'normal') checkFocus(); // Tab may move into a field
        break;
      case 'pagePaste': {
        const wasNormal = modes.state().mode === 'normal';
        send('Input.insertText', { text: a.text });
        if (wasNormal) checkFocus();
        break;
      }
      case 'copyUrl':
        stdout.write(ops.osc52(url));
        flash('copied the URL', BUSY_NOTE_MS);
        break;
      case 'help': showHelp(); break;
      case 'helpClose': closeHelp(); break;
      case 'handBack': giveBack(); break;
      case 'quit': finish(0); break;
      case 'error': flash(a.text, FAIL_NOTE_MS); break;
      default: break;
    }
  };
  const runActions = (actions) => {
    for (const a of actions) {
      if (closing) return;
      if (a.takesControl) acted();
      run(a);
    }
  };

  const sendMove = () => {
    moveTimer = null;
    if (!pendingMove || closing) return;
    const ev = pendingMove;
    pendingMove = null;
    const at = pageAt(ev.col, ev.row, pressed.size > 0);
    if (!at) return;
    lastMoveAt = Date.now();
    send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', ...at, button: ev.button, buttons: buttonsMask(), modifiers: modifiers(ev),
    });
  };

  const onMouse = (ev) => {
    if (ev.action === 'move') {
      // Pointer movement alone never takes control; hover on an agent browser only while holding it.
      if (agentId && !holding && pressed.size === 0) return;
      pendingMove = ev;
      if (moveTimer) return;
      const wait = Math.max(0, lastMoveAt + HOVER_MS - Date.now());
      if (wait === 0) sendMove();
      else moveTimer = setTimeout(sendMove, wait);
      return;
    }
    if (ev.action === 'press') {
      // The click that focused the pane is not meant for the page (nor is its release: the page
      // never saw the press).
      if (Date.now() - focusInAt < FOCUS_CLICK_MS) return;
      const at = pageAt(ev.col, ev.row);
      if (!at) return;
      // A click leaves the : or / line and the hint labels.
      const { mode } = modes.state();
      if (mode === 'hints') cancelHints();
      else if (mode === 'command' || mode === 'find') modes.setMode('normal');
      acted();
      const now = Date.now();
      const again = lastClick && lastClick.button === ev.button && now - lastClick.at <= CLICK_MS
        && Math.abs(lastClick.col - ev.col) <= 1 && Math.abs(lastClick.row - ev.row) <= 1;
      lastClick = { button: ev.button, col: ev.col, row: ev.row, at: now, count: again ? lastClick.count + 1 : 1 };
      pressed.add(ev.button);
      clearTimeout(moveTimer); // a queued move must not land after the press
      moveTimer = null;
      pendingMove = null;
      send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...at, button: ev.button, buttons: buttonsMask(),
        clickCount: lastClick.count, modifiers: modifiers(ev),
      });
      showStatus();
      return;
    }
    // release: only for a press the page saw
    if (!pressed.has(ev.button)) return;
    const at = pageAt(ev.col, ev.row, true);
    pressed.delete(ev.button);
    if (!at) return;
    if (moveTimer) { clearTimeout(moveTimer); sendMove(); }
    acted();
    send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...at, button: ev.button, buttons: buttonsMask(),
      clickCount: lastClick?.count ?? 1, modifiers: modifiers(ev),
    });
    // Clicking a text field enters Insert; clicking anything else leaves it.
    checkFocus();
  };

  const onWheel = (ev) => {
    if (focusKnown && !focused) return; // a scroll over an unfocused pane
    const at = pageAt(ev.col, ev.row);
    if (!at) return;
    acted();
    if (hintsOn) { cancelHints(); showStatus(); } // the labels would no longer match
    const lines = ev.dy || 0;
    const sideways = ev.shift && !ev.dx;
    send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', ...at,
      deltaX: (sideways ? lines : ev.dx || 0) * 100,
      deltaY: sideways ? 0 : lines * 100,
      modifiers: modifiers(ev),
    });
  };

  const sendKey = (ev) => {
    // Composed or non-ASCII text (é, emoji, IME) has no US key: insert it as text.
    if (isPrintable(ev) && /[^\x00-\x7f]/.test(ev.text)) {
      send('Input.insertText', { text: ev.text });
      return;
    }
    for (const params of toKeyEvents(ev)) send('Input.dispatchKeyEvent', params);
  };

  const onEvent = (ev) => {
    if (closing) return;
    if (ev.type === 'key' || ev.type === 'paste') {
      // A page check is running: its answer decides the mode first. Ctrl-C outside Insert,
      // with no keys before it still waiting, quits at once whatever the page is doing (keys
      // already waiting keep their order; the wait is bounded by GATE_MS).
      const ctrlC = ev.type === 'key' && ev.ctrl && !ev.alt && !ev.meta && ev.key.toLowerCase() === 'c';
      if (gate && !(ctrlC && !held.length && modes.state().mode !== 'insert')) held.push(ev);
      else runActions(modes.handle(ev, Date.now()));
    } else if (ev.type === 'mouse' || ev.type === 'wheel') {
      if (helpShown) return; // nothing of the page is on screen
      if (ev.type === 'mouse') {
        modes.handle(ev, Date.now()); // a press cancels a partial key sequence
        onMouse(ev);
      } else onWheel(ev);
    } else if (ev.type === 'focus') {
      focusKnown = true;
      focused = ev.in;
      if (ev.in) focusInAt = Date.now();
    } else if (ev.type === 'reply' && /^\x1b\[\?\d*u$/.test(ev.raw)) kittyKeyboard = true; // keyboard flags reply
    // Other replies: size and Kitty replies are read by the query in flight (tty.js) from the same stdin.
  };

  const onKey = (chunk) => {
    if (!interactive) {
      if (keyQuits(chunk)) finish(0);
      return;
    }
    clearTimeout(escTimer);
    escTimer = null;
    for (const ev of parser.push(chunk)) onEvent(ev);
    if (parser.buf !== '' && !closing) {
      escTimer = setTimeout(() => {
        escTimer = null;
        for (const ev of parser.flush()) onEvent(ev);
      }, escFlushMs({ kittyKeyboard, env }));
    }
  };

  const sigHandlers = [
    ['SIGWINCH', scheduleResize],
    ['SIGINT', () => finish(0)],
    ['SIGTERM', () => finish(0)],
    ['SIGHUP', () => finish(0)],
  ];

  attachPage(page);
  stdout.write(enterScreen() + (interactive ? MODES_ON : ''));
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  stdin.on('data', onKey);
  stdin.resume();
  for (const [sig, fn] of sigHandlers) signals.on(sig, fn);
  signals.on('exit', restoreTerminal);
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
