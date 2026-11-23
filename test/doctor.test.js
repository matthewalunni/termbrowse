import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aptPackages, aptHint } from '../src/commands/doctor.js';

test('aptPackages maps missing .so names to Debian packages, once each, and keeps unknown names', () => {
  const got = aptPackages([
    'libnss3.so', 'libnssutil3.so', 'libsmime3.so', 'libnspr4.so', 'libplc4.so',
    'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libcups.so.2', 'libxkbcommon.so.0', 'libasound.so.2',
    'libcairo.so.2', 'libpango-1.0.so.0', 'libXdamage.so.1', 'libatspi.so.0', 'libgbm.so.1',
    'libXcomposite.so.1', 'libXrandr.so.2', 'libXfixes.so.3', 'libweird.so.9',
  ]);
  assert.deepEqual(got.packages, [
    'libnss3', 'libnspr4', 'libatk1.0-0t64', 'libatk-bridge2.0-0t64', 'libcups2t64', 'libxkbcommon0', 'libasound2t64',
    'libcairo2', 'libpango-1.0-0', 'libxdamage1', 'libatspi2.0-0t64', 'libgbm1', 'libxcomposite1', 'libxrandr2', 'libxfixes3',
  ]);
  assert.deepEqual(got.unknown, ['libweird.so.9']);
});

test('aptHint gives the install line and lists unknown libraries as-is', () => {
  assert.equal(aptHint(['libgbm.so.1', 'libnss3.so']), 'install with: sudo apt install libgbm1 libnss3');
  assert.equal(aptHint(['libgbm.so.1', 'libweird.so.9']), 'install with: sudo apt install libgbm1; no package known for: libweird.so.9');
  assert.equal(aptHint(['libweird.so.9']), 'no package known for: libweird.so.9');
});
