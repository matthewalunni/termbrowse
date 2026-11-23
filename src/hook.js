import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.js';
import { bundleId } from './chrome.js';

async function logFailure(cmd, reason) {
  try {
    const { logs } = paths();
    await mkdir(logs, { recursive: true });
    await appendFile(join(logs, 'hook.log'), `${new Date().toISOString()} on_launch "${cmd}" ${reason}\n`);
  } catch {
    // logging must never fail the caller
  }
}

export async function runHook(cmd, { pid, port, agent, kind }) {
  if (!cmd) return;
  const env = {
    ...process.env,
    TERMBROWSE_PID: String(pid),
    TERMBROWSE_PORT: String(port),
    TERMBROWSE_AGENT: String(agent),
    TERMBROWSE_KIND: String(kind),
    TERMBROWSE_BUNDLE_ID: bundleId(),
  };
  const reason = await new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { env, stdio: 'ignore' });
    child.once('error', (err) => resolve(`failed to start: ${err.message}`));
    child.once('exit', (code, signal) => resolve(code === 0 ? null : `failed: ${signal ? `signal ${signal}` : `code ${code}`}`));
  });
  if (reason) await logFailure(cmd, reason);
}
