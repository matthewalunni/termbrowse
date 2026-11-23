#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

// Before anything else is loaded: the commands need Node 22 (global WebSocket, fs.cp, ...).
if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write(`termbrowse: needs Node 22 or newer (this is ${process.versions.node})\n`);
  process.exit(1);
}

const USAGE = `Usage: termbrowse <url>
       termbrowse view (--port N | --agent ID) [--tab MATCH]
       termbrowse mcp [-- extra chrome-devtools-mcp args]
       termbrowse agents [--json]
       termbrowse stop (--agent ID | --all)
       termbrowse login [url] [--reset]
       termbrowse doctor
       termbrowse --version

termbrowse <url> opens the page in a fresh browser drawn in this terminal; the profile is a
copy of the login profile and is thrown away on exit. Sign in with \`termbrowse login\`.
`;

const COMMANDS = {
  view: async (args) => (await import('../src/commands/view.js')).runView(args),
  agents: async (args) => (await import('../src/commands/agents.js')).runAgents(args),
  stop: async (args) => (await import('../src/commands/stop.js')).runStop(args),
  login: async (args) => (await import('../src/commands/login.js')).runLogin(args),
  doctor: async (args) => (await import('../src/commands/doctor.js')).runDoctor(args),
  mcp: async (args) => {
    const { runMcp } = await import('../src/mcp.js');
    return runMcp(args[0] === '--' ? args.slice(1) : args);
  },
};

async function main(argv) {
  const [first, ...rest] = argv;
  if (first === '--version' || first === '-v') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (first.startsWith('-')) {
    process.stderr.write(`termbrowse: unknown option ${first}\n${USAGE}`);
    return 2;
  }
  // A bare word that can't be a URL is a mistyped command (`termbrowse agnets`), not a site.
  if (!Object.hasOwn(COMMANDS, first) && !/[.:/]/.test(first) && first.toLowerCase() !== 'localhost') {
    process.stderr.write(`termbrowse: unknown command ${first}\n${USAGE}`);
    return 2;
  }
  const { UsageError } = await import('../src/commands/usage.js');
  try {
    if (Object.hasOwn(COMMANDS, first)) return await COMMANDS[first](rest);
    if (rest.length) throw new UsageError(`unexpected argument ${rest[0]} after the URL`);
    const { runBrowse } = await import('../src/commands/browse.js');
    return await runBrowse(first);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`termbrowse: ${err.message}\n${USAGE}`);
      return 2;
    }
    process.stderr.write(`termbrowse: ${err.message}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
