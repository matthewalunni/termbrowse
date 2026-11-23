import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { termSize, detectKitty, knownKittyTerminal } from '../src/tty.js';
import { kittyQuery } from '../src/kitty.js';

function streams() {
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 61;
  stdout.rows = 40;
  let out = '';
  stdout.on('data', (d) => { out += d; });
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (v) => { stdin.isRaw = v; return stdin; };
  return { stdin, stdout, out: () => out };
}

const Q = '\x1b[16t\x1b[14t\x1b[c';

test('termSize prefers the 16t cell size over a conflicting 14t, replies split across chunks', async () => {
  const { stdin, stdout, out } = streams();
  const p = termSize(stdin, stdout, 500);
  setImmediate(() => {
    stdin.write('\x1b[6;3');
    setImmediate(() => stdin.write('7;17t\x1b[4;4440;3400t\x1b[?6'));
    setImmediate(() => setImmediate(() => stdin.write('2;c')));
  });
  assert.deepEqual(await p, { cols: 61, rows: 40, pxW: 17 * 61, pxH: 37 * 40 });
  assert.equal(out(), Q);
  assert.equal(stdin.isRaw, false, 'raw mode restored');
  assert.equal(stdin.listenerCount('data'), 0, 'listener removed');
});

test('termSize falls back to a plausible 14t when 16t is not answered', async () => {
  const { stdin, stdout } = streams();
  const p = termSize(stdin, stdout, 500);
  setImmediate(() => {
    stdin.write('\x1b[4;14');
    setImmediate(() => stdin.write('80;1037t\x1b[?62;c'));
  });
  assert.deepEqual(await p, { cols: 61, rows: 40, pxW: 1037, pxH: 1480 });
});

test('termSize gives zeros when the only reply is implausible', async () => {
  const { stdin, stdout } = streams();
  stdout.columns = 120;
  const p = termSize(stdin, stdout, 500);
  setImmediate(() => stdin.write('\x1b[4;4440;3400t\x1b[?62;c'));
  assert.deepEqual(await p, { cols: 120, rows: 40, pxW: 0, pxH: 0 });
});

test('termSize ignores an implausible 16t and uses a plausible 14t', async () => {
  const { stdin, stdout } = streams();
  const p = termSize(stdin, stdout, 500);
  setImmediate(() => stdin.write('\x1b[6;200;2t\x1b[4;1480;1037t\x1b[?62;c'));
  assert.deepEqual(await p, { cols: 61, rows: 40, pxW: 1037, pxH: 1480 });
});

test('termSize uses what arrived when DA1 never comes', async () => {
  const { stdin, stdout } = streams();
  const p = termSize(stdin, stdout, 80);
  setImmediate(() => stdin.write('\x1b[4;1480;1037t'));
  assert.deepEqual(await p, { cols: 61, rows: 40, pxW: 1037, pxH: 1480 });
});

test('termSize gives zero pixels on timeout and keeps raw mode as it was', async () => {
  const { stdin, stdout } = streams();
  stdin.isRaw = true;
  assert.deepEqual(await termSize(stdin, stdout, 50), { cols: 61, rows: 40, pxW: 0, pxH: 0 });
  assert.equal(stdin.isRaw, true);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('detectKitty is true on an OK reply split across chunks', async () => {
  const { stdin, stdout, out } = streams();
  const p = detectKitty(stdin, stdout, 500, {});
  setImmediate(() => {
    stdin.write('\x1b_Gi=3');
    setImmediate(() => stdin.write('1;OK\x1b\\\x1b[?62;c'));
  });
  assert.equal(await p, true);
  assert.equal(out(), kittyQuery());
  assert.equal(stdin.isRaw, false);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('detectKitty is false when only DA1 answers', async () => {
  const { stdin, stdout } = streams();
  const p = detectKitty(stdin, stdout, 500, {});
  setImmediate(() => stdin.write('\x1b[?62;22c'));
  assert.equal(await p, false);
});

test('detectKitty is false on timeout', async () => {
  const { stdin, stdout } = streams();
  assert.equal(await detectKitty(stdin, stdout, 50, {}), false);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('TERMBROWSE_ASSUME_KITTY=1 skips the query', async () => {
  const { stdin, stdout, out } = streams();
  assert.equal(await detectKitty(stdin, stdout, 50, { TERMBROWSE_ASSUME_KITTY: '1' }), true);
  assert.equal(out(), '');
});

test('knownKittyTerminal recognises terminals that draw Kitty graphics', () => {
  for (const env of [
    { TERMBROWSE_ASSUME_KITTY: '1' },
    { HC_TERMINAL_ID: 't3' },
    { KITTY_WINDOW_ID: '1' },
    { TERM: 'xterm-kitty' },
    { TERM: 'XTERM-GHOSTTY' },
    { TERM_PROGRAM: 'ghostty' },
    { TERM_PROGRAM: 'WezTerm' },
    { TERM_PROGRAM: 'wezterm' },
  ]) assert.equal(knownKittyTerminal(env), true, JSON.stringify(env));
  assert.equal(knownKittyTerminal({ TERM: 'xterm-256color' }), false);
  assert.equal(knownKittyTerminal({ TERMBROWSE_ASSUME_KITTY: '0' }), false);
  assert.equal(knownKittyTerminal({}), false);
});

test('detectKitty skips the query for a known terminal and queries otherwise', async () => {
  const a = streams();
  assert.equal(await detectKitty(a.stdin, a.stdout, 50, { HC_TERMINAL_ID: 't3' }), true);
  assert.equal(a.out(), '');
  const b = streams();
  const p = detectKitty(b.stdin, b.stdout, 500, { TERM: 'xterm-256color' });
  setImmediate(() => b.stdin.write('\x1b[?62;c'));
  assert.equal(await p, false);
  assert.equal(b.out(), kittyQuery());
});

test('a DA1 that trails the Kitty OK is consumed by detectKitty, not mistaken by termSize', async () => {
  const { stdin, stdout } = streams();
  const k = detectKitty(stdin, stdout, 500, {});
  setImmediate(() => {
    stdin.write('\x1b_Gi=31;OK\x1b\\');
    setImmediate(() => stdin.write('\x1b[?62;c'));
  });
  assert.equal(await k, true);
  const p = termSize(stdin, stdout, 500);
  setImmediate(() => {
    stdin.write('\x1b[6;37;17t\x1b[4;14');
    setImmediate(() => stdin.write('80;1037t\x1b[?62;c'));
  });
  assert.deepEqual(await p, { cols: 61, rows: 40, pxW: 1037, pxH: 1480 });
});
