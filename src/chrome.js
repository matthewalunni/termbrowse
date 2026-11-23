import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, constants, mkdir, open, rename, stat, unlink } from 'node:fs/promises';

import { join } from 'node:path';
import {
  Browser, detectBrowserPlatform, install, computeExecutablePath, resolveBuildId, getInstalledBrowsers,
} from '@puppeteer/browsers';
import { paths } from './paths.js';
import { loadConfig, effectiveHeadless } from './config.js';
import { waitForPort } from './cdp.js';

export function bundleId(platform = process.platform) {
  return platform === 'darwin' ? 'com.google.chrome.for.testing' : '';
}

// Where the configured channel's current Chrome for Testing lives, and whether it is there yet.
// Resolving the channel's build id needs the network.
export async function findChrome(cfg, p = paths()) {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error(`Chrome for Testing has no build for ${process.platform}/${process.arch}`);
  const buildId = await resolveBuildId(Browser.CHROME, platform, cfg.chrome.channel);
  const cacheDir = join(p.cache, 'browsers');
  const executablePath = computeExecutablePath({ cacheDir, browser: Browser.CHROME, buildId });
  const installed = await access(executablePath, constants.X_OK).then(() => true, () => false);
  return { platform, buildId, cacheDir, executablePath, installed };
}

const RESOLVE_TIMEOUT_MS = 3000;
const INSTALL_LOCK_STALE_MS = 10 * 60_000; // a download that takes longer than this is presumed dead
const INSTALL_LOCK_RETRY_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isExecutable = (f) => access(f, constants.X_OK).then(() => true, () => false);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const compareBuilds = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

// The newest Chrome for Testing already in the cache for this platform, or null.
async function newestInstalled(cacheDir, platform) {
  const have = (await getInstalledBrowsers({ cacheDir }).catch(() => []))
    .filter((b) => b.browser === Browser.CHROME && b.platform === platform)
    .sort((a, b) => compareBuilds(b.buildId, a.buildId));
  for (const b of have) if (await isExecutable(b.executablePath)) return { executablePath: b.executablePath, buildId: b.buildId };
  return null;
}

// Exclusive-create lock in the cache dir, so concurrent starts download a build only once.
async function withInstallLock(cacheDir, fn, staleMs) {
  await mkdir(cacheDir, { recursive: true });
  const lock = join(cacheDir, 'install.lock');
  for (;;) {
    try {
      await (await open(lock, 'wx')).close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > staleMs) await unlink(lock).catch(() => {});
      else await sleep(INSTALL_LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

// The configured channel's current build, downloaded on first use. Looking the build up needs
// the network: when that fails or takes over resolveTimeoutMs, the newest build already
// installed is used instead.
export async function ensureChrome(
  cfg,
  p = paths(),
  {
    resolve = resolveBuildId,
    installer = install,
    resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
    lockStaleMs = INSTALL_LOCK_STALE_MS,
  } = {},
) {
  const platform = detectBrowserPlatform();
  if (!platform) throw new Error(`Chrome for Testing has no build for ${process.platform}/${process.arch}`);
  const cacheDir = join(p.cache, 'browsers');
  let buildId;
  try {
    buildId = await withTimeout(Promise.resolve().then(() => resolve(Browser.CHROME, platform, cfg.chrome.channel)), resolveTimeoutMs);
  } catch (err) {
    const have = await newestInstalled(cacheDir, platform);
    if (have) return have;
    throw new Error(`could not look up the current Chrome for Testing build (${err.message}) and none is installed in ${cacheDir}`);
  }
  const executablePath = computeExecutablePath({ cacheDir, browser: Browser.CHROME, buildId, platform });
  if (await isExecutable(executablePath)) return { executablePath, buildId };
  return withInstallLock(cacheDir, async () => {
    // Another process may have installed it while this one waited for the lock.
    if (await isExecutable(executablePath)) return { executablePath, buildId };
    process.stderr.write(`termbrowse: downloading Chrome for Testing ${buildId} (one time)...\n`);
    const result = await installer({ cacheDir, browser: Browser.CHROME, buildId, platform });
    return { executablePath: result.executablePath, buildId };
  }, lockStaleMs);
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

// Puppeteer's defaults that keep a page running at full speed when its window is hidden or
// covered (a viewer watches it through a screencast, not the window), and that let popups open.
// Left out on purpose: --enable-automation (infobar, sign-in blocks), --disable-extensions,
// --mute-audio, --use-mock-keychain and anything else that would change logins.
const DEFAULT_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-popup-blocking',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-features=Translate',
];

export function chromeArgs({ port, profileDir, headless, windowSize, extraArgs, url, platform = process.platform }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${windowSize[0]},${windowSize[1]}`,
    ...DEFAULT_FLAGS,
  ];
  if (headless) args.push('--headless=new');
  if (platform === 'linux') args.push('--password-store=basic', '--disable-dev-shm-usage');
  args.push(...extraArgs, url);
  return args;
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

  const args = chromeArgs({ port, profileDir, headless, windowSize, extraArgs, url });

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
