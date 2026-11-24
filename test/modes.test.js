import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModes } from '../src/modes.js';

// Key events shaped like src/input.js produces them.
const key = (k, mods = {}) => {
  const ctrl = !!mods.ctrl, alt = !!mods.alt, meta = !!mods.meta;
  const printable = [...k].length === 1;
  const shift = mods.shift ?? (printable && k !== k.toLowerCase());
  return { type: 'key', key: k, code: '', text: printable && !ctrl && !alt && !meta ? k : undefined, shift, alt, ctrl, meta, repeat: false };
};
const ESCAPE = key('Escape');
const ENTER = key('Enter');

function make({ agent = true, holding = false } = {}) {
  let held = holding;
  const m = createModes({ agent, holding: () => held });
  let t = 0;
  // press(...keys) feeds keys 10 ms apart and returns every action.
  m.press = (...keys) => keys.flatMap((k) => m.handle(typeof k === 'string' ? key(k) : k, (t += 10)));
  m.type = (s) => m.press(...[...s]);
  m.setHolding = (v) => { held = v; };
  m.now = () => t;
  return m;
}

const strip = (acts) => acts.map(({ takesControl, ...a }) => a);
const nonLine = (acts) => strip(acts).filter((a) => a.type !== 'line');

test('starts in normal with nothing pending', () => {
  assert.deepEqual(make().state(), { mode: 'normal', pending: '', line: '' });
});

test('every single Normal key maps to its action', () => {
  const cases = {
    j: { type: 'scroll', dx: 0, dy: 60 },
    k: { type: 'scroll', dx: 0, dy: -60 },
    h: { type: 'scroll', dx: -60, dy: 0 },
    l: { type: 'scroll', dx: 60, dy: 0 },
    d: { type: 'halfPage', dir: 1 },
    u: { type: 'halfPage', dir: -1 },
    G: { type: 'scrollTo', where: 'bottom' },
    H: { type: 'history', dir: -1 },
    L: { type: 'history', dir: 1 },
    r: { type: 'reload' },
    J: { type: 'tab', op: 'prev' },
    K: { type: 'tab', op: 'next' },
    t: { type: 'tab', op: 'new' },
    x: { type: 'tab', op: 'close' },
    n: { type: 'findNext', dir: 1 },
    N: { type: 'findNext', dir: -1 },
    '?': { type: 'help' },
  };
  for (const [k, want] of Object.entries(cases)) {
    const m = make();
    assert.deepEqual(strip(m.press(k)), [want], `key ${k}`);
  }
});

test('sequences: gg G gi gt gT yy', () => {
  const cases = {
    gg: { type: 'scrollTo', where: 'top' },
    gi: { type: 'focusFirstInput' },
    gt: { type: 'tab', op: 'next' },
    gT: { type: 'tab', op: 'prev' },
    yy: { type: 'copyUrl' },
  };
  for (const [seq, want] of Object.entries(cases)) {
    const m = make();
    const first = m.press(seq[0]);
    assert.deepEqual(first, [], `${seq}: first key waits`);
    assert.equal(m.state().pending, seq[0]);
    assert.deepEqual(strip(m.press(seq[1])), [want], seq);
    assert.equal(m.state().pending, '');
  }
});

test('? opens help; any key closes it', () => {
  const m = make();
  m.press('?');
  assert.equal(m.state().mode, 'help');
  assert.deepEqual(strip(m.press('j')), [{ type: 'helpClose' }]);
  assert.equal(m.state().mode, 'normal');
});

test(':q Enter quits; :quit quits; :done hands back', () => {
  let m = make();
  assert.deepEqual(nonLine(m.press(':', 'q', ENTER)), [{ type: 'quit' }]);
  assert.equal(m.state().mode, 'normal');
  m = make();
  assert.deepEqual(nonLine([...m.type(':quit'), ...m.press(ENTER)]), [{ type: 'quit' }]);
  m = make();
  assert.deepEqual(nonLine([...m.type(':done'), ...m.press(ENTER)]), [{ type: 'handBack' }]);
});

