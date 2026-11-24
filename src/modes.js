// Vim/Vimium-style mode state machine for the interactive viewer. Pure: no I/O.
// Takes InputParser events (src/input.js) and returns actions for the viewer to run.
//
// Modes: 'normal' and 'insert', plus transient sub-states 'command' (after ':'), 'find'
// (after '/'), 'hints' (after f/F) and 'help' (after ? or :help).
//
// Actions that change the agent's page carry takesControl: true on agent browsers (never on
// standalone ones). A {type:'line'} action carries the status-line text while the user types
// on the ':' or '/' line ('' means the line closed; show the normal status again).
//
// Mouse, wheel, focus and reply events produce no actions: the viewer keeps handling them.
// A mouse press cancels a partial key sequence.

export const SEQUENCE_TIMEOUT_MS = 1000;
export const SCROLL_STEP = 60;

const MODES = new Set(['normal', 'insert', 'command', 'find', 'hints', 'help']);

// Keys that pass through to the page in Normal (Vimium-style), besides Ctrl/Alt/Cmd combinations.
const PASS_THROUGH = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter', 'Tab',
]);

// Single Normal keys: [action, takesControl].
const NORMAL_KEYS = {
  j: [{ type: 'scroll', dx: 0, dy: SCROLL_STEP }, true],
  k: [{ type: 'scroll', dx: 0, dy: -SCROLL_STEP }, true],
  h: [{ type: 'scroll', dx: -SCROLL_STEP, dy: 0 }, true],
  l: [{ type: 'scroll', dx: SCROLL_STEP, dy: 0 }, true],
  d: [{ type: 'halfPage', dir: 1 }, true],
  u: [{ type: 'halfPage', dir: -1 }, true],
  G: [{ type: 'scrollTo', where: 'bottom' }, true],
  H: [{ type: 'history', dir: -1 }, true],
  L: [{ type: 'history', dir: 1 }, true],
  r: [{ type: 'reload' }, true],
  J: [{ type: 'tab', op: 'prev' }, true],
  K: [{ type: 'tab', op: 'next' }, true],
  t: [{ type: 'tab', op: 'new' }, true],
  x: [{ type: 'tab', op: 'close' }, true],
  n: [{ type: 'findNext', dir: 1 }, true],
  N: [{ type: 'findNext', dir: -1 }, true],
};

// Two-key sequences, keyed by first key then second key.
const SEQUENCES = {
  g: {
    g: [{ type: 'scrollTo', where: 'top' }, true],
    i: [{ type: 'focusFirstInput' }, true],
    t: [{ type: 'tab', op: 'next' }, true],
    T: [{ type: 'tab', op: 'prev' }, true],
  },
  y: {
    y: [{ type: 'copyUrl' }, false],
  },
};

const isCtrlC = (ev) => ev.ctrl && !ev.alt && !ev.meta && ev.key.toLowerCase() === 'c';
const hasMods = (ev) => ev.ctrl || ev.alt || ev.meta;
const printable = (ev) => typeof ev.text === 'string' && ev.text.length > 0 && !hasMods(ev);

