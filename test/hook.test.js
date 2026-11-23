import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook } from '../src/hook.js';
import { bundleId } from '../src/chrome.js';

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tb-hook-'));
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

// bundleId() is '' off macOS, so the expected line has no trailing space there either.
test('runHook passes TERMBROWSE_* env to the command', async () => {
  await withEnv(async (dir) => {
    const out = join(dir, 'out.txt');
    const saved = process.env.OUT;
    process.env.OUT = out;
    try {
      await runHook(
        'echo "$TERMBROWSE_PID $TERMBROWSE_PORT $TERMBROWSE_AGENT $TERMBROWSE_KIND $TERMBROWSE_HEADLESS $TERMBROWSE_BUNDLE_ID" > "$OUT"',
        { pid: 123, port: 9000, agent: 't2p', kind: 'agent', headless: true },
      );
      assert.equal((await readFile(out, 'utf8')).trim(), `123 9000 t2p agent 1 ${bundleId()}`.trim());
      await runHook('echo "$TERMBROWSE_HEADLESS" > "$OUT"', { pid: 1, port: 2, agent: '', kind: 'standalone', headless: false });
      assert.equal((await readFile(out, 'utf8')).trim(), '0');
    } finally {
      if (saved === undefined) delete process.env.OUT;
      else process.env.OUT = saved;
    }
  });
});

test('bundleId is the Chrome for Testing id on darwin only', () => {
  assert.equal(bundleId('darwin'), 'com.google.chrome.for.testing');
  assert.equal(bundleId('linux'), '');
});

test('runHook resolves and logs when the command fails', async () => {
  await withEnv(async (dir) => {
    await runHook('exit 3', { pid: 1, port: 2, agent: 'a', kind: 'agent' });
    const log = await readFile(join(dir, 'termbrowse', 'logs', 'hook.log'), 'utf8');
    assert.match(log, /exit 3/);
    assert.match(log, /\bcode 3\b/);
    assert.equal(log.trim().split('\n').length, 1);
  });
});

test('runHook with an empty command is a no-op (no log written)', async () => {
  await withEnv(async (dir) => {
    await runHook('', { pid: 1, port: 2, agent: 'a', kind: 'agent' });
    await assert.rejects(readFile(join(dir, 'termbrowse', 'logs', 'hook.log')), { code: 'ENOENT' });
  });
});

test('runHook kills a hook that runs past its timeout and logs one line', async () => {
  await withEnv(async (dir) => {
    const pidfile = join(dir, 'hook.pid');
    const t0 = Date.now();
    // The sleep is a grandchild of sh: the whole group must go.
    await runHook(`sleep 30 & echo $! > "${pidfile}"; wait`, { pid: 1, port: 2, agent: 'a', kind: 'agent' }, { timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
    const sleepPid = Number((await readFile(pidfile, 'utf8')).trim());
    const end = Date.now() + 2000;
    const alive = () => { try { process.kill(sleepPid, 0); return true; } catch { return false; } };
    while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(), false, 'hook grandchild still alive');
    const log = await readFile(join(dir, 'termbrowse', 'logs', 'hook.log'), 'utf8');
    assert.match(log, /timed out after 300 ms/);
    assert.equal(log.trim().split('\n').length, 1);
  });
});
