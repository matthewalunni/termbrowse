// Page operations for vim mode: scrolling, link hints, find, focus, history and tabs.
// Each takes a page CdpSession (tabs() takes the browser session). Page-side work runs through
// Runtime.evaluate; the page functions below are serialised with Function.prototype.toString, so
// they must stay self-contained (no closures over this module).

const ALPHABET = 'asdfghjkl';
const OVERLAY_ID = '__termbrowse_hints';

// `termbrowse <url>` and `:o <url>`: a scheme where one is missing.
export function normalizeUrl(input) {
  const s = String(input).trim();
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|blob|javascript|view-source|chrome):/i.test(s)) return s;
  return `https://${s}`;
}

// OSC 52 clipboard write: ESC ] 52 ; c ; <base64> BEL.
export function osc52(text) {
  return `\x1b]52;c;${Buffer.from(String(text)).toString('base64')}\x07`;
}

// Vimium's labelling: shortest codes from the home row, prefix-free, so typing a whole label is
// always unambiguous. Up to 9 targets get one letter each, in alphabet order. Self-contained: it
// also runs inside the page.
export function hintLabels(n, alphabet = 'asdfghjkl') {
  if (n <= 0) return [];
  const hints = [''];
  let offset = 0;
  while (hints.length - offset < n || hints.length === 1) {
    const prefix = hints[offset++];
    for (const ch of alphabet) hints.push(prefix + ch);
  }
  return hints.slice(offset, offset + n);
}

// A page blocked on alert(), a paused debugger or a stuck main thread never answers
// Runtime.evaluate; give up after this long so callers (and exit paths) never hang.
const EVAL_TIMEOUT_MS = 2000;

async function evaluate(page, expression) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`page did not answer within ${EVAL_TIMEOUT_MS} ms`)), EVAL_TIMEOUT_MS);
  });
  // Every page function here is synchronous, so no awaitPromise.
  const r = await Promise.race([page.send('Runtime.evaluate', { expression, returnByValue: true }), timeout]).finally(() =>
    clearTimeout(timer),
  );
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text ?? 'page script failed');
  }
  return r?.result?.value;
}

// Calls a page function with the shared helpers and JSON arguments.
const call = (page, fn, ...args) =>
  evaluate(page, `(${fn})((${pageHelpers})(), ${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`);

// --- page-side code (runs in the page) ---

function pageHelpers() {
  const TEXT_TYPES = ['text', 'search', 'email', 'password', 'url', 'tel', 'number'];
  // A text field: typing goes into it. Select, checkbox, button etc. are not.
  const editable = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (el.tagName === 'INPUT') return TEXT_TYPES.includes(el.type) && !el.disabled && !el.readOnly;
    return false;
  };
  // The focused element, through shadow roots and same-origin frames.
  const deepActive = () => {
    let a = document.activeElement;
    for (;;) {
      if (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      else if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) {
        let inner = null;
        try { inner = a.contentDocument?.activeElement; } catch {}
        if (!inner || inner === a.contentDocument.body) return a;
        a = inner;
      } else return a;
    }
  };
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true);
  // The part of el's first box that lies in the viewport, or null.
  const viewportRect = (el) => {
    const vw = innerWidth;
    const vh = innerHeight;
    for (const r of el.getClientRects()) {
      if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      return { left, top, right: Math.min(r.right, vw), bottom: Math.min(r.bottom, vh) };
    }
    return null;
  };
  return { editable, deepActive, visible, viewportRect };
}

function activeIsEditableInPage(h) {
  return h.editable(h.deepActive());
}

function blurInPage(h) {
  const a = h.deepActive();
  if (a && a !== document.body && typeof a.blur === 'function') a.blur();
  return null;
}

function focusFirstInputInPage(h) {
  const fields = [...document.querySelectorAll('input, textarea, [contenteditable]')].filter(
    (el) => h.editable(el) && h.visible(el) && el.getClientRects().length > 0,
  );
  const el = fields.find((f) => h.viewportRect(f)) ?? fields[0];
  if (!el) return false;
  el.focus();
  return h.deepActive() === el;
}

