import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toKeyEvents, isPrintable, matchesSpec } from '../src/keymap.js';
import { parseKeySpec } from '../src/config.js';

test('printable key gives keyDown with text and keyUp', () => {
  const evs = toKeyEvents({ key: 'a', text: 'a' });
  assert.equal(evs.length, 2);
  assert.equal(evs[0].type, 'keyDown');
  assert.equal(evs[0].text, 'a');
  assert.equal(evs[0].key, 'a');
  assert.equal(evs[0].code, 'KeyA');
  assert.equal(evs[0].windowsVirtualKeyCode, 65);
  assert.equal(evs[0].modifiers, 0);
  assert.equal(evs[1].type, 'keyUp');
  assert.equal(evs[1].text, undefined);
});

test('Enter', () => {
  const [down] = toKeyEvents({ key: 'Enter' });
  assert.equal(down.windowsVirtualKeyCode, 13);
  assert.equal(down.code, 'Enter');
  assert.equal(down.text, '\r');
});

test('ctrl+a has modifiers 2 and no text', () => {
  const [down, up] = toKeyEvents({ key: 'a', ctrl: true });
  assert.equal(down.modifiers, 2);
  assert.equal(down.text, undefined);
  assert.equal(down.type, 'rawKeyDown');
  assert.equal(up.modifiers, 2);
});

test('modifier bits', () => {
  const [down] = toKeyEvents({ key: 'A', alt: true, ctrl: true, meta: true, shift: true });
  assert.equal(down.modifiers, 15);
});

test('ArrowLeft', () => {
  const [down] = toKeyEvents({ key: 'ArrowLeft' });
  assert.equal(down.code, 'ArrowLeft');
  assert.equal(down.windowsVirtualKeyCode, 37);
});

test('punctuation and non-ASCII text', () => {
  const [bang] = toKeyEvents({ key: '!', text: '!', shift: true });
  assert.equal(bang.code, 'Digit1');
  assert.equal(bang.windowsVirtualKeyCode, 49);
  const [e] = toKeyEvents({ key: 'é', text: 'é' });
  assert.equal(e.text, 'é');
});

test('isPrintable', () => {
  assert.equal(isPrintable({ key: 'a', text: 'a' }), true);
  assert.equal(isPrintable({ key: 'a', ctrl: true }), false);
  assert.equal(isPrintable({ key: 'Enter' }), false);
});

test('matchesSpec', () => {
  assert.equal(matchesSpec({ key: ']', ctrl: true }, parseKeySpec('ctrl-]')), true);
  assert.equal(matchesSpec({ key: ']' }, parseKeySpec('ctrl-]')), false);
  assert.equal(matchesSpec({ key: 'g' }, parseKeySpec('g')), true);
  assert.equal(matchesSpec({ key: 'g', ctrl: true }, parseKeySpec('g')), false);
  assert.equal(matchesSpec({ key: 'x', alt: true }, parseKeySpec('alt-x')), true);
  assert.equal(matchesSpec({ key: 'Escape' }, parseKeySpec('escape')), true);
  assert.equal(matchesSpec({ key: ' ' }, parseKeySpec('space')), true);
});

test('matchesSpec compares ctrl letters case-insensitively', () => {
  assert.equal(matchesSpec({ key: 'a', ctrl: true }, parseKeySpec('ctrl-A')), true);
  assert.equal(matchesSpec({ key: 'A', ctrl: true }, parseKeySpec('ctrl-a')), true);
  assert.equal(matchesSpec({ key: 'G' }, parseKeySpec('g')), false);
});
