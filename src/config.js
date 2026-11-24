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

const NAMED_KEYS = { escape: 'Escape', tab: 'Tab', enter: 'Enter', space: 'Space' };

export function parseKeySpec(str) {
  const original = String(str);
  let ctrl = false;
  let alt = false;
  let rest = original.trim();
  for (;;) {
    const lower = rest.toLowerCase();
    if (lower.startsWith('ctrl-') && rest.length > 5) { ctrl = true; rest = rest.slice(5); } else if (lower.startsWith('alt-') && rest.length > 4) { alt = true; rest = rest.slice(4); } else break;
  }
  const lower = rest.toLowerCase();
  let key;
  if (NAMED_KEYS[lower]) key = NAMED_KEYS[lower];
  else if (/^f([1-9]|1[0-2])$/.test(lower)) key = lower.toUpperCase();
  else if ([...rest].length === 1) key = rest;
  else throw new Error(`invalid key "${original}" (expected e.g. "ctrl-]", "alt-x", "g", "f2", "escape")`);
  const label = `${ctrl ? 'Ctrl-' : ''}${alt ? 'Alt-' : ''}${key}`;
  return { key, ctrl, alt, label };
}

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

export async function loadConfig(env = process.env) {
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
    keys: {
      prefix: inFile(file, 'prefix', parseKeySpec, keys.prefix ?? 'ctrl-]'),
      giveBack: inFile(file, 'give_back', parseKeySpec, keys.give_back ?? 'g'),
      quit: inFile(file, 'quit', parseKeySpec, keys.quit ?? 'q'),
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
