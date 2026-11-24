import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeCdp } from './helpers/fake-cdp.js';
import { CdpSession, listTargets, browserVersion } from '../src/cdp.js';
import * as ops from '../src/pageops.js';

const skip = process.env.TERMBROWSE_SKIP_CHROME === '1' ? 'TERMBROWSE_SKIP_CHROME=1' : false;

// --- fake CDP: each op sends the expected methods ---

async function fake(handlers = {}) {
  const cdp = await startFakeCdp({
    handlers: {
      'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } }),
      'Runtime.evaluate': () => ({ result: { type: 'object', value: null } }),
      ...handlers,
    },
  });
  const page = await CdpSession.connect(cdp.wsUrl);
  const sent = (method) => cdp.received.filter((m) => m.method === method).map((m) => m.params);
  return { cdp, page, sent, async done() { page.close(); await cdp.close(); } };
}

test('osc52 wraps base64 in the clipboard escape', () => {
  assert.equal(ops.osc52('https://x'), '\x1b]52;c;aHR0cHM6Ly94\x07');
});

test('hintLabels: home row, shortest unique, prefix-free', () => {
  assert.deepEqual(ops.hintLabels(3), ['a', 's', 'd']);
  assert.deepEqual(ops.hintLabels(9), ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l']);
  for (const n of [0, 1, 10, 17, 30, 81, 82, 200]) {
    const labels = ops.hintLabels(n);
    assert.equal(labels.length, n);
    assert.equal(new Set(labels).size, n);
    for (const a of labels) {
      assert.match(a, /^[asdfghjkl]+$/);
      for (const b of labels) if (a !== b) assert.ok(!b.startsWith(a), `${a} is a prefix of ${b} (n=${n})`);
    }
  }
  assert.ok(ops.hintLabels(10).some((l) => l.length === 1), 'mixed lengths keep most labels short');
});

test('scrollBy dispatches a mouseWheel at the viewport centre', async () => {
  const f = await fake();
  await ops.scrollBy(f.page, 0, 60);
  const [ev] = f.sent('Input.dispatchMouseEvent');
  assert.deepEqual(ev, { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 60 });
  await ops.scrollBy(f.page, -60, 0, { x: 10, y: 20 });
  assert.deepEqual(f.sent('Input.dispatchMouseEvent')[1], { type: 'mouseWheel', x: 10, y: 20, deltaX: -60, deltaY: 0 });
  await f.done();
});

test('halfPage scrolls half the viewport height', async () => {
  const f = await fake();
  await ops.halfPage(f.page, 1);
  await ops.halfPage(f.page, -1);
  const evs = f.sent('Input.dispatchMouseEvent');
  assert.equal(evs[0].deltaY, 300);
  assert.equal(evs[1].deltaY, -300);
  assert.equal(evs[0].type, 'mouseWheel');
  await f.done();
});

test('scrollTo evaluates a top/bottom scroll in the page', async () => {
  const f = await fake();
  await ops.scrollTo(f.page, 'top');
  await ops.scrollTo(f.page, 'bottom');
  const [a, b] = f.sent('Runtime.evaluate');
  assert.match(a.expression, /"top"/);
  assert.match(b.expression, /"bottom"/);
  assert.equal(a.returnByValue, true);
  await assert.rejects(ops.scrollTo(f.page, 'middle'), /top|bottom/);
  await f.done();
});

test('activeIsEditable / focusFirstInput / blurActive return the page value', async () => {
  const f = await fake({ 'Runtime.evaluate': () => ({ result: { type: 'boolean', value: true } }) });
  assert.equal(await ops.activeIsEditable(f.page), true);
  assert.equal(await ops.focusFirstInput(f.page), true);
  await ops.blurActive(f.page);
  const exprs = f.sent('Runtime.evaluate').map((p) => p.expression);
  assert.equal(exprs.length, 3);
  assert.match(exprs[2], /blur\(\)/);
  await f.done();
});

test('a page exception rejects', async () => {
  const f = await fake({ 'Runtime.evaluate': () => ({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } }) });
  await assert.rejects(ops.activeIsEditable(f.page), /boom/);
  await f.done();
});

