import { kittyQuery, parseKittyReply } from './kitty.js';

const DA1 = /\x1b\[\?[0-9;]*c/;

// Write a query and read stdin in raw mode until complete(buffer) is true or the timeout hits;
// resolves with everything read. Replies may arrive split across chunks, so the whole buffer is checked.
function ask(stdin, stdout, query, complete, timeoutMs) {
  return new Promise((resolve) => {
    const wasRaw = !!stdin.isRaw;
    const wasFlowing = stdin.readableFlowing === true;
    let buf = '';
    let timer;
    const done = () => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      if (!wasFlowing) stdin.pause();
      if (typeof stdin.setRawMode === 'function' && !!stdin.isRaw !== wasRaw) stdin.setRawMode(wasRaw);
      resolve(buf);
    };
    const onData = (chunk) => {
      buf += String(chunk);
      if (complete(buf)) done();
    };
    if (typeof stdin.setRawMode === 'function' && !wasRaw) stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
    timer = setTimeout(done, timeoutMs);
    stdout.write(query);
  });
}

function plausibleCell(cellW, cellH) {
  if (!(cellW >= 4 && cellW <= 64 && cellH >= 8 && cellH <= 128)) return false;
  const ratio = cellH / cellW;
  return ratio >= 1.2 && ratio <= 3.5;
}

// Pixel size from CSI 16t (cell size, preferred) or CSI 14t (window size), sent in one round trip
// with DA1 as the end marker. An implausible cell size is ignored; with neither, pixels are 0
// so the caller pauses instead of drawing a distorted image.
export async function termSize(stdin, stdout, timeoutMs = 800) {
  const cols = stdout.columns ?? 0;
  const rows = stdout.rows ?? 0;
  const cellRe = /\x1b\[6;(\d+);(\d+)t/;
  const winRe = /\x1b\[4;(\d+);(\d+)t/;
  const buf = await ask(stdin, stdout, '\x1b[16t\x1b[14t\x1b[c',
    (b) => DA1.test(b) || (cellRe.test(b) && winRe.test(b)), timeoutMs);

  const cell = cellRe.exec(buf);
  if (cell) {
    const cellH = Number(cell[1]);
    const cellW = Number(cell[2]);
    if (plausibleCell(cellW, cellH)) return { cols, rows, pxW: cellW * cols, pxH: cellH * rows };
  }
  const win = winRe.exec(buf);
  if (win && cols > 0 && rows > 0) {
    const pxH = Number(win[1]);
    const pxW = Number(win[2]);
    if (plausibleCell(pxW / cols, pxH / rows)) return { cols, rows, pxW, pxH };
  }
  return { cols, rows, pxW: 0, pxH: 0 };
}

// Terminals known to draw Kitty graphics, some of which (Herdr) don't answer the query.
export function knownKittyTerminal(env = process.env) {
  if (env.TERMBROWSE_ASSUME_KITTY === '1') return true;
  if (env.HC_TERMINAL_ID || env.KITTY_WINDOW_ID) return true;
  const term = (env.TERM ?? '').toLowerCase();
  if (term === 'xterm-kitty' || term === 'xterm-ghostty') return true;
  const program = (env.TERM_PROGRAM ?? '').toLowerCase();
  return program === 'ghostty' || program === 'wezterm';
}

export async function detectKitty(stdin, stdout, timeoutMs = 800, env = process.env) {
  if (knownKittyTerminal(env)) return true;
  // The query ends with DA1, which terminals answer after the graphics reply: wait for it so a
  // late DA1 isn't left buffered for the next query (termSize uses DA1 as its end marker).
  const buf = await ask(stdin, stdout, kittyQuery(), (b) => DA1.test(b), timeoutMs);
  return parseKittyReply(buf) === true;
}
