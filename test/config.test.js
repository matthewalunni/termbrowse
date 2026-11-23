import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/paths.js';
import { loadConfig, effectiveHeadless } from '../src/config.js';

async function tmpFile(content) {
  const dir = await mkdtemp(join(tmpdir(), 'tb-'));
  const file = join(dir, 'config.toml');
  await writeFile(file, content);
  return file;
}

test('defaults when no file', async () => {
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' });
  assert.equal(cfg.chrome.headless, false);
  assert.deepEqual(cfg.chrome.windowSize, [1280, 800]);
  assert.equal(cfg.agents.pruneDays, 7);
  assert.equal(cfg.hooks.onLaunch, '');
  assert.equal(cfg.chrome.channel, 'stable');
});

test('reads toml', async () => {
  const file = await tmpFile('[chrome]\nwindow_size = "1440x900"\n[hooks]\non_launch = "echo hi"\n');
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: file });
  assert.deepEqual(cfg.chrome.windowSize, [1440, 900]);
  assert.equal(cfg.hooks.onLaunch, 'echo hi');
});

test('invalid toml names file', async () => {
  const file = await tmpFile('[chrome\nbroken');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: file }), (err) => err.message.includes(file));
});

test('xdg paths', () => {
  const p = paths({ XDG_STATE_HOME: '/s', XDG_CACHE_HOME: '/c', XDG_CONFIG_HOME: '/f', HOME: '/h' });
  assert.equal(p.registry, '/s/termbrowse/agents.json');
  assert.equal(p.cache, '/c/termbrowse');
  assert.equal(p.config, '/f/termbrowse/config.toml');
  assert.equal(paths({ HOME: '/h' }).state, '/h/.local/state/termbrowse');
});

test('headless forced without display on linux', () => {
  const cfg = { chrome: { headless: false } };
  assert.equal(effectiveHeadless(cfg, {}, 'linux'), true);
  assert.equal(effectiveHeadless(cfg, { DISPLAY: ':0' }, 'linux'), false);
  assert.equal(effectiveHeadless(cfg, {}, 'darwin'), false);
});

test('view fill defaults: fill_pane on, fill_pane_for_agents off', async () => {
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' });
  assert.equal(cfg.view.fillPane, true);
  assert.equal(cfg.view.fillPaneForAgents, false);
});

test('reads [view] fill_pane and fill_pane_for_agents', async () => {
  const file = await tmpFile('[view]\nfill_pane = false\nfill_pane_for_agents = true\n');
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: file });
  assert.equal(cfg.view.fillPane, false);
  assert.equal(cfg.view.fillPaneForAgents, true);
});

test('non-boolean fill values name the file and the key', async () => {
  for (const line of ['fill_pane = "always"', 'fill_pane_for_agents = 1']) {
    const file = await tmpFile(`[view]\n${line}\n`);
    const key = line.split(' ')[0];
    await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: file }), (err) => err.message.includes(file) && err.message.includes(key));
  }
});