test('a page that never answers Runtime.evaluate rejects within ~2 s (alert, debugger, stuck thread)', async () => {
  const f = await fake({ 'Runtime.evaluate': () => new Promise(() => {}) });
  for (const op of [() => ops.removeHints(f.page), () => ops.blurActive(f.page)]) {
    const t0 = Date.now();
    await assert.rejects(op(), /did not answer within 2000 ms/);
    const ms = Date.now() - t0;
    assert.ok(ms >= 1900 && ms < 2500, `rejected after ${ms} ms`);
  }
  assert.equal(f.sent('Runtime.evaluate')[0].awaitPromise, undefined, 'page functions are synchronous');
  await f.done();
});

test('sendEscape sends keyDown and keyUp Escape', async () => {
  const f = await fake();
  await ops.sendEscape(f.page);
  const evs = f.sent('Input.dispatchKeyEvent');
  assert.deepEqual(evs.map((e) => [e.type, e.key, e.code, e.windowsVirtualKeyCode]), [
    ['keyDown', 'Escape', 'Escape', 27],
    ['keyUp', 'Escape', 'Escape', 27],
  ]);
  await f.done();
});

test('reload sends Page.reload', async () => {
  const f = await fake();
  await ops.reload(f.page);
  assert.equal(f.sent('Page.reload').length, 1);
  await f.done();
});

test('history navigates to the neighbouring entry, or returns false at the end', async () => {
  const f = await fake({
    'Page.getNavigationHistory': () => ({ currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] }),
  });
  assert.equal(await ops.history(f.page, -1), true);
  assert.equal(await ops.history(f.page, 1), true);
  assert.deepEqual(f.sent('Page.navigateToHistoryEntry'), [{ entryId: 10 }, { entryId: 12 }]);
  f.cdp.handlers['Page.getNavigationHistory'] = () => ({ currentIndex: 2, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] });
  assert.equal(await ops.history(f.page, 1), false);
  assert.equal(f.sent('Page.navigateToHistoryEntry').length, 2);
  await f.done();
});

test('find / findNext / clearFind return the page result', async () => {
  const f = await fake({ 'Runtime.evaluate': () => ({ result: { type: 'object', value: { index: 1, total: 3 } } }) });
  assert.deepEqual(await ops.find(f.page, 'ne"edle'), { index: 1, total: 3 });
  assert.deepEqual(await ops.findNext(f.page, -1), { index: 1, total: 3 });
  await ops.clearFind(f.page);
  const exprs = f.sent('Runtime.evaluate').map((p) => p.expression);
  assert.ok(exprs[0].includes(JSON.stringify('ne"edle')), 'the needle is JSON-quoted into the script');
  assert.equal(exprs.length, 3);
  await f.done();
});

test('showHints passes labels in; filterHints/removeHints evaluate in the page', async () => {
  const f = await fake({
    'Runtime.evaluate': () => ({ result: { value: [{ label: 'a', x: 1, y: 2, editable: false }] } }),
  });
  const hints = await ops.showHints(f.page);
  assert.deepEqual(hints, [{ label: 'a', x: 1, y: 2, editable: false }]);
  await ops.removeHints(f.page);
  const exprs = f.sent('Runtime.evaluate').map((p) => p.expression);
  assert.equal(exprs.length, 2);
  assert.ok(exprs[0].includes('"asdfghjkl"'), 'the home-row alphabet is passed in');
  assert.match(exprs[1], /__termbrowse_hints/);
  await f.done();
});

