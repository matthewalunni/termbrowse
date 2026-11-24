import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/paths.js';
import { loadConfig, effectiveHeadless, parseKeySpec, parseDuration } from '../src/config.js';

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

test('[chrome] background: default true, false honoured, non-boolean names the file', async () => {
  assert.equal((await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' })).chrome.background, true);
  const off = await tmpFile('[chrome]\nbackground = false\n');
  assert.equal((await loadConfig({ TERMBROWSE_CONFIG: off })).chrome.background, false);
  const bad = await tmpFile('[chrome]\nbackground = "no"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: bad }), (e) => e.message.includes(bad) && /background/.test(e.message));
});

test('[keys] and [control] defaults', async () => {
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' });
  assert.deepEqual(cfg.keys.prefix, { key: ']', ctrl: true, alt: false, label: 'Ctrl-]' });
  assert.equal(cfg.keys.giveBack.key, 'g');
  assert.equal(cfg.keys.quit.key, 'q');
  assert.equal(cfg.control.idleReturnMs, 300000);
  assert.equal(cfg.control.maxWaitMs, 600000);
});

test('reads [keys] and [control] from toml', async () => {
  const file = await tmpFile('[keys]\nprefix = "alt-x"\ngive_back = "f2"\n[control]\nidle_return = "90s"\nmax_wait = "2h"\n');
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: file });
  assert.equal(cfg.keys.prefix.label, 'Alt-x');
  assert.equal(cfg.keys.giveBack.key, 'F2');
  assert.equal(cfg.control.idleReturnMs, 90000);
  assert.equal(cfg.control.maxWaitMs, 7200000);
});

test('parseKeySpec', () => {
  assert.deepEqual(parseKeySpec('alt-x'), { key: 'x', ctrl: false, alt: true, label: 'Alt-x' });
  assert.equal(parseKeySpec('f2').key, 'F2');
  assert.equal(parseKeySpec('F12').key, 'F12');
  assert.equal(parseKeySpec('ESCAPE').key, 'Escape');
  for (const n of ['tab', 'enter', 'space']) assert.equal(parseKeySpec(n).ctrl, false);
  assert.deepEqual(parseKeySpec('ctrl-]'), { key: ']', ctrl: true, alt: false, label: 'Ctrl-]' });
  assert.throws(() => parseKeySpec('f13'));
  assert.throws(() => parseKeySpec('ab'));
});

test('parseDuration', () => {
  assert.equal(parseDuration('90s'), 90000);
  assert.equal(parseDuration('2h'), 7200000);
  assert.equal(parseDuration('5m'), 300000);
  assert.throws(() => parseDuration('5 minutes'));
});

test('parseDuration rejects 0 and anything over 24 days (the setTimeout limit)', () => {
  for (const bad of ['0s', '0ms', '0m', '577h', '2073600001ms']) assert.throws(() => parseDuration(bad), /duration/, bad);
  assert.equal(parseDuration('576h'), 24 * 86_400_000);
  assert.equal(parseDuration('1ms'), 1);
});

test('a zero or too long duration in the config names the file and key', async () => {
  const a = await tmpFile('[control]\nidle_return = "0s"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: a }), (err) => err.message.includes(a) && err.message.includes('idle_return'));
  const b = await tmpFile('[control]\nmax_wait = "1000h"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: b }), (err) => err.message.includes(b) && err.message.includes('max_wait'));
});

test('[view] interactive: default true, false read, a non-bool names the file', async () => {
  assert.equal((await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' })).view.interactive, true);
  const off = await tmpFile('[view]\ninteractive = false\n');
  assert.equal((await loadConfig({ TERMBROWSE_CONFIG: off })).view.interactive, false);
  const bad = await tmpFile('[view]\ninteractive = "no"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: bad }), (err) => err.message.includes(bad) && err.message.includes('interactive'));
});

test('invalid key or duration names the file', async () => {
  const a = await tmpFile('[keys]\nprefix = "ctrl-"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: a }), (err) => err.message.includes(a) && err.message.includes('prefix'));
  const b = await tmpFile('[control]\nidle_return = "5 minutes"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: b }), (err) => err.message.includes(b) && err.message.includes('idle_return'));
});
