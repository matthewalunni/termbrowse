import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { termSize, detectKitty } from '../src/tty.js';
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

test('termSize reads cols/rows from stdout and pixels from a reply split across chunks', async () => {
  const { stdin, stdout, out } = streams();
  const p = termSize(stdin, stdout, 500);
  setImmediate(() => {
    stdin.write('\x1b[4;14');
    setImmediate(() => stdin.write('80;1037t'));
  });
  assert.deepEqual(await p, { cols: 61, rows: 40, pxW: 1037, pxH: 1480 });
  assert.equal(out(), '\x1b[14t');
  assert.equal(stdin.isRaw, false, 'raw mode restored');
  assert.equal(stdin.listenerCount('data'), 0, 'listener removed');
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