function tabsFake(pages) {
  return startFakeCdp({
    handlers: {
      'Target.getTargets': () => ({
        targetInfos: [
          ...pages.map((id) => ({ targetId: id, type: 'page', url: `https://x/${id}` })),
          { targetId: 'W', type: 'service_worker', url: 'https://x/sw.js' },
          { targetId: 'D', type: 'page', url: 'devtools://devtools/x' },
        ],
      }),
      'Target.createTarget': () => ({ targetId: 'NEW' }),
    },
  });
}

test('tabs: next/prev pick the neighbour (wrapping), new creates, close keeps the last page', async () => {
  const cdp = await tabsFake(['A', 'B', 'C']);
  const browser = await CdpSession.connect(cdp.wsUrl);
  const sent = (m) => cdp.received.filter((r) => r.method === m).map((r) => r.params);
  assert.deepEqual(await ops.tabs(browser, 'next', 'B'), { targetId: 'C' });
  assert.deepEqual(await ops.tabs(browser, 'next', 'C'), { targetId: 'A' });
  assert.deepEqual(await ops.tabs(browser, 'prev', 'A'), { targetId: 'C' });
  assert.equal(sent('Target.activateTarget').length, 0, 'never brings a tab (or Chrome) to the front');
  assert.deepEqual(await ops.tabs(browser, 'new', 'A'), { targetId: 'NEW' });
  assert.equal(sent('Target.createTarget')[0].url, 'about:blank');
  assert.deepEqual(await ops.tabs(browser, 'close', 'B'), { targetId: 'C' }, 'like Chrome: the tab to the right');
  assert.deepEqual(sent('Target.closeTarget'), [{ targetId: 'B' }]);
  assert.deepEqual(await ops.tabs(browser, 'close', 'A'), { targetId: 'B' }, 'closing the first activates the next');
  await assert.rejects(ops.tabs(browser, 'sideways', 'A'), /tab op/);
  browser.close();
  await cdp.close();
});

test('tabs: closing a tab that is not listed says it could not find it', async () => {
  const cdp = await tabsFake(['A', 'B']);
  const browser = await CdpSession.connect(cdp.wsUrl);
  try {
    await assert.rejects(ops.tabs(browser, 'close', 'Z'), { message: "couldn't find this tab" });
    assert.equal(cdp.received.filter((r) => r.method === 'Target.closeTarget').length, 0);
  } finally {
    browser.close();
    await cdp.close();
  }
});

test('tabs: close refuses the last page; next with one page stays put', async () => {
  const cdp = await tabsFake(['A']);
  const browser = await CdpSession.connect(cdp.wsUrl);
  assert.equal(await ops.tabs(browser, 'close', 'A'), null);
  assert.equal(await ops.tabs(browser, 'next', 'A'), null);
  assert.equal(cdp.received.filter((r) => r.method === 'Target.closeTarget').length, 0);
  browser.close();
  await cdp.close();
});

// --- headless real Chrome: hints, focus and find on a real page ---

const tmp = await mkdtemp(join(tmpdir(), 'tb-pageops-'));
let chrome = null;
after(async () => {
  await chrome?.kill().catch(() => {});
  await rm(tmp, { recursive: true, force: true });
});

const PAGE = `<!doctype html><title>ops</title><body style="margin:0;font:16px sans-serif">
<p>needle one</p><a href="https://example.com/">a link</a>
<p>some text NEEDLE two</p><button>press</button>
<p><input type="text" id="t"></p><p>last needle</p>
<div style="height:3000px"></div><a href="https://example.com/far">far below</a></body>`;

async function realPage() {
  process.env.XDG_STATE_HOME = join(tmp, 'state');
  process.env.TERMBROWSE_CONFIG = join(tmp, 'none.toml');
  const { launchChrome } = await import('../src/chrome.js');
  chrome = await launchChrome({
    profileDir: join(tmp, 'profile'),
    headless: true,
    windowSize: [800, 600],
    extraArgs: [],
    url: `data:text/html,${encodeURIComponent(PAGE)}`,
  });
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    target = (await listTargets(chrome.port)).find((t) => t.type === 'page' && t.title === 'ops');
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(target, 'test page loaded');
  const page = await CdpSession.connect(target.webSocketDebuggerUrl);
  const browser = await CdpSession.connect((await browserVersion(chrome.port)).webSocketDebuggerUrl);
  return { page, browser, targetId: target.id };
}