function scrollToInPage(h, where) {
  // Scroll whatever scrolls under the viewport centre (an app's inner pane), else the document.
  const scrollable = (el) => {
    const oy = getComputedStyle(el).overflowY;
    return el.scrollHeight > el.clientHeight && (oy === 'auto' || oy === 'scroll' || oy === 'overlay');
  };
  let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (el && el !== document.body && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
  if (!el || el === document.body || el === document.documentElement) el = document.scrollingElement ?? document.documentElement;
  el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
  return null;
}

function showHintsInPage(h, hintLabels, alphabet, overlayId) {
  document.getElementById(overlayId)?.remove();
  const CLICKABLE =
    'a[href], button, input, select, textarea, summary, label, [onclick], ' +
    '[role=button], [role=link], [role=checkbox], [role=tab], [role=menuitem]';
  const seen = new Set();
  const found = [];
  for (const el of document.querySelectorAll(`${CLICKABLE}, [contenteditable], [tabindex]`)) {
    if (!el.matches(CLICKABLE) && !el.isContentEditable && !(el.hasAttribute('tabindex') && el.tabIndex >= 0)) continue;
    if (el.disabled || !h.visible(el)) continue;
    const r = h.viewportRect(el);
    if (!r) continue;
    const x = (r.left + r.right) / 2;
    const y = (r.top + r.bottom) / 2;
    // Skip elements covered by something else (a modal, a sticky header).
    const hit = document.elementFromPoint(x, y) ?? document.elementFromPoint(r.left + 1, r.top + 1);
    if (hit && !el.contains(hit) && !hit.contains(el) && !(el.tagName === 'LABEL' && el.control === hit)) continue;
    seen.add(el);
    found.push({ el, r, x, y });
  }
  // A label whose control has its own hint would be a duplicate.
  const targets = found.filter((t) => !(t.el.tagName === 'LABEL' && t.el.control && seen.has(t.el.control)));
  const labels = hintLabels(targets.length, alphabet);

  const overlay = document.createElement('div');
  overlay.id = overlayId;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:none;';
  const hints = targets.map((t, i) => {
    const span = document.createElement('span');
    span.textContent = labels[i];
    span.style.cssText =
      `position:fixed;left:${Math.round(t.r.left)}px;top:${Math.round(t.r.top)}px;` +
      'padding:0 3px;border:1px solid #c38a22;border-radius:3px;background:#ffd76e;color:#302505;' +
      'font:bold 12px/1.3 Menlo,Monaco,monospace;text-transform:uppercase;box-shadow:0 1px 3px rgba(0,0,0,.3);' +
      'white-space:nowrap;letter-spacing:0;';
    overlay.appendChild(span);
    return { label: labels[i], x: Math.round(t.x), y: Math.round(t.y), editable: h.editable(t.el), span };
  });
  overlay.__termbrowseHints = hints;
  (document.body ?? document.documentElement).appendChild(overlay);
  return hints.map(({ label, x, y, editable }) => ({ label, x, y, editable }));
}

function filterHintsInPage(h, typed, overlayId) {
  const overlay = document.getElementById(overlayId);
  const hints = overlay?.__termbrowseHints ?? [];
  typed = String(typed).toLowerCase();
  const left = [];
  for (const hint of hints) {
    const keep = hint.label.startsWith(typed);
    hint.span.style.display = keep ? '' : 'none';
    hint.span.style.opacity = keep && typed ? '1' : '';
    if (keep) left.push(hint);
  }
  const m = typed && left.length === 1 ? left[0] : null;
  return { match: m && { label: m.label, x: m.x, y: m.y, editable: m.editable }, remaining: left.length };
}

function removeHintsInPage(h, overlayId) {
  document.getElementById(overlayId)?.remove();
  return null;
}

// Find state lives on window.__termbrowseFind: { ranges, index }. Matches are painted with the
// CSS Custom Highlight API, so the page's DOM and selection are left alone.
function findInPage(h, needle, step) {
  const ALL = '__termbrowse_find';
  const CUR = '__termbrowse_find_current';
  const STYLE = '__termbrowse_find_style';
  const clear = () => {
    globalThis.CSS?.highlights?.delete(ALL);
    globalThis.CSS?.highlights?.delete(CUR);
    document.getElementById(STYLE)?.remove();
    delete window.__termbrowseFind;
  };
  if (needle === null && step === null) {
    clear();
    return null;
  }
  let st = window.__termbrowseFind;
  if (needle !== null) {
    clear();
    const ranges = [];
    if (needle) {
      // Smartcase, like Vimium: case-sensitive only when the needle has a capital.
      const sensitive = needle !== needle.toLowerCase();
      const n = sensitive ? needle : needle.toLowerCase();
      const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, {
        acceptNode(t) {
          const p = t.parentElement;
          if (!p || p.closest('script, style, noscript, template, #__termbrowse_hints')) return NodeFilter.FILTER_REJECT;
          return h.visible(p) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const s = sensitive ? t.data : t.data.toLowerCase();
        if (s.length !== t.data.length) continue; // case mapping changed offsets; skip the node
        for (let i = s.indexOf(n); i >= 0; i = s.indexOf(n, i + n.length)) {
          const r = document.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + n.length);
          ranges.push(r);
        }
      }
    }
    st = window.__termbrowseFind = { ranges, index: 0 };
    if (ranges.length && globalThis.CSS?.highlights && typeof Highlight === 'function') {
      const style = document.createElement('style');
      style.id = STYLE;
      style.textContent =
        `::highlight(${ALL}){background-color:#ffd76e;color:#000}` + `::highlight(${CUR}){background-color:#ff9632;color:#000}`;
      (document.head ?? document.documentElement).appendChild(style);
      CSS.highlights.set(ALL, new Highlight(...ranges));
    }
  } else {
    if (!st || !st.ranges.length) return { index: 0, total: 0 };
    const n = st.ranges.length;
    st.index = (((st.index + step) % n) + n) % n;
  }
  const total = st.ranges.length;
  if (!total) return { index: 0, total: 0 };
  const range = st.ranges[st.index];
  if (globalThis.CSS?.highlights && typeof Highlight === 'function') CSS.highlights.set(CUR, new Highlight(range));
  const b = range.getBoundingClientRect();
  if (b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > innerWidth) {
    range.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  return { index: st.index + 1, total };
}

// --- scrolling ---

async function viewport(page) {
  const m = await page.send('Page.getLayoutMetrics');
  const v = m.cssLayoutViewport ?? m.layoutViewport;
  return { width: v.clientWidth, height: v.clientHeight };
}

// A real wheel event, so it scrolls whatever is under the point (default: the viewport centre).
export async function scrollBy(page, dx, dy, at) {
  if (!at) {
    const { width, height } = await viewport(page);
    at = { x: Math.round(width / 2), y: Math.round(height / 2) };
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: dx, deltaY: dy });
}

// dir: 1 down, -1 up.
export async function halfPage(page, dir, at) {
  const { width, height } = await viewport(page);
  at ??= { x: Math.round(width / 2), y: Math.round(height / 2) };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: Math.sign(dir) * Math.round(height / 2) });
}

