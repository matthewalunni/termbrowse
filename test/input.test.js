import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputParser } from '../src/input.js';

const ESC = '\x1b';
const parse = (...chunks) => {
  const p = new InputParser();
  return chunks.flatMap((c) => p.push(c));
};

test('SGR press and release', () => {
  const [press] = parse(`${ESC}[<0;10;5M`);
  assert.deepEqual(press, { type: 'mouse', action: 'press', button: 'left', col: 10, row: 5, shift: false, alt: false, ctrl: false });
  const [release] = parse(`${ESC}[<0;10;5m`);
  assert.equal(release.action, 'release');
  assert.equal(release.button, 'left');
});

test('SGR motion with no button', () => {
  const [ev] = parse(`${ESC}[<35;3;4M`);
  assert.equal(ev.type, 'mouse');
  assert.equal(ev.action, 'move');
  assert.equal(ev.button, 'none');
  assert.equal(ev.col, 3);
  assert.equal(ev.row, 4);
});

test('SGR right and middle buttons', () => {
  assert.equal(parse(`${ESC}[<1;1;1M`)[0].button, 'middle');
  assert.equal(parse(`${ESC}[<2;1;1M`)[0].button, 'right');
});

test('SGR wheel up and down', () => {
  assert.deepEqual(parse(`${ESC}[<64;3;4M`)[0], { type: 'wheel', dx: 0, dy: -1, col: 3, row: 4, shift: false, alt: false, ctrl: false });
  assert.equal(parse(`${ESC}[<65;3;4M`)[0].dy, 1);
});

test('SGR modifier bits', () => {
  const [ev] = parse(`${ESC}[<4;1;1M`);
  assert.equal(ev.shift, true);
  assert.equal(ev.button, 'left');
  const [ev2] = parse(`${ESC}[<24;1;1M`);
  assert.equal(ev2.alt, true);
  assert.equal(ev2.ctrl, true);
});

test('sequence split across chunks yields one press', () => {
  const evs = parse(`${ESC}[<0;1`, '0;5M');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].action, 'press');
  assert.equal(evs[0].col, 10);
  assert.equal(evs[0].row, 5);
});

test('Kitty CSI-u ctrl+a', () => {
  const [ev] = parse(`${ESC}[97;5u`);
  assert.equal(ev.type, 'key');
  assert.equal(ev.key, 'a');
  assert.equal(ev.ctrl, true);
  assert.equal(ev.text, undefined);
});

test('Kitty CSI-u Enter and sub-params', () => {
  assert.equal(parse(`${ESC}[13u`)[0].key, 'Enter');
  const [shiftA] = parse(`${ESC}[97:65;2u`);
  assert.equal(shiftA.key, 'A');
  assert.equal(shiftA.shift, true);
  assert.equal(shiftA.text, 'A');
  const [rep] = parse(`${ESC}[97;1:2u`);
  assert.equal(rep.repeat, true);
  assert.deepEqual(parse(`${ESC}[97;1:3u`), []);
});

test('Kitty ctrl+] matches the prefix shape', () => {
  const [ev] = parse(`${ESC}[93;5u`);
  assert.equal(ev.key, ']');
  assert.equal(ev.ctrl, true);
});

test('legacy keys', () => {
  assert.equal(parse('\x7f')[0].key, 'Backspace');
  assert.equal(parse('\r')[0].key, 'Enter');
  assert.equal(parse('\t')[0].key, 'Tab');
  assert.equal(parse(`${ESC}[D`)[0].key, 'ArrowLeft');
  assert.equal(parse(`${ESC}[A`)[0].key, 'ArrowUp');
  assert.equal(parse(`${ESC}[H`)[0].key, 'Home');
  assert.equal(parse(`${ESC}[F`)[0].key, 'End');
  assert.equal(parse(`${ESC}[3~`)[0].key, 'Delete');
  assert.equal(parse(`${ESC}[15~`)[0].key, 'F5');
  assert.equal(parse(`${ESC}[24~`)[0].key, 'F12');
  assert.equal(parse(`${ESC}OP`)[0].key, 'F1');
  assert.equal(parse(`${ESC}OS`)[0].key, 'F4');
  const [ctrlLeft] = parse(`${ESC}[1;5D`);
  assert.equal(ctrlLeft.key, 'ArrowLeft');
  assert.equal(ctrlLeft.ctrl, true);
});

test('legacy C0 control maps to ctrl-letter', () => {
  const [ev] = parse('\x01');
  assert.equal(ev.key, 'a');
  assert.equal(ev.ctrl, true);
  assert.equal(ev.text, undefined);
  const [prefix] = parse('\x1d');
  assert.equal(prefix.key, ']');
  assert.equal(prefix.ctrl, true);
});

