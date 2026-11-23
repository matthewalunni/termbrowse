// Whether the viewer makes the page fill the pane (lays it out at the pane's size).
import { UsageError } from './usage.js';

// kind: 'standalone' (a `termbrowse <url>` browser), 'agent' (an agent's browser) or
// 'unknown' (a port termbrowse did not start: someone's own Chrome). flag: --fill / --no-fill.
export function resolveFill({ kind, fillPane, fillPaneForAgents, flag }) {
  if (flag !== undefined) return flag;
  if (kind === 'standalone') return fillPane;
  if (kind === 'agent') return fillPaneForAgents;
  return false;
}

// parseArgs options for the two flags, and the flag value they give.
export const FILL_OPTIONS = { fill: { type: 'boolean' }, 'no-fill': { type: 'boolean' } };

export function fillFlag(values) {
  if (values.fill && values['no-fill']) throw new UsageError('--fill and --no-fill cannot be used together');
  if (values.fill) return true;
  if (values['no-fill']) return false;
  return undefined;
}