test(':o / :open, :esc, :help, :bogus', () => {
  let m = make();
  assert.deepEqual(nonLine([...m.type(':o example.com'), ...m.press(ENTER)]), [{ type: 'open', url: 'example.com' }]);
  m = make();
  assert.deepEqual(nonLine([...m.type(':open example.com'), ...m.press(ENTER)]), [{ type: 'open', url: 'example.com' }]);
  m = make();
  assert.deepEqual(nonLine([...m.type(':esc'), ...m.press(ENTER)]), [{ type: 'sendEscape' }]);
  m = make();
  assert.deepEqual(nonLine([...m.type(':help'), ...m.press(ENTER)]), [{ type: 'help' }]);
  assert.equal(m.state().mode, 'help');
  m = make();
  assert.deepEqual(nonLine([...m.type(':bogus'), ...m.press(ENTER)]), [{ type: 'error', text: 'not a command: bogus' }]);
  assert.equal(m.state().mode, 'normal');
});

test(': line shows the typed text, Backspace edits, Esc cancels', () => {
  const m = make();
  assert.deepEqual(strip(m.press(':')), [{ type: 'line', text: ':█' }]);
  assert.equal(m.state().mode, 'command');
  assert.deepEqual(strip(m.type('ox')), [{ type: 'line', text: ':o█' }, { type: 'line', text: ':ox█' }]);
  assert.deepEqual(strip(m.press(key('Backspace'))), [{ type: 'line', text: ':o█' }]);
  assert.equal(m.state().line, 'o');
  const acts = m.press(ESCAPE);
  assert.deepEqual(strip(acts), [{ type: 'line', text: '' }]);
  assert.deepEqual(m.state(), { mode: 'normal', pending: '', line: '' });
});

test(': line captures mapped keys (q, j, x do not run)', () => {
  const m = make();
  const acts = [...m.type(':jx q'), ...m.press(key('Backspace'), key('Backspace'), key('Backspace'), key('Backspace'))];
  assert.ok(acts.every((a) => a.type === 'line'));
  assert.deepEqual(nonLine(m.press('q', ENTER)), [{ type: 'quit' }]);
});

test('/foo Enter finds; n N; Esc cancels the find line', () => {
  let m = make();
  m.press('/');
  assert.equal(m.state().mode, 'find');
  assert.deepEqual(strip(m.type('foo')).at(-1), { type: 'line', text: '/foo█' });
  assert.deepEqual(nonLine(m.press(ENTER)), [{ type: 'find', text: 'foo' }]);
  assert.equal(m.state().mode, 'normal');
  assert.deepEqual(strip(m.press('n', 'N')), [{ type: 'findNext', dir: 1 }, { type: 'findNext', dir: -1 }]);
  m = make();
  m.type('/fo');
  assert.deepEqual(nonLine(m.press(ESCAPE)), [{ type: 'findCancel' }]);
  assert.equal(m.state().mode, 'normal');
});

test('f shows hints, letters go to hints, Esc cancels; F opens in a new tab', () => {
  const m = make();
  assert.deepEqual(strip(m.press('f')), [{ type: 'hints', newTab: false }]);
  assert.equal(m.state().mode, 'hints');
  assert.deepEqual(strip(m.press('a', 's')), [{ type: 'hintKey', key: 'a' }, { type: 'hintKey', key: 's' }]);
  assert.deepEqual(strip(m.press(ESCAPE)), [{ type: 'hintsCancel' }]);
  assert.equal(m.state().mode, 'normal');
  assert.deepEqual(strip(m.press('F')), [{ type: 'hints', newTab: true }]);
});

test('i enters insert; every key goes to the page except Esc', () => {
  const m = make();
  assert.deepEqual(strip(m.press('i')), [{ type: 'enterInsert' }]);
  assert.equal(m.state().mode, 'insert');
  for (const k of ['j', ':', 'q', 'f', 'g', 'x', 'Enter', 'Tab', 'ArrowDown']) {
    const ev = key(k);
    assert.deepEqual(strip(m.handle(ev, m.now() + 10)), [{ type: 'pageKey', ev }], k);
  }
  assert.deepEqual(strip(m.press(key('v', { ctrl: true }))).map((a) => a.type), ['pageKey']);
  assert.deepEqual(strip(m.handle({ type: 'paste', text: 'hi' }, m.now() + 10)), [{ type: 'pagePaste', text: 'hi' }]);
  assert.deepEqual(strip(m.press(ESCAPE)), [{ type: 'exitInsert' }]);
  assert.equal(m.state().mode, 'normal');
});

