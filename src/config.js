import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';
import { paths } from './paths.js';

function parseSize(value, file) {
  const m = /^(\d+)x(\d+)$/.exec(String(value));
  if (!m) throw new Error(`${file}: invalid window_size "${value}" (expected "WIDTHxHEIGHT")`);
  return [Number(m[1]), Number(m[2])];
}

function parseBool(value, key, file) {
  if (typeof value !== 'boolean') throw new Error(`${file}: invalid ${key} ${JSON.stringify(value)} (expected true or false)`);
  return value;
}

// [keys] (prefix, give_back, quit) belonged to the Ctrl-] prefix the vim mode replaced.
export const KEYS_RETIRED = 'termbrowse: [keys] is no longer used (vim mode); see README\n';
let keysWarned = false;
const warnOnce = (msg) => {
  if (keysWarned) return;
  keysWarned = true;
  process.stderr.write(msg);
};

const DURATION_UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000 };
const MAX_DURATION_MS = 24 * 86_400_000; // under setTimeout's limit (2^31 - 1 ms, about 24.8 days)

export function parseDuration(str) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(str).trim());
  if (!m) throw new Error(`invalid duration "${str}" (expected e.g. "90s", "5m", "2h")`);
  const ms = Number(m[1]) * DURATION_UNITS[m[2]];
  if (ms <= 0 || ms > MAX_DURATION_MS) throw new Error(`invalid duration "${str}" (must be more than 0 and at most 24 days)`);
  return ms;
}

function inFile(file, key, fn, value) {
  try {
    return fn(value);
  } catch (err) {
    throw new Error(`${file}: ${key}: ${err.message}`);
  }
}

// warn: where the retired-[keys] warning goes (default: stderr, once per process).
export async function loadConfig(env = process.env, { warn = warnOnce } = {}) {
  const file = env.TERMBROWSE_CONFIG || paths(env).config;
  let raw = {};
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file}: ${err.message}`);
  }
  if (text !== undefined) {
    try {
      raw = parse(text);
    } catch (err) {
      throw new Error(`${file}: invalid TOML: ${err.message}`);
    }
  }
  const { chrome = {}, agents = {}, hooks = {}, view = {}, keys = {}, control = {} } = raw;
  if (keys && typeof keys === 'object' && ['prefix', 'give_back', 'quit'].some((k) => k in keys)) warn(KEYS_RETIRED);
  return {
    chrome: {
      channel: chrome.channel ?? 'stable',
      headless: chrome.headless ?? false,
      background: parseBool(chrome.background ?? true, 'background', file),
      windowSize: parseSize(chrome.window_size ?? '1280x800', file),
      extraArgs: chrome.extra_args ?? [],
    },
    agents: { pruneDays: agents.prune_days ?? 7 },
    hooks: { onLaunch: hooks.on_launch ?? '' },
    view: {
      fillPane: parseBool(view.fill_pane ?? true, 'fill_pane', file),
      fillPaneForAgents: parseBool(view.fill_pane_for_agents ?? false, 'fill_pane_for_agents', file),
      interactive: parseBool(view.interactive ?? true, 'interactive', file),
    },
    control: {
      idleReturnMs: inFile(file, 'idle_return', parseDuration, control.idle_return ?? '5m'),
      maxWaitMs: inFile(file, 'max_wait', parseDuration, control.max_wait ?? '10m'),
    },
  };
}

export function effectiveHeadless(cfg, env = process.env, platform = process.platform) {
  if (cfg.chrome.headless) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
