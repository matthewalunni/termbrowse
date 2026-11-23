import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFill, fillFlag } from '../src/commands/fill.js';
import { UsageError } from '../src/commands/usage.js';

test('resolveFill: config per kind of browser; flags override', () => {
  // [fillPane, fillPaneForAgents, standalone, agent, unknown]
  const table = [
    [true, false, true, false, false],
    [true, true, true, true, false],
    [false, false, false, false, false],
    [false, true, false, true, false],
  ];
  const kinds = ['standalone', 'agent', 'unknown'];
  for (const [fillPane, fillPaneForAgents, ...want] of table) {
    kinds.forEach((kind, i) => {
      const cfg = `${kind} fill_pane=${fillPane} fill_pane_for_agents=${fillPaneForAgents}`;
      assert.equal(resolveFill({ kind, fillPane, fillPaneForAgents }), want[i], cfg);
      assert.equal(resolveFill({ kind, fillPane, fillPaneForAgents, flag: true }), true, `${cfg} --fill`);
      assert.equal(resolveFill({ kind, fillPane, fillPaneForAgents, flag: false }), false, `${cfg} --no-fill`);
    });
  }
});

test('fillFlag: --fill, --no-fill, neither, both', () => {
  assert.equal(fillFlag({ fill: true }), true);
  assert.equal(fillFlag({ 'no-fill': true }), false);
  assert.equal(fillFlag({}), undefined);
  assert.throws(() => fillFlag({ fill: true, 'no-fill': true }), /--fill/);
  assert.throws(() => fillFlag({ fill: true, 'no-fill': true }), UsageError);
});
