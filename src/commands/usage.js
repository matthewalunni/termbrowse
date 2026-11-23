import { parseArgs } from 'node:util';

// Thrown for bad arguments; the CLI prints the message and usage, and exits 2.
export class UsageError extends Error {}

export function parse(args, options) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
}
