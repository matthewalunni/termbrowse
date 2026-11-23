import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths.js';
import { bundleId } from './chrome.js';

async function logFailure(cmd, reason) {
  try {
    const { logs } = paths();
    await mkdir(logs, { recursive: true, mode: 0o700 });
    await appendFile(join(logs, 'hook.log'), `${new Date().toISOString()} on_launch "${cmd}" ${reason}\n`);
  } catch {
    // logging must never fail the caller
  }
}

// Never rejects. A hook still running after timeoutMs is killed (its whole process group).
export async function runHook(cmd, { pid, port, agent, kind, headless }, { timeoutMs = 10_000 } = {}) {
  if (!cmd) return;
  const env = {
    ...process.env,
    TERMBROWSE_PID: String(pid),
    TERMBROWSE_PORT: String(port),
    TERMBROWSE_AGENT: String(agent),
    TERMBROWSE_KIND: String(kind),
    TERMBROWSE_HEADLESS: headless ? '1' : '0', // a headless Chrome has no window to place
    TERMBROWSE_BUNDLE_ID: bundleId(),
  };
  const reason = await new Promise((resolve) => {
    const child = spawn('sh', ['-c', cmd], { env, stdio: 'ignore', detached: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    const done = (reason) => {
      clearTimeout(timer);
      resolve(reason);
    };
    child.once('error', (err) => done(`failed to start: ${err.message}`));
    child.once('exit', (code, signal) => {
      if (timedOut) done(`timed out after ${timeoutMs} ms (killed)`);
      else done(code === 0 ? null : `failed: ${signal ? `signal ${signal}` : `code ${code}`}`);
    });
  });
  if (reason) await logFailure(cmd, reason);
}