export function createModes({ agent = false, holding = () => false } = {}) {
  let mode = 'normal';
  let pending = '';
  let pendingAt = 0;
  let line = '';
  let lastFind = '';

  const act = (action, takes) => (takes && agent ? { ...action, takesControl: true } : { ...action });
  const clearPending = () => { pending = ''; };
  const expire = (now) => {
    if (pending && now - pendingAt >= SEQUENCE_TIMEOUT_MS) clearPending();
  };
  const lineText = () => (mode === 'command' ? `:${line}█` : `/${line}█`);
  const closeLine = () => {
    mode = 'normal';
    line = '';
    return act({ type: 'line', text: '' });
  };

  function runCommand(text) {
    const trimmed = text.trim();
    const [name = '', ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case '': return [];
      case 'q': case 'quit': return [act({ type: 'quit' })];
      case 'done': return [act({ type: 'handBack' })];
      case 'o': case 'open':
        return arg ? [act({ type: 'open', url: arg }, true)] : [act({ type: 'error', text: `usage: :${name} <url>` })];
      case 'esc': return [act({ type: 'sendEscape' }, true)];
      case 'help':
        mode = 'help';
        return [act({ type: 'help' })];
      default: return [act({ type: 'error', text: `not a command: ${trimmed}` })];
    }
  }

  // Typing on the ':' or '/' line.
  function lineKey(ev) {
    if (isCtrlC(ev)) {
      const out = [closeLine()];
      return out.concat(act({ type: 'quit' }));
    }
    if (ev.key === 'Escape') {
      const wasFind = mode === 'find';
      const out = [closeLine()];
      if (wasFind) out.push(act({ type: 'findCancel' }));
      return out;
    }
    if (ev.key === 'Enter') {
      const wasFind = mode === 'find';
      const text = line;
      const out = [closeLine()];
      if (!wasFind) return out.concat(runCommand(text));
      const query = text || lastFind;
      if (!query) return out;
      lastFind = query;
      return out.concat(act({ type: 'find', text: query }, true));
    }
    if (ev.key === 'Backspace') {
      if (line === '') return [closeLine()];
      line = [...line].slice(0, -1).join('');
      return [act({ type: 'line', text: lineText() })];
    }
    if (printable(ev)) {
      line += ev.text;
      return [act({ type: 'line', text: lineText() })];
    }
    return [];
  }

  function hintsKey(ev) {
    if (isCtrlC(ev)) {
      mode = 'normal';
      return [act({ type: 'hintsCancel' }), act({ type: 'quit' })];
    }
    if (ev.key === 'Escape') {
      mode = 'normal';
      return [act({ type: 'hintsCancel' })];
    }
    if (ev.key === 'Enter' || ev.key === 'Backspace') return [act({ type: 'hintKey', key: ev.key })];
    if (printable(ev)) return [act({ type: 'hintKey', key: ev.text })];
    return [];
  }

  function normalKey(ev, now) {
    if (pending) {
      const first = pending;
      clearPending();
      if (ev.key === 'Escape') return []; // Esc cancels a partial command
      const hit = !hasMods(ev) && SEQUENCES[first][ev.key];
      if (hit) return [act(...hit)];
      // Not a sequence: handle the key on its own (never swallow it).
    }
    if (isCtrlC(ev)) return [act({ type: 'quit' })];
    if (ev.key === 'Escape') return holding() ? [act({ type: 'handBack' })] : [];
    if (hasMods(ev) || PASS_THROUGH.has(ev.key)) return [act({ type: 'pageKey', ev }, true)];
    if (!printable(ev)) return [];
    const k = ev.key;
    if (SEQUENCES[k]) {
      pending = k;
      pendingAt = now;
      return [];
    }
    if (NORMAL_KEYS[k]) return [act(...NORMAL_KEYS[k])];
    switch (k) {
      case 'f': case 'F':
        mode = 'hints';
        return [act({ type: 'hints', newTab: k === 'F' }, true)];
      case 'i':
        mode = 'insert';
        return [act({ type: 'enterInsert' }, true)];
      case ':':
        mode = 'command';
        line = '';
        return [act({ type: 'line', text: lineText() })];
      case '/':
        mode = 'find';
        line = '';
        return [act({ type: 'line', text: lineText() }, true)];
      case '?':
        mode = 'help';
        return [act({ type: 'help' })];
      default:
        return []; // unmapped printable keys never reach the page in Normal
    }
  }

  function handle(ev, now) {
    expire(now);
    if (ev.type === 'paste') {
      if (mode === 'normal' || mode === 'insert') {
        clearPending();
        return [act({ type: 'pagePaste', text: ev.text }, true)];
      }
      if (mode === 'command' || mode === 'find') {
        line += ev.text.replace(/[\r\n]+/g, ' ');
        return [act({ type: 'line', text: lineText() })];
      }
      return [];
    }
    if (ev.type === 'mouse') {
      if (ev.action === 'press') clearPending();
      return [];
    }
    if (ev.type !== 'key') return [];
    switch (mode) {
      case 'insert':
        if (ev.key === 'Escape' && !hasMods(ev)) {
          mode = 'normal';
          return [act({ type: 'exitInsert' })];
        }
        return [act({ type: 'pageKey', ev }, true)];
      case 'command': case 'find': return lineKey(ev);
      case 'hints': return hintsKey(ev);
      case 'help':
        mode = 'normal';
        return isCtrlC(ev) ? [act({ type: 'helpClose' }), act({ type: 'quit' })] : [act({ type: 'helpClose' })];
      default: return normalKey(ev, now);
    }
  }

  return {
    state: () => ({ mode, pending, line }),
    handle,
    tick(now) {
      expire(now);
      return [];
    },
    setMode(next) {
      if (!MODES.has(next)) throw new Error(`unknown mode: ${next}`);
      mode = next;
      clearPending();
      line = '';
    },
  };
}
