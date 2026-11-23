import { kittyQuery, parseKittyReply } from './kitty.js';

// Write a query and read stdin in raw mode until parse(buffer) returns non-null or the timeout hits.
// Replies may arrive split across chunks, so parse always sees everything read so far.
function ask(stdin, stdout, query, parse, timeoutMs) {
  return new Promise((resolve) => {
    const wasRaw = !!stdin.isRaw;
    const wasFlowing = stdin.readableFlowing === true;
    let buf = '';
    let timer;
    const done = (value) => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      if (!wasFlowing) stdin.pause();
      if (typeof stdin.setRawMode === 'function' && !!stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
      resolve(value);
    };
    const onData = (chunk) => {
      buf += String(chunk);
      const v = parse(buf);
      if (v !== null) done(v);
    };
    if (typeof stdin.setRawMode === 'function' && !wasRaw) stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
    timer = setTimeout(() => done(null), timeoutMs);
    stdout.write(query);
  });
}

export async function termSize(stdin, stdout, timeoutMs = 800) {
  const cols = stdout.columns ?? 0;
  const rows = stdout.rows ?? 0;
  const px = await ask(stdin, stdout, '\x1b[14t', (buf) => {
    const m = /\x1b\[4;(\d+);(\d+)t/.exec(buf);
    return m ? { pxH: Number(m[1]), pxW: Number(m[2]) } : null;
  }, timeoutMs);
  return { cols, rows, pxW: px?.pxW ?? 0, pxH: px?.pxH ?? 0 };
}

export async function detectKitty(stdin, stdout, timeoutMs = 800, env = process.env) {
  if (env.TERMBROWSE_ASSUME_KITTY === '1') return true;
  return (await ask(stdin, stdout, kittyQuery(), parseKittyReply, timeoutMs)) === true;
}
