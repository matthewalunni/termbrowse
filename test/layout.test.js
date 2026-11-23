import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fit, screencastSize, saneSize, cellToPage } from '../src/layout.js';

const term = { cols: 61, rows: 40, pxW: 1037, pxH: 1480 };

test('fit keeps aspect', () => {
  assert.deepEqual(fit({ width: 1037, height: 538 }, term), { cols: 61, rows: 14 });
});

test('fit is at least 1x1 and within budget', () => {
  assert.deepEqual(fit({ width: 10, height: 10000 }, term), { cols: 1, rows: 39 });
  const r = fit({ width: 1, height: 1 }, term);
  assert.ok(r.cols >= 1 && r.rows >= 1 && r.cols <= 61 && r.rows <= 39);
});

test('saneSize', () => {
  assert.equal(saneSize({ cols: 600, rows: 40, pxW: 10200, pxH: 1480 }), false);
  assert.equal(saneSize(term), true);
  assert.equal(saneSize({ cols: 80, rows: 24, pxW: 0, pxH: 0 }), false);
});

test('screencastSize caps', () => {
  assert.deepEqual(screencastSize(term), { maxWidth: 1037, maxHeight: 1443 });
  assert.deepEqual(screencastSize({ cols: 200, rows: 120, pxW: 3400, pxH: 4440 }), { maxWidth: 2000, maxHeight: 1600 });
});

test('cellToPage', () => {
  const p = cellToPage(1, 1, { cols: 61, rows: 14 }, term, { width: 1280, height: 664 });
  assert.ok(Math.abs(p.x - 10.5) < 1 && Math.abs(p.y - 23.7) < 1);
  assert.equal(cellToPage(1, 15, { cols: 61, rows: 14 }, term, { width: 1280, height: 664 }), null);
  assert.equal(cellToPage(62, 1, { cols: 61, rows: 14 }, term, { width: 1280, height: 664 }), null);
});
