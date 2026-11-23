// `termbrowse doctor`: one line per check, ok / warn / fail; exit 1 if anything fails.
import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { Browser, getInstalledBrowsers } from '@puppeteer/browsers';
import { paths } from '../paths.js';
import { loadConfig } from '../config.js';
import { findChrome } from '../chrome.js';
import { kittyTerminalName, detectKitty } from '../tty.js';
import { UsageError, parse } from './usage.js';

const CHROME_CHECK_MS = 15_000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function checkChrome(cfg, p) {
  try {
    const c = await withTimeout(findChrome(cfg, p), CHROME_CHECK_MS, 'looking up the current build');
    const line = c.installed
      ? ['ok', `${c.buildId} installed`]
      : ['ok', `${c.buildId} not installed yet; it downloads on first use`];
    return { line, executablePath: c.installed ? c.executablePath : null };
  } catch (err) {
    // Offline: fall back to whatever is already in the cache.
    const have = await getInstalledBrowsers({ cacheDir: join(p.cache, 'browsers') }).catch(() => []);
    const chrome = have.filter((b) => b.browser === Browser.CHROME).at(-1);
    if (chrome) return { line: ['warn', `${chrome.buildId} installed; could not check for the current build: ${err.message}`], executablePath: chrome.executablePath };
    return { line: ['fail', `not installed and not downloadable: ${err.message}`], executablePath: null };
  }
}

// Debian/Ubuntu (t64 names, as on Ubuntu 24.04 and Debian 13) package for each library
// Chrome for Testing needs that a minimal system may lack, by .so name without its version.
const DEBIAN_PACKAGES = {
  libnss3: 'libnss3', libnssutil3: 'libnss3', libsmime3: 'libnss3',
  libnspr4: 'libnspr4', libplc4: 'libnspr4', libplds4: 'libnspr4',
  'libatk-1.0': 'libatk1.0-0t64',
  'libatk-bridge-2.0': 'libatk-bridge2.0-0t64',
  libcups: 'libcups2t64',
  libxkbcommon: 'libxkbcommon0',
  libasound: 'libasound2t64',
  libcairo: 'libcairo2',
  'libpango-1.0': 'libpango-1.0-0',
  libXdamage: 'libxdamage1',
  libatspi: 'libatspi2.0-0t64',
  libgbm: 'libgbm1',
  libXcomposite: 'libxcomposite1',
  libXrandr: 'libxrandr2',
  libXfixes: 'libxfixes3',
};

// The packages that provide the missing libraries, in order, each once; libraries with no
// known package are returned as-is in `unknown`.
export function aptPackages(missing) {
  const packages = [];
  const unknown = [];
  for (const lib of missing) {
    const pkg = DEBIAN_PACKAGES[lib.replace(/\.so(\.\d+)*$/, '')];
    if (!pkg) unknown.push(lib);
    else if (!packages.includes(pkg)) packages.push(pkg);
  }
  return { packages, unknown };
}

export function aptHint(missing) {
  const { packages, unknown } = aptPackages(missing);
  const parts = [];
  if (packages.length) parts.push(`install with: sudo apt install ${packages.join(' ')}`);
  if (unknown.length) parts.push(`no package known for: ${unknown.join(', ')}`);
  return parts.join('; ');
}

async function checkLdd(executablePath) {
  try {
    const { stdout } = await promisify(execFile)('ldd', [executablePath], { maxBuffer: 4 << 20 });
    const missing = stdout.split('\n').filter((l) => l.includes('not found')).map((l) => l.trim().split(/\s+/)[0]);
    return missing.length ? ['fail', `missing ${missing.join(', ')}; ${aptHint(missing)}`] : ['ok', ''];
  } catch (err) {
    return ['warn', `could not run ldd: ${err.message}`];
  }
}

async function checkKitty(stdin, stdout, env) {
  const known = kittyTerminalName(env);
  if (known) return ['ok', `known terminal: ${known}`];
  if (!stdin.isTTY || !stdout.isTTY) return ['warn', 'not run in a terminal, so not checked'];
  if (await detectKitty(stdin, stdout, 800, env)) return ['ok', 'the terminal answered the query'];
  return ['warn', 'no answer to the query, so the viewer will refuse to draw here; if this terminal does draw Kitty graphics, set TERMBROWSE_ASSUME_KITTY=1'];
}

// The Claude Code plugin's MCP server runs the bare command `termbrowse`, so it has to resolve
// on PATH: the first PATH entry holding an executable file of that name, as a shell would find it.
export async function checkOnPath(env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, 'termbrowse');
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return ['ok', file];
    } catch {
      // not here; keep looking
    }
  }
  return ['warn', 'the Claude Code plugin runs `termbrowse` from PATH — install with npm i -g or npm link'];
}

export async function runDoctor(
  args,
  { stdin = process.stdin, stdout = process.stdout, env = process.env, platform = process.platform } = {},
) {
  const { positionals } = parse(args, {});
  if (positionals.length) throw new UsageError(`doctor: unexpected argument ${positionals[0]}`);
  const lines = [];
  const add = (name, [status, detail]) => {
    lines.push(status);
    stdout.write(`${name}: ${status}${detail ? ` (${detail})` : ''}\n`);
  };

  const major = Number(process.versions.node.split('.')[0]);
  add('Node', major >= 22 ? ['ok', process.versions.node] : ['fail', `${process.versions.node}; termbrowse needs 22 or newer`]);

  const p = paths(env);
  let cfg;
  try {
    cfg = await loadConfig(env);
    add('Config', ['ok', env.TERMBROWSE_CONFIG || p.config]);
  } catch (err) {
    add('Config', ['fail', err.message]);
  }

  const chrome = await checkChrome(cfg ?? { chrome: { channel: 'stable' } }, p);
  add('Chrome for Testing', chrome.line);

  if (platform === 'linux') {
    add('Display', env.DISPLAY || env.WAYLAND_DISPLAY
      ? ['ok', env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` : `DISPLAY=${env.DISPLAY}`]
      : ['warn', 'DISPLAY and WAYLAND_DISPLAY unset: Chrome runs headless and login cannot open a window']);
    if (chrome.executablePath) add('Chrome libraries (ldd)', await checkLdd(chrome.executablePath));
  }

  add('termbrowse on PATH', await checkOnPath(env));
  add('Kitty graphics', await checkKitty(stdin, stdout, env));
  return lines.includes('fail') ? 1 : 0;
}
