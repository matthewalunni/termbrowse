// Parses raw terminal input (stdin bytes) into mouse, wheel, key, paste, focus and terminal-reply events.
// Pure: no I/O. Incomplete sequences are kept between pushes; a lone ESC stays pending until
// flush(), which the caller runs on a short timer to tell the Escape key from a sequence start.
import { StringDecoder } from 'node:string_decoder';
import { keyInfo } from './keymap.js';

const ESC = '\x1b';
const PASTE_END = `${ESC}[201~`;

// Legacy CSI final bytes and SS3 finals.
const FINAL_KEYS = {
  A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End',
  P: 'F1', Q: 'F2', R: 'F3', S: 'F4',
};

// CSI <n> ~ keys.
const TILDE_KEYS = {
  1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End',
  11: 'F1', 12: 'F2', 13: 'F3', 14: 'F4', 15: 'F5', 17: 'F6', 18: 'F7', 19: 'F8', 20: 'F9', 21: 'F10',
  23: 'F11', 24: 'F12',
};

// Kitty keyboard protocol code points that aren't the key's own character.
const KITTY_KEYS = {
  9: 'Tab', 13: 'Enter', 27: 'Escape', 8: 'Backspace', 127: 'Backspace',
  57414: 'Enter', 57417: 'ArrowLeft', 57418: 'ArrowRight', 57419: 'ArrowUp', 57420: 'ArrowDown',
  57421: 'PageUp', 57422: 'PageDown', 57423: 'Home', 57424: 'End', 57425: 'Insert', 57426: 'Delete',
};
for (let d = 0; d <= 9; d++) KITTY_KEYS[57399 + d] = String(d);
Object.assign(KITTY_KEYS, { 57409: '.', 57410: '/', 57411: '*', 57412: '-', 57413: '+', 57415: '=' });

function keyEvent(key, { shift = false, alt = false, ctrl = false, meta = false, repeat = false, text } = {}) {
  const ev = { type: 'key', key, code: keyInfo(key)[0], text: undefined, shift, alt, ctrl, meta, repeat };
  if (text !== undefined && !ctrl && !alt && !meta) ev.text = text;
  return ev;
}

// Modifier field "mods[:event]": mods is 1 + bits (shift 1, alt 2, ctrl 4, super 8, hyper 16,
// meta 32, caps lock 64, num lock 128); event is Kitty's 1 press, 2 repeat, 3 release.
function decodeMods(field = '') {
  const [param, eventType] = String(field).split(':');
  const bits = Math.max(0, (Number(param) || 1) - 1);
  return {
    shift: !!(bits & 1), alt: !!(bits & 2), ctrl: !!(bits & 4), meta: !!(bits & 40),
    repeat: eventType === '2', release: eventType === '3',
  };
}

// One character typed without an escape sequence (C0 controls, DEL, printable).
function charKey(ch, alt = false) {
  const c = ch.codePointAt(0);
  if (ch === '\r' || ch === '\n') return keyEvent('Enter', { alt });
  if (ch === '\t') return keyEvent('Tab', { alt });
  if (c === 0x7f || c === 0x08) return keyEvent('Backspace', { alt });
  if (c === 0x1b) return keyEvent('Escape', { alt });
  if (c === 0) return keyEvent(' ', { ctrl: true, alt });
  if (c < 0x1b) return keyEvent(String.fromCharCode(c + 0x60), { ctrl: true, alt });
  if (c < 0x20) return keyEvent('\\]^_'[c - 0x1c], { ctrl: true, alt });
  const shift = ch !== ch.toLowerCase();
  return keyEvent(ch, { shift, alt, text: ch });
}

function sgrMouse(params, final) {
  const [b, col, row] = params.slice(1).split(';').map(Number);
  if (b & 128) return null; // extra buttons (back/forward): not forwarded
  const mods = { shift: !!(b & 4), alt: !!(b & 8), ctrl: !!(b & 16) };
  const low = b & 3;
  if (b & 64) {
    if (final === 'm') return null;
    const dy = low === 0 ? -1 : low === 1 ? 1 : 0;
    const dx = low === 2 ? -1 : low === 3 ? 1 : 0;
    return { type: 'wheel', dx, dy, col, row, ...mods };
  }
  const button = ['left', 'middle', 'right', 'none'][low];
  const action = b & 32 ? 'move' : final === 'm' ? 'release' : 'press';
  return { type: 'mouse', action, button, col, row, ...mods };
}

