// `termbrowse view (--port N | --agent ID) [--tab MATCH] [--watch]`: draw an existing Chrome's tab here.
import { paths } from '../paths.js';
import { loadConfig } from '../config.js';
import { findEntry, readRegistry } from '../registry.js';
import { runViewer } from '../viewer.js';
import { UsageError, parse } from './usage.js';
import { FILL_OPTIONS, fillFlag, resolveFill } from './fill.js';

// Which kind of browser owns a port, for resolveFill. A port termbrowse did not start may be
// someone's own Chrome ('unknown'): only --fill resizes its page.
const kindOf = (entry) => {
  if (!entry) return 'unknown';
  return entry.kind === 'standalone' ? 'standalone' : 'agent';
};

export async function kindOfPort(port, p) {
  return kindOf((await readRegistry(p)).find((e) => e.port === port));
}

export async function runView(args, { stderr = process.stderr, env = process.env, viewer = runViewer } = {}) {
  const { values, positionals } = parse(args, {
    port: { type: 'string' },
    agent: { type: 'string' },
    tab: { type: 'string' },
    watch: { type: 'boolean' },
    ...FILL_OPTIONS,
  });
  if (positionals.length) throw new UsageError(`view: unexpected argument ${positionals[0]}`);
  if ((values.port === undefined) === (values.agent === undefined)) {
    throw new UsageError('view needs exactly one of --port and --agent');
  }
  const flag = fillFlag(values);
  let port;
  let entry;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`view: invalid port ${values.port}`);
    entry = (await readRegistry(paths(env))).find((e) => e.port === port);
  } else {
    entry = await findEntry(values.agent, paths(env));
    if (!entry) {
      stderr.write(`termbrowse: no browser for agent ${values.agent} (it starts on the agent's first browser action)\n`);
      return 1;
    }
    port = entry.port;
  }
  const kind = values.agent !== undefined ? 'agent' : kindOf(entry);
  const cfg = await loadConfig(env);
  return viewer({
    port,
    match: values.tab,
    stderr,
    env,
    fill: resolveFill({ kind, ...cfg.view, flag }),
    interactive: !values.watch && cfg.view.interactive, // watch only: no input, never takes control
    // Control (and the agent's wait) applies to agent browsers only.
    control: { agentId: kindOf(entry) === 'agent' ? entry.agentId : null, idleReturnMs: cfg.control.idleReturnMs },
  });
}
