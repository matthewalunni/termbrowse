import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/paths.js';
import { loadConfig, effectiveHeadless, parseDuration } from '../src/config.js';

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

test('[control] defaults; there is no keys section any more', async () => {
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' });
  assert.equal(cfg.keys, undefined);
  assert.equal(cfg.control.idleReturnMs, 300000);
  assert.equal(cfg.control.maxWaitMs, 600000);
});

test('reads [control] from toml', async () => {
  const file = await tmpFile('[control]\nidle_return = "90s"\nmax_wait = "2h"\n');
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: file });
  assert.equal(cfg.control.idleReturnMs, 90000);
  assert.equal(cfg.control.maxWaitMs, 7200000);
});

test('[keys] is retired: one warning however many old keys, and the config still loads', async () => {
  const file = await tmpFile('[keys]\nprefix = "ctrl-]"\ngive_back = "g"\nquit = "q"\n[control]\nidle_return = "90s"\n');
  const warnings = [];
  const cfg = await loadConfig({ TERMBROWSE_CONFIG: file }, { warn: (m) => warnings.push(m) });
  assert.deepEqual(warnings, ['termbrowse: [keys] is no longer used (vim mode); see README\n']);
  assert.equal(cfg.control.idleReturnMs, 90000);
  // Even a value the old parser rejected is only warned about now.
  const bad = await tmpFile('[keys]\nprefix = "ctrl-"\n');
  const w2 = [];
  await loadConfig({ TERMBROWSE_CONFIG: bad }, { warn: (m) => w2.push(m) });
  assert.equal(w2.length, 1);
  const none = [];
  await loadConfig({ TERMBROWSE_CONFIG: '/nonexistent.toml' }, { warn: (m) => none.push(m) });
  assert.equal(none.length, 0);
});

test('[keys] warning goes to stderr once per process by default', async () => {
  const file = await tmpFile('[keys]\nprefix = "ctrl-]"\n');
  const write = process.stderr.write;
  const seen = [];
  process.stderr.write = (chunk, ...rest) => { seen.push(String(chunk)); return true; };
  try {
    await loadConfig({ TERMBROWSE_CONFIG: file });
    await loadConfig({ TERMBROWSE_CONFIG: file });
  } finally {
    process.stderr.write = write;
  }
  assert.equal(seen.filter((s) => s.includes('[keys] is no longer used')).length, 1);
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

test('invalid duration names the file', async () => {
  const b = await tmpFile('[control]\nidle_return = "5 minutes"\n');
  await assert.rejects(loadConfig({ TERMBROWSE_CONFIG: b }), (err) => err.message.includes(b) && err.message.includes('idle_return'));
});