// Kitty CSI-u: ESC [ code[:shifted[:base]] ; mods[:event] ; text u
function kittyKey(params) {
  const [codes = '', modField = '', textField = ''] = params.split(';');
  const [code, shiftedCode] = codes.split(':').map((s) => (s === '' ? undefined : Number(s)));
  const mods = decodeMods(modField);
  if (mods.release) return null;
  let key = KITTY_KEYS[code];
  let text;
  if (key === undefined) {
    if (!(code >= 32) || (code >= 57344 && code <= 63743)) return null; // other functional / private-use keys
    // Associated text (flag 16) already reflects shift and caps lock; then the shifted alternate
    // key (flag 4); then the base key, uppercased for shift.
    const assoc = textField ? String.fromCodePoint(...textField.split(':').map(Number)) : '';
    if (assoc && [...assoc].length === 1 && assoc.codePointAt(0) >= 32) key = assoc;
    else if (mods.shift && shiftedCode) key = String.fromCodePoint(shiftedCode);
    else {
      key = String.fromCodePoint(code);
      if (mods.shift) key = key.toUpperCase();
    }
    text = assoc || key;
  } else if ([...key].length === 1) {
    text = key; // keypad digits and operators; named keys (Enter, ArrowLeft…) have no text
  }
  return keyEvent(key, { ...mods, text });
}

function csiEvent(params, final, raw) {
  if (params[0] === '<' && (final === 'M' || final === 'm')) return sgrMouse(params, final);
  if (final === 't' || (final === 'c' && params[0] === '?') || (final === 'u' && params[0] === '?')) {
    return { type: 'reply', raw };
  }
  if (final === 'u') return kittyKey(params);
  const fields = params.split(';');
  if (final === '~') {
    const key = TILDE_KEYS[fields[0]];
    const mods = decodeMods(fields[1]);
    return key && !mods.release ? keyEvent(key, mods) : null;
  }
  if (FINAL_KEYS[final]) {
    const mods = decodeMods(fields[1]);
    return mods.release ? null : keyEvent(FINAL_KEYS[final], mods);
  }
  if (final === 'Z') return keyEvent('Tab', { shift: true });
  if (params === '' && (final === 'I' || final === 'O')) return { type: 'focus', in: final === 'I' }; // focus reporting (?1004)
  return null; // anything else we don't use
}

export class InputParser {
  constructor() {
    this.decoder = new StringDecoder('utf8');
    this.buf = '';
  }

  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.drain();
  }

  // Resolve what a timer says is no longer a sequence in progress: a lone ESC is the Escape key,
  // ESC followed by '[' or 'O' alone is Alt+that key. Anything longer stays pending.
  flush() {
    const events = [];
    if (this.buf === ESC) {
      events.push(keyEvent('Escape'));
      this.buf = '';
    } else if (this.buf === `${ESC}[` || this.buf === `${ESC}O`) {
      events.push(charKey(this.buf[1], true));
      this.buf = '';
    }
    return events;
  }

  drain() {
    const events = [];
    for (;;) {
      if (this.buf === '') break;
      const consumed = this.next(events);
      if (consumed === 0) break; // incomplete; wait for more input
      this.buf = this.buf.slice(consumed);
    }
    return events;
  }

  // Parse one unit at the start of buf; push its event (if any) and return chars consumed, 0 if incomplete.
  next(events) {
    const buf = this.buf;
    if (buf[0] !== ESC) {
      const ch = String.fromCodePoint(buf.codePointAt(0));
      events.push(charKey(ch));
      return ch.length;
    }
    if (buf.length < 2) return 0;
    const intro = buf[1];
    if (intro === '[') {
      if (buf.startsWith(`${ESC}[200~`)) {
        const end = buf.indexOf(PASTE_END, 6);
        if (end < 0) return 0;
        events.push({ type: 'paste', text: buf.slice(6, end) });
        return end + PASTE_END.length;
      }
      if (`${ESC}[200~`.startsWith(buf)) return 0;
      let i = 2;
      while (i < buf.length && buf.charCodeAt(i) >= 0x20 && buf.charCodeAt(i) <= 0x3f) i++;
      if (i >= buf.length) return 0;
      const fc = buf.charCodeAt(i);
      if (fc < 0x40 || fc > 0x7e) { // malformed; drop the introducer
        events.push(charKey('[', true));
        return 2;
      }
      const ev = csiEvent(buf.slice(2, i), buf[i], buf.slice(0, i + 1));
      if (ev) events.push(ev);
      return i + 1;
    }
    if (intro === 'O') {
      if (buf.length < 3) return 0;
      const key = FINAL_KEYS[buf[2]];
      if (key) events.push(keyEvent(key));
      return 3;
    }
    if (intro === '_' || intro === ']') { // APC (Kitty graphics reply) / OSC, ended by ST or BEL
      const st = buf.indexOf(`${ESC}\\`, 2);
      const bel = intro === ']' ? buf.indexOf('\x07', 2) : -1;
      let end = -1;
      if (st >= 0 && (bel < 0 || st < bel)) end = st + 2;
      else if (bel >= 0) end = bel + 1;
      if (end < 0) return 0;
      events.push({ type: 'reply', raw: buf.slice(0, end) });
      return end;
    }
    if (intro === ESC) { // ESC ESC: the first is a plain Escape
      events.push(keyEvent('Escape'));
      return 1;
    }
    const ch = String.fromCodePoint(buf.codePointAt(1));
    events.push(charKey(ch, true));
    return 1 + ch.length;
  }
}
