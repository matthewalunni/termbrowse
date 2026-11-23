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
  const { chrome = {}, agents = {}, hooks = {}, view = {} } = raw;
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
    },
  };
}

export function effectiveHeadless(cfg, env = process.env, platform = process.platform) {
  if (cfg.chrome.headless) return true;
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