test('Esc in normal hands back only while holding', () => {
  const m = make({ holding: false });
  assert.deepEqual(m.press(ESCAPE), []);
  m.setHolding(true);
  assert.deepEqual(strip(m.press(ESCAPE)), [{ type: 'handBack' }]);
});

test('Esc Esc hands back', () => {
  const m = make({ holding: true });
  m.press('i');
  assert.deepEqual(strip(m.press(ESCAPE, ESCAPE)), [{ type: 'exitInsert' }, { type: 'handBack' }]);
  assert.equal(m.state().mode, 'normal');
});

test('Ctrl-C quits in normal, goes to the page in insert', () => {
  const m = make();
  assert.deepEqual(strip(m.press(key('c', { ctrl: true }))), [{ type: 'quit' }]);
  m.setMode('insert');
  const ev = key('c', { ctrl: true });
  assert.deepEqual(strip(m.handle(ev, m.now() + 10)), [{ type: 'pageKey', ev }]);
});

test('Ctrl-C quits from the : line, find line and hints', () => {
  for (const start of [':', '/', 'f']) {
    const m = make();
    m.press(start);
    const acts = strip(m.press(key('c', { ctrl: true })));
    assert.equal(acts.at(-1).type, 'quit', start);
    assert.equal(m.state().mode, 'normal');
  }
});

test('unmapped printable keys in normal are ignored', () => {
  const m = make();
  for (const k of ['z', 'Z', '1', '!', 'q']) assert.deepEqual(m.press(k), [], k);
});

test('navigation keys pass through to the page in normal; paste too', () => {
  const pass = [key('ArrowDown'), key(' '), key('Enter'), key('Tab'), key('Tab', { shift: true }), key('PageDown'),
    key('PageUp'), key('Home'), key('End'), key('a', { ctrl: true }), key('j', { alt: true }), key('c', { meta: true })];
  const agent = make({ agent: true });
  const solo = make({ agent: false });
  for (const ev of pass) {
    assert.deepEqual(agent.handle(ev, 1), [{ type: 'pageKey', ev, takesControl: true }], ev.key);
    assert.deepEqual(solo.handle(ev, 1), [{ type: 'pageKey', ev }], ev.key);
  }
  assert.deepEqual(agent.handle({ type: 'paste', text: 'x' }, 1), [{ type: 'pagePaste', text: 'x', takesControl: true }]);
  assert.deepEqual(solo.handle({ type: 'paste', text: 'x' }, 1), [{ type: 'pagePaste', text: 'x' }]);
  assert.equal(agent.state().mode, 'normal');
});

test('pending sequence times out cleanly', () => {
  let m = make();
  m.handle(key('g'), 0);
  assert.equal(m.state().pending, 'g');
  assert.deepEqual(m.tick(500), []);
  assert.equal(m.state().pending, 'g');
  assert.deepEqual(m.tick(1100), []);
  assert.equal(m.state().pending, '');
  // after the timeout, g starts a fresh sequence rather than completing gg
  assert.deepEqual(m.handle(key('g'), 1200), []);
  assert.equal(m.state().pending, 'g');

  // a late second key (no tick in between) is a fresh key, not the sequence
  m = make();
  m.handle(key('g'), 0);
  assert.deepEqual(strip(m.handle(key('j'), 1500)), [{ type: 'scroll', dx: 0, dy: 60 }]);

  // g then an unmapped-in-sequence key: no g-sequence fires; the key is handled on its own
  m = make();
  m.handle(key('g'), 0);
  assert.deepEqual(strip(m.handle(key('x'), 10)), [{ type: 'tab', op: 'close' }]);
  assert.equal(m.state().pending, '');
  m = make();
  m.handle(key('g'), 0);
  assert.deepEqual(m.handle(key('z'), 10), []);
  assert.equal(m.state().pending, '');

  // Esc cancels a partial command and does not hand back
  m = make({ holding: true });
  m.handle(key('y'), 0);
  assert.deepEqual(m.handle(ESCAPE, 10), []);
  assert.equal(m.state().pending, '');

  // g then i enters nothing odd: focusFirstInput only, mode unchanged (viewer decides Insert)
  m = make();
  m.handle(key('g'), 0);
  assert.deepEqual(strip(m.handle(key('i'), 10)), [{ type: 'focusFirstInput' }]);
  assert.equal(m.state().mode, 'normal');
});