test('Alt as ESC prefix', () => {
  const [ev] = parse(`${ESC}x`);
  assert.equal(ev.key, 'x');
  assert.equal(ev.alt, true);
  assert.equal(ev.text, undefined);
});

test('multiple keys in one chunk keep order', () => {
  const evs = parse('héllo');
  assert.deepEqual(evs.map((e) => e.key), ['h', 'é', 'l', 'l', 'o']);
  assert.deepEqual(evs.map((e) => e.text), ['h', 'é', 'l', 'l', 'o']);
  assert.ok(evs.every((e) => e.type === 'key' && !e.ctrl && !e.alt));
});

test('uppercase letter sets shift', () => {
  const [ev] = parse('Q');
  assert.equal(ev.key, 'Q');
  assert.equal(ev.shift, true);
  assert.equal(ev.code, 'KeyQ');
});

test('utf-8 split across Buffer chunks', () => {
  const bytes = Buffer.from('é');
  const evs = parse(bytes.subarray(0, 1), bytes.subarray(1));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].key, 'é');
});

test('bracketed paste', () => {
  const evs = parse(`${ESC}[200~hi there\n${ESC}[201~`);
  assert.deepEqual(evs, [{ type: 'paste', text: 'hi there\n' }]);
});

test('bracketed paste split across chunks', () => {
  const evs = parse(`${ESC}[200~hi `, 'there', `${ESC}[20`, '1~x');
  assert.deepEqual(evs.map((e) => e.type), ['paste', 'key']);
  assert.equal(evs[0].text, 'hi there');
});

test('mixed reply and click in one chunk', () => {
  const evs = parse(`${ESC}[6;37;17t${ESC}[<0;2;2M`);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0], { type: 'reply', raw: `${ESC}[6;37;17t` });
  assert.equal(evs[1].type, 'mouse');
  assert.equal(evs[1].action, 'press');
});

test('terminal replies pass through', () => {
  const raws = [`${ESC}[4;800;1200t`, `${ESC}[?62;22c`, `${ESC}_Gi=31;OK${ESC}\\`, `${ESC}[?1u`];
  for (const raw of raws) assert.deepEqual(parse(raw), [{ type: 'reply', raw }]);
});

test('lone ESC becomes Escape on flush', () => {
  const p = new InputParser();
  assert.deepEqual(p.push(ESC), []);
  const evs = p.flush();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].key, 'Escape');
  assert.deepEqual(p.flush(), []);
});

test('flush leaves an incomplete mouse sequence pending', () => {
  const p = new InputParser();
  p.push(`${ESC}[<0;1`);
  assert.deepEqual(p.flush(), []);
  assert.equal(p.push('0;5M')[0].action, 'press');
});

test('legacy-form Kitty releases are dropped and repeats marked', () => {
  assert.deepEqual(parse(`${ESC}[1;1:3D`), []);
  assert.deepEqual(parse(`${ESC}[3;5:3~`), []);
  const [left] = parse(`${ESC}[1;5D`);
  assert.equal(left.key, 'ArrowLeft');
  assert.equal(left.ctrl, true);
  assert.equal(left.repeat, false);
  const [rep] = parse(`${ESC}[1;1:2A`);
  assert.equal(rep.key, 'ArrowUp');
  assert.equal(rep.repeat, true);
});

test('Kitty shifted symbols use associated text and alternate keys', () => {
  const [bang] = parse(`${ESC}[49:33;2;33u`);
  assert.equal(bang.key, '!');
  assert.equal(bang.text, '!');
  assert.equal(bang.shift, true);
  const [at] = parse(`${ESC}[50:64;2;64u`);
  assert.equal(at.key, '@');
  assert.equal(at.text, '@');
  const [altOnly] = parse(`${ESC}[49:33;2u`);
  assert.equal(altOnly.key, '!');
  assert.equal(altOnly.text, '!');
});

test('Kitty caps lock takes the key from associated text', () => {
  const [ev] = parse(`${ESC}[97;65;65u`);
  assert.equal(ev.key, 'A');
  assert.equal(ev.text, 'A');
  const [plain] = parse(`${ESC}[97u`);
  assert.equal(plain.key, 'a');
  assert.equal(plain.text, 'a');
});

test('SGR extra buttons (128+) are dropped', () => {
  assert.deepEqual(parse(`${ESC}[<128;5;5M`), []);
  assert.deepEqual(parse(`${ESC}[<129;5;5m`), []);
});