// where: 'top' | 'bottom'.
export async function scrollTo(page, where) {
  if (where !== 'top' && where !== 'bottom') throw new Error(`scrollTo: expected "top" or "bottom", got ${where}`);
  await call(page, scrollToInPage, where);
}

// --- focus ---

export const activeIsEditable = async (page) => (await call(page, activeIsEditableInPage)) === true;
export const focusFirstInput = async (page) => (await call(page, focusFirstInputInPage)) === true;
export const blurActive = async (page) => {
  await call(page, blurInPage);
};

export async function sendEscape(page) {
  const key = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

// --- link hints ---

// Labels every visible clickable/focusable element in the viewport. x/y: the target's centre in
// CSS pixels of the viewport (what Input.dispatchMouseEvent takes).
export async function showHints(page) {
  const hints = await evaluate(
    page,
    `(${showHintsInPage})((${pageHelpers})(), ${hintLabels}, ${JSON.stringify(ALPHABET)}, ${JSON.stringify(OVERLAY_ID)})`,
  );
  return hints ?? [];
}

// Hides labels that don't start with typed. match: the one remaining hint (once something is typed).
export async function filterHints(page, typed) {
  return (await call(page, filterHintsInPage, typed, OVERLAY_ID)) ?? { match: null, remaining: 0 };
}

export async function removeHints(page) {
  await call(page, removeHintsInPage, OVERLAY_ID);
}

// --- find ---

// {index (1-based, 0 when none), total}.
export async function find(page, text) {
  return call(page, findInPage, String(text), null);
}

// dir: 1 next, -1 previous; wraps.
export async function findNext(page, dir) {
  return call(page, findInPage, null, Math.sign(dir) || 1);
}

export async function clearFind(page) {
  await call(page, findInPage, null, null);
}

// --- history / reload ---

// dir: -1 back, 1 forward. false when there is no entry that way.
export async function history(page, dir) {
  const { currentIndex, entries } = await page.send('Page.getNavigationHistory');
  if (!Math.sign(dir)) return false;
  const entry = entries?.[currentIndex + Math.sign(dir)];
  if (!entry) return false;
  await page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  return true;
}

export async function reload(page) {
  await page.send('Page.reload', {});
}

// --- tabs ---

// Same rule as viewer.js followable(): the tabs the viewer would show.
function isTab(info) {
  if (info?.type !== 'page' || info.subtype) return false;
  const url = info.url ?? '';
  if (/^(chrome-extension|devtools):/i.test(url)) return false;
  if (/^chrome:/i.test(url)) return /^chrome:\/\/(newtab|new-tab-page)\/?$/i.test(url);
  return true;
}

// op: 'next' | 'prev' | 'new' | 'close'. Returns the tab to show now, or null when nothing changed
// (close never closes the last tab; next/prev with one tab). Order: Target.getTargets.
// Never Target.activateTarget: on macOS it can bring Chrome's window to the front and take focus;
// the viewer just shows the returned tab.
export async function tabs(browser, op, currentTargetId) {
  if (!['next', 'prev', 'new', 'close'].includes(op)) throw new Error(`unknown tab op: ${op}`);
  if (op === 'new') {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    return { targetId };
  }
  const { targetInfos = [] } = await browser.send('Target.getTargets');
  const pages = targetInfos.filter(isTab).map((t) => t.targetId);
  const i = pages.indexOf(currentTargetId);
  if (op === 'close') {
    if (i < 0 || pages.length < 2) return null;
    const next = pages[i + 1] ?? pages[i - 1];
    await browser.send('Target.closeTarget', { targetId: currentTargetId });
    return { targetId: next };
  }
  if (pages.length < 2 && i >= 0) return null;
  if (!pages.length) return null;
  const n = pages.length;
  return { targetId: i < 0 ? pages[0] : pages[(i + (op === 'next' ? 1 : -1) + n) % n] };
}