const overlayPresent = async (page) =>
  (await page.send('Runtime.evaluate', { expression: '!!document.getElementById("__termbrowse_hints")', returnByValue: true })).result.value;

test('real Chrome: hints, focus, find and tabs', { skip, timeout: 120_000 }, async () => {
  const { page, browser, targetId } = await realPage();
  try {
    const hints = await ops.showHints(page);
    assert.deepEqual(hints.map((h) => h.label), ['a', 's', 'd'], JSON.stringify(hints));
    assert.deepEqual(hints.map((h) => h.editable), [false, false, true]);
    for (const h of hints) assert.ok(h.x > 0 && h.x < 800 && h.y > 0 && h.y < 600, JSON.stringify(h));
    assert.equal(await overlayPresent(page), true);

    const pick = await ops.filterHints(page, 's');
    assert.equal(pick.remaining, 1);
    assert.equal(pick.match.label, 's');
    const tag = await page.send('Runtime.evaluate', {
      expression: `document.elementFromPoint(${pick.match.x}, ${pick.match.y}).tagName`,
      returnByValue: true,
    });
    assert.equal(tag.result.value, 'BUTTON', 'the match centre is on the button');
    assert.deepEqual(await ops.filterHints(page, 'x'), { match: null, remaining: 0 });
    assert.deepEqual(await ops.filterHints(page, ''), { match: null, remaining: 3 });

    await ops.removeHints(page);
    assert.equal(await overlayPresent(page), false);
    await ops.removeHints(page); // idempotent
    assert.deepEqual(await ops.filterHints(page, 'a'), { match: null, remaining: 0 }, 'no hints after removal');

    assert.equal(await ops.activeIsEditable(page), false);
    assert.equal(await ops.focusFirstInput(page), true);
    assert.equal(await ops.activeIsEditable(page), true);
    await ops.blurActive(page);
    assert.equal(await ops.activeIsEditable(page), false);

    assert.deepEqual(await ops.find(page, 'needle'), { index: 1, total: 3 });
    assert.deepEqual(await ops.findNext(page, 1), { index: 2, total: 3 });
    assert.deepEqual(await ops.findNext(page, 1), { index: 3, total: 3 });
    assert.deepEqual(await ops.findNext(page, 1), { index: 1, total: 3 }, 'wraps');
    assert.deepEqual(await ops.findNext(page, -1), { index: 3, total: 3 }, 'wraps backwards');
    assert.deepEqual(await ops.find(page, 'nope'), { index: 0, total: 0 });
    await ops.clearFind(page);
    assert.deepEqual(await ops.findNext(page, 1), { index: 0, total: 0 }, 'nothing after clearFind');

    await ops.scrollTo(page, 'bottom');
    const y = async () => (await page.send('Runtime.evaluate', { expression: 'scrollY', returnByValue: true })).result.value;
    assert.ok((await y()) > 1000);
    await ops.scrollTo(page, 'top');
    assert.equal(await y(), 0);

    assert.equal(await ops.tabs(browser, 'close', targetId), null, 'never closes the last page');
    const created = await ops.tabs(browser, 'new', targetId);
    assert.ok(created?.targetId && created.targetId !== targetId);
    assert.deepEqual(await ops.tabs(browser, 'next', created.targetId), { targetId });
    assert.deepEqual(await ops.tabs(browser, 'next', targetId), created, 'order is stable after activation');
    assert.deepEqual(await ops.tabs(browser, 'close', created.targetId), { targetId });
  } finally {
    page.close();
    browser.close();
  }
});