test('takesControl flags follow the global constraints on agent browsers', () => {
  const takes = ['j', 'k', 'h', 'l', 'd', 'u', 'G', 'gg', 'f', 'F', 'i', 'gi', '/', 'n', 'N', 'H', 'L', 'r', 'J', 'K', 'gT', 'gt', 't', 'x'];
  for (const seq of takes) {
    const m = make({ agent: true });
    const acts = m.type(seq);
    assert.equal(acts.length, 1, seq);
    assert.equal(acts[0].takesControl, true, seq);
  }
  for (const [seq, want] of [[':o example.com', 'open'], [':esc', 'sendEscape']]) {
    const m = make({ agent: true });
    const acts = [...m.type(seq), ...m.press(ENTER)];
    assert.equal(acts.find((a) => a.type === want).takesControl, true, seq);
  }
  // insert typing takes control
  let m = make({ agent: true });
  m.press('i');
  assert.equal(m.press('a')[0].takesControl, true);
  assert.equal(m.handle({ type: 'paste', text: 'p' }, m.now() + 10)[0].takesControl, true);

  // never: ?, :help, yy, the : line typing, Esc, :done, :q, Ctrl-C, hint letters, exitInsert
  const never = [];
  m = make({ agent: true, holding: true });
  never.push(...m.press('?'), ...m.press('j'));
  never.push(...m.type('yy'));
  never.push(...m.type(':help'), ...m.press(ENTER), ...m.press(ESCAPE));
  never.push(...m.type(':done'), ...m.press(ENTER));
  never.push(...m.type(':q'), ...m.press(ENTER));
  never.push(...m.type(':xyz'), ...m.press(key('Backspace'), ESCAPE));
  never.push(...m.press(ESCAPE));
  never.push(...m.press(key('c', { ctrl: true })));
  m.press('f');
  never.push(...m.press('a', ESCAPE));
  m.press('i');
  never.push(...m.press(ESCAPE));
  assert.ok(never.length > 10);
  for (const a of never) assert.equal(a.takesControl, undefined, JSON.stringify(a));
});

test('standalone browsers never flag takesControl', () => {
  const m = make({ agent: false });
  const acts = [
    ...m.type('jkhldu'), ...m.type('ggG'), ...m.type('gigtgT'), ...m.type('HLrJKtx'), ...m.type('nN'),
    ...m.press('f', ESCAPE), ...m.press('/'), ...m.type('a'), ...m.press(ENTER),
    ...m.type(':o a.com'), ...m.press(ENTER), ...m.type(':esc'), ...m.press(ENTER),
    ...m.press('i', 'a'), ...m.handle({ type: 'paste', text: 'p' }, 9999),
  ];
  assert.ok(acts.length > 20);
  for (const a of acts) assert.equal('takesControl' in a, false, JSON.stringify(a));
});

test('setMode switches mode and clears pending and line', () => {
  const m = make();
  m.press('g');
  m.setMode('insert');
  assert.deepEqual(m.state(), { mode: 'insert', pending: '', line: '' });
  m.setMode('normal');
  m.type(':ab');
  m.setMode('normal');
  assert.deepEqual(m.state(), { mode: 'normal', pending: '', line: '' });
  assert.throws(() => m.setMode('visual'));
});

test('mouse, wheel, focus and reply events produce no actions (the viewer handles them)', () => {
  const m = make();
  m.press('g');
  assert.deepEqual(m.handle({ type: 'mouse', action: 'press', button: 'left', col: 1, row: 1 }, m.now() + 1), []);
  assert.equal(m.state().pending, '', 'a click cancels a partial command');
  assert.deepEqual(m.handle({ type: 'wheel', dx: 0, dy: 1, col: 1, row: 1 }, 1), []);
  assert.deepEqual(m.handle({ type: 'focus', in: true }, 1), []);
  assert.deepEqual(m.handle({ type: 'reply', raw: 'x' }, 1), []);
});
