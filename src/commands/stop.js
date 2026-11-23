// `termbrowse stop (--agent ID | --all)`: close Chromes termbrowse started.
import { paths } from '../paths.js';
import { readRegistry, removeEntry, killEntry } from '../registry.js';
import { UsageError, parse } from './usage.js';

export async function runStop(args, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  const { values, positionals } = parse(args, { agent: { type: 'string' }, all: { type: 'boolean' } });
  if (positionals.length) throw new UsageError(`stop: unexpected argument ${positionals[0]}`);
  if ((values.agent === undefined) === !values.all) throw new UsageError('stop needs exactly one of --agent and --all');
  const p = paths(env);
  const live = await readRegistry(p);
  const targets = values.all ? live : live.filter((e) => e.agentId === values.agent);
  if (!targets.length) {
    if (values.all) {
      stdout.write('nothing to stop\n');
      return 0;
    }
    stderr.write(`termbrowse: no browser for agent ${values.agent}\n`);
    return 1;
  }
  await Promise.all(
    targets.map(async (e) => {
      const killed = await killEntry(e, stderr);
      await removeEntry(e.agentId, p);
      if (killed) stdout.write(`stopped ${e.agentId} (pid ${e.pid}, port ${e.port})\n`);
    }),
  );
  return 0;
}
