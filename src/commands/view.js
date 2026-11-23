// `termbrowse view (--port N | --agent ID) [--tab MATCH]`: draw an existing Chrome's tab here.
import { paths } from '../paths.js';
import { findEntry } from '../registry.js';
import { runViewer } from '../viewer.js';
import { UsageError, parse } from './usage.js';

export async function runView(args, { stderr = process.stderr, env = process.env } = {}) {
  const { values, positionals } = parse(args, {
    port: { type: 'string' },
    agent: { type: 'string' },
    tab: { type: 'string' },
  });
  if (positionals.length) throw new UsageError(`view: unexpected argument ${positionals[0]}`);
  if ((values.port === undefined) === (values.agent === undefined)) {
    throw new UsageError('view needs exactly one of --port and --agent');
  }
  let port;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`view: invalid port ${values.port}`);
  } else {
    const entry = await findEntry(values.agent, paths(env));
    if (!entry) {
      stderr.write(`termbrowse: no browser for agent ${values.agent} (it starts on the agent's first browser action)\n`);
      return 1;
    }
    port = entry.port;
  }
  return runViewer({ port, match: values.tab, stderr, env });
}
