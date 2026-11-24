// Turns parsed terminal key events into Input.dispatchKeyEvent params (US layout codes and
// Windows virtual key codes), and matches key events against the reserved [keys] specs.

const NAMED = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Escape: ['Escape', 27],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  Insert: ['Insert', 45], Delete: ['Delete', 46],
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = [`F${i}`, 111 + i];

// Unshifted and shifted punctuation on a US keyboard → [code, virtual key].
const PUNCT = {};
const SHIFTED_DIGITS = ')!@#$%^&*(';
for (let d = 0; d <= 9; d++) PUNCT[SHIFTED_DIGITS[d]] = [`Digit${d}`, 48 + d];
for (const [plain, shifted, code, vk] of [
  [' ', ' ', 'Space', 32], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191], ['`', '~', 'Backquote', 192],
]) {
  PUNCT[plain] = [code, vk];
  PUNCT[shifted] = [code, vk];
}

// [code, windowsVirtualKeyCode] for a DOM key name; ['', 0] when the key has no US-layout position.
export function keyInfo(key) {
  if (NAMED[key]) return NAMED[key];
  if (/^[a-zA-Z]$/.test(key)) return [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  if (/^[0-9]$/.test(key)) return [`Digit${key}`, key.charCodeAt(0)];
  if (PUNCT[key]) return PUNCT[key];
  return ['', 0];
}

export function isPrintable(ev) {
  return typeof ev.text === 'string' && ev.text.length > 0 && !ev.ctrl && !ev.alt && !ev.meta;
}

function modifierBits(ev) {
  return (ev.alt ? 1 : 0) | (ev.ctrl ? 2 : 0) | (ev.meta ? 4 : 0) | (ev.shift ? 8 : 0);
}

export function toKeyEvents(ev) {
  const [derivedCode, vk] = keyInfo(ev.key);
  const base = {
    key: ev.key,
    code: ev.code || derivedCode,
    windowsVirtualKeyCode: vk,
    modifiers: modifierBits(ev),
  };
  // Enter carries '\r' so the page gets a keypress (implicit form submission), as Puppeteer does.
  let text;
  if (isPrintable(ev)) text = ev.text;
  else if (ev.key === 'Enter' && !ev.ctrl && !ev.alt && !ev.meta) text = '\r';
  const down = text === undefined
    ? { type: 'rawKeyDown', ...base }
    : { type: 'keyDown', ...base, text, unmodifiedText: text };
  if (ev.repeat) down.autoRepeat = true;
  return [down, { type: 'keyUp', ...base }];
}

// parseKeySpec names space 'Space'; the DOM key for it is ' '.
const SPEC_KEY = { Space: ' ' };

export function matchesSpec(ev, spec) {
  if (!!ev.ctrl !== !!spec.ctrl || !!ev.alt !== !!spec.alt || ev.meta) return false;
  const want = SPEC_KEY[spec.key] ?? spec.key;
  // Terminals report Ctrl+letter without case, so ctrl-A and ctrl-a are the same key. A plain
  // lowercase letter also matches its capital (Caps Lock, Shift); a capital spec only itself.
  if (/^[a-zA-Z]$/.test(want) && (spec.ctrl || want === want.toLowerCase())) return ev.key.toLowerCase() === want.toLowerCase();
  return ev.key === want;
}
