// `termbrowse agents [--json]`: the live Chromes termbrowse started.
import { paths } from '../paths.js';
import { readRegistry } from '../registry.js';
import { listTargets } from '../cdp.js';
import { UsageError, parse } from './usage.js';

async function firstPageUrl(port) {
  try {
    return (await listTargets(port)).find((t) => t.type === 'page')?.url ?? null;
  } catch {
    return null;
  }
}

export async function runAgents(args, { stdout = process.stdout, env = process.env } = {}) {
  const { values, positionals } = parse(args, { json: { type: 'boolean' } });
  if (positionals.length) throw new UsageError(`agents: unexpected argument ${positionals[0]}`);
  const entries = await readRegistry(paths(env));
  const rows = await Promise.all(entries.map(async (e) => ({ ...e, url: await firstPageUrl(e.port) })));
  if (values.json) {
    stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const table = [
    ['AGENT', 'KIND', 'PORT', 'PID', 'URL'],
    ...rows.map((r) => [r.agentId, r.kind ?? '-', String(r.port), String(r.pid), r.url ?? '-']),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  for (const row of table) {
    stdout.write(`${row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}\n`);
  }
  return 0;
}
