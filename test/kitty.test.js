import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pngSize, encodeFrame, deleteAll, deleteImage, enterScreen, leaveScreen, kittyQuery, parseKittyReply } from '../src/kitty.js';

const ONE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const ESC = '\x1b';

test('pngSize reads IHDR', () => {
  assert.deepEqual(pngSize(ONE), { width: 1, height: 1 });
});

test('encodeFrame chunks at 4096', () => {
  const out = encodeFrame('A'.repeat(10000), { cols: 40, rows: 20 });
  assert.ok(out.startsWith(`${ESC}[H`));
  const seqs = out.split(`${ESC}_G`).slice(1);
  assert.equal(seqs.length, 3);
  assert.ok(seqs[0].startsWith('a=T,f=100,i=1,p=1,c=40,r=20,C=1,q=2,m=1;'));
  assert.ok(seqs[1].startsWith('m=1;'));
  assert.ok(seqs[2].startsWith('m=0;'));
  for (const s of seqs) {
    const payload = s.slice(s.indexOf(';') + 1, s.length - 2);
    assert.ok(s.endsWith(`${ESC}\\`));
    assert.ok(payload.length <= 4096);
  }
  assert.equal(seqs[2].slice(4, -2).length, 10000 - 8192);
});

test('deleteAll / screens', () => {
  assert.equal(deleteAll(), `${ESC}_Ga=d,d=A,q=2${ESC}\\`);
  assert.ok(enterScreen().includes('?1049h'));
  assert.ok(enterScreen().includes('?25l'));
  const l = leaveScreen();
  for (const s of ['?1049l', '?25h', 'a=d', '?1000l', '?1006l']) assert.ok(l.includes(s), s);
});

test('kitty query and reply parsing', () => {
  assert.equal(kittyQuery(), `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ESC}\\${ESC}[c`);
  assert.equal(parseKittyReply(`${ESC}_Gi=31;OK${ESC}\\${ESC}[?62;c`), true);
  assert.equal(parseKittyReply(`${ESC}[?62;c`), false);
  assert.equal(parseKittyReply(''), null);
});

test('deleteImage deletes one image by id, freeing its data', () => {
  assert.equal(deleteImage(2), `${ESC}_Ga=d,d=I,i=2,q=2${ESC}\\`);
  assert.equal(deleteImage(1), `${ESC}_Ga=d,d=I,i=1,q=2${ESC}\\`);
});
