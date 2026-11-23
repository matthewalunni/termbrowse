import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, constants, mkdir, open, rename } from 'node:fs/promises';

import { join } from 'node:path';
import { Browser, detectBrowserPlatform, install, computeExecutablePath, resolveBuildId } from '@puppeteer/browsers';
import { paths } from './paths.js';
import { loadConfig, effectiveHeadless } from './config.js';
import { waitForPort } from './cdp.js';

export function bundleId(platform = process.platform) {
  return platform === 'darwin' ? 'com.google.chrome.for.testing' : '';
}

export async function ensureChrome(cfg, p = paths()) {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error(`Chrome for Testing has no build for ${process.platform}/${process.arch}`);
  const buildId = await resolveBuildId(Browser.CHROME, platform, cfg.chrome.channel);
  const cacheDir = join(p.cache, 'browsers');
  const executablePath = computeExecutablePath({ cacheDir, browser: Browser.CHROME, buildId });
  try {
    await access(executablePath, constants.X_OK);
    return { executablePath, buildId };
  } catch {
    // not installed yet
  }
  process.stderr.write(`termbrowse: downloading Chrome for Testing ${buildId} (one time)...\n`);
  const installed = await install({ cacheDir, browser: Browser.CHROME, buildId, platform });
  return { executablePath: installed.executablePath, buildId };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function launchChrome({
  profileDir,
  url = 'about:blank',
  headless,
  windowSize,
  extraArgs,
  port,
  executablePath,
  startTimeoutMs = 15000,
  killGraceMs = 3000,
}) {
  const cfg = await loadConfig();
  headless ??= effectiveHeadless(cfg);
  windowSize ??= cfg.chrome.windowSize;
  extraArgs ??= cfg.chrome.extraArgs;
  executablePath ??= (await ensureChrome(cfg)).executablePath;
  port ??= await freePort();

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${windowSize[0]},${windowSize[1]}`,
  ];
  if (headless) args.push('--headless=new');
  if (process.platform === 'linux') args.push('--password-store=basic');
  args.push(...extraArgs, url);

  const { logs } = paths();
  await mkdir(logs, { recursive: true });
  const tmpLog = join(logs, `chrome-starting-${process.pid}-${port}.log`);
  const fh = await open(tmpLog, 'a');
  // Attach listeners in the same tick as spawn: a spawn failure emits 'error' asynchronously.
  const child = spawn(executablePath, args, { detached: true, stdio: ['ignore', fh.fd, fh.fd] });
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.on('error', resolve);
  });
  const spawnFailed = new Promise((_, reject) => child.on('error', reject));
  spawnFailed.catch(() => {}); // the race below observes it; avoid an unhandled rejection meanwhile
  // Fail fast when Chrome quits before its port opens (bad flags, profile in use, crash).
  const exitedEarly = new Promise((_, reject) =>
    child.once('exit', (code, sig) =>
      reject(new Error(`Chrome exited before opening its debugging port (${sig ? `signal ${sig}` : `code ${code}`}); see ${tmpLog}`)),
    ),
  );
  exitedEarly.catch(() => {});
  await fh.close();
  child.unref();

  // The child leads its own process group (detached), so signal the group to reach helpers too.
  const signal = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  const kill = async () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), killGraceMs);
    await exited;
    clearTimeout(timer);
  };

  const stopWaiting = new AbortController();
  try {
    await Promise.race([spawnFailed, exitedEarly, waitForPort(port, startTimeoutMs, stopWaiting.signal)]);
  } catch (err) {
    await kill();
    throw err;
  } finally {
    stopWaiting.abort(); // stop polling once the race is decided
  }
  await rename(tmpLog, join(logs, `chrome-${child.pid}.log`)).catch(() => {});
  return { pid: child.pid, port, child, kill };
}
