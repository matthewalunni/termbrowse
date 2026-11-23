#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const USAGE = `Usage: termbrowse [url]
       termbrowse view [url]
       termbrowse mcp [-- extra chrome-devtools-mcp args]
       termbrowse agents
       termbrowse stop [agent]
       termbrowse login
       termbrowse doctor
       termbrowse --version
`;

const SUBCOMMANDS = new Set(['view', 'mcp', 'agents', 'stop', 'login', 'doctor']);

async function main(argv) {
  const [first] = argv;
  if (first === '--version' || first === '-v') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return 0;
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (first?.startsWith('-')) {
    process.stderr.write(`termbrowse: unknown option ${first}\n${USAGE}`);
    return 2;
  }
  const name = SUBCOMMANDS.has(first) ? first : 'view';
  if (name === 'mcp') {
    const rest = argv.slice(1);
    const { runMcp } = await import('../src/mcp.js');
    return runMcp(rest[0] === '--' ? rest.slice(1) : rest);
  }
  process.stderr.write(`termbrowse: ${name} is not implemented yet\n`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
