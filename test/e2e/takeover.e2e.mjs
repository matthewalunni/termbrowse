#!/usr/bin/env node
// End-to-end proof of "take over an agent's browser", with real processes throughout:
// a local login page, `termbrowse mcp` as a pretend agent (real chrome-devtools-mcp, real headless
// Chrome for Testing), and the real viewer `termbrowse view --agent` inside a pseudo-terminal
// (a python3 pty relay), with this script playing the terminal (answering the viewer's size and
// keyboard queries) and the user (SGR mouse clicks and Kitty keyboard sequences into the pty).
//
// Not part of `npm test` (its glob is test/**/*.test.js). Run: npm run e2e
// Env: E2E_SCREENSHOT_OUT=<path> copies the agent's take_screenshot PNG there.
//
// Never touches the user's own termbrowse state: config, state and registry live in a temp dir,
// and Chrome is headless.
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { paths } from '../../src/paths.js';
import { readControl } from '../../src/control.js';
import { cellToPage, fit, screencastSize } from '../../src/layout.js';
import { listTargets, CdpSession } from '../../src/cdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'bin/termbrowse.js');
const NODE = process.execPath;
const AGENT = 'e2e-agent';
const COLS = 100;
const ROWS = 40;
const CELL_W = 10;
const CELL_H = 20;
const USER = 'alice';
const TEST_INPUT = 'Hello e2e!@#'; // typed into the page's second field (@ and # are shifted keys)
const NOTE_PREFIX = 'Note from termbrowse: the user took control of this browser for';
const ESC = '\x1b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const info = (msg) => console.log(`       ${msg}`);

let stepNo = 0;
let failed = false;
async function step(name, timeoutMs, fn) {
  stepNo++;
  const n = String(stepNo).padStart(2);
  const start = Date.now();
  let timer;
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new CheckFailed(`timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    console.log(`PASS ${n} ${name} (${Date.now() - start} ms, t=${elapsed()})`);
    return result;
  } catch (err) {
    failed = true;
    console.log(`FAIL ${n} ${name} (${Date.now() - start} ms, t=${elapsed()}): ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A failed check (as opposed to an unexpected error, which also prints its stack).
class CheckFailed extends Error {}
function assert(cond, msg) {
  if (!cond) throw new CheckFailed(msg);
}

async function until(fn, { timeoutMs = 10000, everyMs = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new CheckFailed(`waited ${timeoutMs} ms for ${what}`);
    await sleep(everyMs);
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// --- the test site ---------------------------------------------------------------------------

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LOGIN_PAGE = `<!doctype html><html><head><title>E2E login</title><style>
  body { font: 20px sans-serif; margin: 40px; }
  input { display: block; width: 480px; height: 64px; font-size: 24px; margin: 12px 0 28px; }
  button { width: 200px; height: 56px; font-size: 22px; }
</style></head><body>
<h1 id="title">termbrowse e2e login</h1>
<form method="post" action="/login">
  <label>Username <input id="username" name="username" value="${USER}"></label>
  <label>Password <input id="password" name="password" type="password"></label>
  <button id="submit" type="submit">Log in</button>
</form></body></html>`;

function startSite() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><title>Logged in</title><body style="font: 28px sans-serif; margin: 40px">`
          + `<p id="result">Logged in as ${escapeHtml(form.get('username') ?? '')} with ${escapeHtml(form.get('password') ?? '')}</p>`
          + '<p><a id="again" href="/">Back to the form</a></p></body>');
      });
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(LOGIN_PAGE);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// --- the pretend agent: newline-delimited JSON-RPC to `termbrowse mcp` ------------------------

function startAgent(env) {
  const child = spawn(NODE, [BIN, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  const pending = new Map();
  let stderr = '';
  let buf = '';
  let nextId = 1;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return {
    child,
    exited,
    stderr: () => stderr,
    request(method, params) {
      const id = nextId++;
      const p = new Promise((r) => pending.set(id, r));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return p;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params && { params }) })}\n`);
    },
    callTool(name, args = {}) {
      return this.request('tools/call', { name, arguments: args });
    },
  };
}

const texts = (resp) => (resp?.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);

function termbrowseJson(args, env) {
  return promisify(execFile)(NODE, [BIN, ...args], { env, cwd: ROOT }).then(({ stdout }) => JSON.parse(stdout));
}

// --- the terminal: the viewer in a pty, answered like Kitty would ------------------------------

const TERM_REPLIES = {
  '16t': `${ESC}[6;${CELL_H};${CELL_W}t`, // cell size in pixels
  '14t': `${ESC}[4;${ROWS * CELL_H};${COLS * CELL_W}t`, // text area in pixels
  c: `${ESC}[?62;c`, // DA1
  '?u': `${ESC}[?29u`, // Kitty keyboard flags in effect (the viewer pushes 29)
};
const QUERY = /\x1b\[(16t|14t|c|\?u)/g;
const PLACE = /\x1b_Ga=T,f=100,i=\d+,p=1,c=(\d+),r=(\d+)/g;

// A pty relay: runs the command on a new pseudo-terminal (its controlling tty, size set before
// exec), copies our stdin to it and its output to our stdout, and exits with its status.
// (macOS `script` won't do: it needs its own stdin to be a terminal.) python3 ships with the
// macOS command line tools and Linux; no native Node module needed.
const PTY_RELAY = `
import os, sys, pty, select, fcntl, termios, struct
cols, rows, cmd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execvp(cmd[0], cmd)
def write_all(f, data):
    while data:
        data = data[os.write(f, data):]
stdin_open = True
while True:
    r, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [])
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        write_all(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if data:
            write_all(fd, data)
        else:
            stdin_open = False
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

function startViewer(env) {
  const child = spawn('python3', ['-I', '-c', PTY_RELAY, String(COLS), String(ROWS), NODE, BIN, 'view', '--agent', AGENT],
    { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  const decoder = new StringDecoder('utf8');
  const v = {
    child,
    tail: '', // the last 64 KiB of output
    qFrom: 0, // offsets in tail where the query / placement scans resume
    pFrom: 0,
    bytes: 0,
    frames: 0,
    place: null, // {cols, rows} of the last image drawn
    queries: [],
    stderr: '',
    exited: new Promise((r) => child.once('exit', (code, signal) => r({ code, signal }))),
    write: (s) => child.stdin.write(s),
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { v.stderr += d; });
  child.stdout.on('data', (chunk) => {
    v.bytes += chunk.length;
    const full = v.tail + decoder.write(chunk);
    // Each pattern resumes after its last match, or 48 chars back (a sequence split across
    // chunks), so nothing is counted twice and nothing split is missed.
    let replies = '';
    QUERY.lastIndex = v.qFrom;
    let qEnd = 0;
    for (let m; (m = QUERY.exec(full));) {
      v.queries.push(m[1]);
      replies += TERM_REPLIES[m[1]];
      qEnd = QUERY.lastIndex;
    }
    PLACE.lastIndex = v.pFrom;
    let pEnd = 0;
    for (let m; (m = PLACE.exec(full));) {
      v.frames++;
      v.place = { cols: Number(m[1]), rows: Number(m[2]) };
      pEnd = PLACE.lastIndex;
    }
    if (replies) child.stdin.write(replies);
    const cut = Math.max(0, full.length - 65536);
    v.tail = full.slice(cut);
    v.qFrom = Math.max(qEnd, full.length - 48, v.qFrom) - cut;
    v.pFrom = Math.max(pEnd, full.length - 48, v.pFrom) - cut;
  });
  return v;
}

// Kitty keyboard protocol (flags 29: disambiguate, alternate keys, all keys as escapes, text).
const SHIFTED = { ':': ';', '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };
function kittyChar(ch) {
  const cp = ch.codePointAt(0);
  if (SHIFTED[ch]) return `${ESC}[${SHIFTED[ch].codePointAt(0)}:${cp};2;${cp}u`;
  if (/[A-Z]/.test(ch)) return `${ESC}[${ch.toLowerCase().codePointAt(0)}:${cp};2;${cp}u`;
  return `${ESC}[${cp};;${cp}u`;
}
const KITTY = { enter: `${ESC}[13u`, esc: `${ESC}[27u` };
const typeKeys = async (v, text) => {
  for (const ch of text) {
    v.write(kittyChar(ch));
    await sleep(25);
  }
};
const HINTS_OVERLAY = '__termbrowse_hints'; // src/pageops.js OVERLAY_ID

// --- the run ----------------------------------------------------------------------------------

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'termbrowse-e2e-'));
  const configFile = path.join(tmp, 'config.toml');
  await fs.writeFile(configFile, '[chrome]\nheadless = true\n');
  const env = { ...process.env };
  for (const k of ['HC_TERMINAL_ID', 'KITTY_WINDOW_ID', 'TERM_PROGRAM', 'SSH_CONNECTION', 'TMUX']) delete env[k];
  Object.assign(env, {
    TERMBROWSE_CONFIG: configFile,
    XDG_STATE_HOME: path.join(tmp, 'state'),
    XDG_CONFIG_HOME: path.join(tmp, 'config'),
    TERMBROWSE_AGENT: AGENT,
    TERMBROWSE_ASSUME_KITTY: '1',
    TERM: 'xterm-256color',
  });
  const p = paths(env);
  console.log(`termbrowse e2e takeover · node ${process.version} · temp ${tmp}`);

  let site;
  let agent;
  let viewer;
  let cdp;
  let chromePid;
  try {
    // 1
    const base = await step('local login site serves the form', 5000, async () => {
      site = await startSite();
      const url = `http://127.0.0.1:${site.address().port}`;
      const html = await (await fetch(`${url}/`)).text();
      assert(html.includes('id="password"') && html.includes(`value="${USER}"`), 'login page is missing its fields');
      info(`site at ${url}/`);
      return url;
    });
    const loginUrl = `${base}/`;
    const resultUrl = `${base}/login`;

    // 2
    const port = await step('agent (termbrowse mcp) initializes and opens the login page with new_page', 60000, async () => {
      agent = startAgent(env);
      const init = await agent.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'termbrowse-e2e', version: '0' },
      });
      assert(init.result?.serverInfo, `initialize failed: ${JSON.stringify(init.error ?? init)}`);
      agent.notify('notifications/initialized');
      const r = await agent.callTool('new_page', { url: loginUrl });
      assert(!r.error && !r.result?.isError, `new_page failed: ${JSON.stringify(r.error ?? texts(r))}`);
      const rows = await termbrowseJson(['agents', '--json'], env);
      const e = rows.find((row) => row.agentId === AGENT);
      assert(e && e.kind === 'agent', `no registry entry for ${AGENT}: ${JSON.stringify(rows)}`);
      chromePid = e.pid;
      assert(rows.length === 1, `expected only our agent in the temp registry, got ${rows.length}`);
      info(`agent Chrome pid ${e.pid} on port ${e.port}, page ${e.url}`);
      return e.port;
    });

    // 3
    await step('viewer runs in a pty, gets its size/keyboard answers and draws frames', 30000, async () => {
      viewer = startViewer(env);
      await until(() => viewer.place && viewer.tail.includes(`NORMAL · agent driving · ${loginUrl}`), {
        timeoutMs: 25000, what: 'a frame and a `NORMAL · agent driving · <login url>` status row',
      });
      for (const q of ['16t', '14t', 'c', '?u']) assert(viewer.queries.includes(q), `viewer never sent the ${q} query`);
      info(`queries answered: ${viewer.queries.join(' ')}; frames ${viewer.frames}; image ${viewer.place.cols}x${viewer.place.rows} cells`);
    });

    // 4
    await step(`user clicks the second field (Insert), types ${TEST_INPUT} + Enter through the pty`, 20000, async () => {
      const target = (await listTargets(port)).find((t) => t.type === 'page' && t.url === loginUrl);
      assert(target, 'login page target not found on the agent port');
      cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
      const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const box = await evaluate(`(() => { const r = document.querySelector('#password').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()`);
      // The viewer maps a cell to the page with cellToPage(place, viewport): invert it for the
      // field's centre. Agent browsers aren't filled, so the image is letterboxed to place.
      const place = viewer.place;
      const viewport = { width: box.vw, height: box.vh };
      const term = { cols: COLS, rows: ROWS, pxW: COLS * CELL_W, pxH: ROWS * CELL_H };
      const ss = screencastSize(term);
      const scale = Math.min(ss.maxWidth / box.vw, ss.maxHeight / box.vh, 1);
      const expected = fit({ width: Math.round(box.vw * scale), height: Math.round(box.vh * scale) }, term);
      info(`viewport ${box.vw}x${box.vh}; image drawn ${place.cols}x${place.rows} cells (fit() predicts ${expected.cols}x${expected.rows})`);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const col = Math.floor((cx / box.vw) * place.cols) + 1;
      const row = Math.floor((cy / box.vh) * place.rows) + 1;
      const at = cellToPage(col, row, place, term, viewport);
      assert(at && at.x > box.x && at.x < box.x + box.w && at.y > box.y && at.y < box.y + box.h,
        `cell ${col},${row} maps to ${JSON.stringify(at)}, outside the field ${JSON.stringify(box)}`);
      info(`field ${Math.round(box.w)}x${Math.round(box.h)} at ${Math.round(box.x)},${Math.round(box.y)} -> cell col ${col} row ${row} -> page ${at.x.toFixed(1)},${at.y.toFixed(1)}`);

      viewer.write(`${ESC}[<0;${col};${row}M`);
      await sleep(60);
      viewer.write(`${ESC}[<0;${col};${row}m`);
      await until(() => evaluate(`document.activeElement?.id === 'password'`), { timeoutMs: 5000, what: 'the field to have focus' });
      // Clicking a text field enters Insert; the status says so once control is confirmed.
      await until(() => viewer.tail.includes('INSERT · you have control · Esc normal'), {
        timeoutMs: 5000, what: 'the `INSERT · you have control` status row',
      });
      await typeKeys(viewer, TEST_INPUT);
      await until(async () => (await evaluate(`document.querySelector('#password')?.value`)) === TEST_INPUT, {
        timeoutMs: 5000, what: `the field to hold ${TEST_INPUT}`,
      });
      viewer.write(KITTY.enter);
      await until(async () => (await evaluate('location.href').catch(() => null)) === resultUrl, {
        timeoutMs: 8000, what: 'the form to submit',
      });
      info(`keys sent: ${[...TEST_INPUT].map((c) => JSON.stringify(kittyChar(c).slice(1))).join(' ')} then "[13u"`);
    });

    // 5
    let held;
    await step('agent tools/call while the user holds control gets no answer for 2 s; control file says held', 10000, async () => {
      // A plain assert (no wait) is safe: step 4 waited for this status row, nothing since changes
      // the mode (Enter in Insert goes to the page; a navigation keeps the mode), and every frame
      // drawn ends with the status row, so the 64 KiB tail always holds the current one.
      assert(viewer.tail.includes('INSERT · you have control'), 'the status row no longer says `INSERT · you have control`');
      const c = await readControl(AGENT, p);
      assert(c.held === true, `control file not held: ${JSON.stringify(c)}`);
      let answered = false;
      held = agent.callTool('list_pages').then((r) => { answered = true; return r; });
      await sleep(2000);
      assert(!answered, 'list_pages answered while the user held control');
      const c2 = await readControl(AGENT, p);
      assert(c2.held === true, `control file not held after the wait: ${JSON.stringify(c2)}`);
      info(`control: held=${c2.held} takeovers=${c2.takeovers}; list_pages still pending after 2000 ms`);
    });

    // 6
    await step('user hands back with Esc Esc (Insert -> Normal -> hand back); the held call answers with the takeover note', 10000, async () => {
      const handedAt = Date.now();
      viewer.write(KITTY.esc);
      await sleep(40);
      viewer.write(KITTY.esc);
      const r = await held;
      const all = texts(r);
      const note = all.find((tx) => tx.startsWith(NOTE_PREFIX));
      assert(note, `no takeover note in the result: ${JSON.stringify(all).slice(0, 600)}`);
      assert(note.includes(`it is now at ${resultUrl}.`), `note doesn't name ${resultUrl}: ${note}`);
      const c = await readControl(AGENT, p);
      assert(c.held === false, 'control file still held after the hand-back');
      await until(() => viewer.tail.includes(`NORMAL · agent driving · ${resultUrl}`), {
        timeoutMs: 3000, what: 'the `NORMAL · agent driving · <result url>` status row',
      });
      info(`answered ${Date.now() - handedAt} ms after the hand-back`);
      info(`note: ${note}`);
    });

    // 7
    const shot = await step('page shows the exact typed text; agent take_screenshot saved', 20000, async () => {
      const text = (await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('#result')?.textContent`, returnByValue: true,
      })).result.value;
      assert(text === `Logged in as ${USER} with ${TEST_INPUT}`, `page says ${JSON.stringify(text)}`);
      // chrome-devtools-mcp routes page tools by pageId: find the page's id as the agent would.
      const pages = await agent.callTool('list_pages');
      assert(!texts(pages).some((tx) => tx.startsWith(NOTE_PREFIX)), 'the note was repeated on a later call');
      const line = texts(pages).join('\n').split('\n').find((l) => l.includes(`(${resultUrl})`) || l.endsWith(` ${resultUrl}`));
      const pageId = Number(/^(\d+): /.exec(line ?? '')?.[1]);
      assert(Number.isInteger(pageId), `no page id for ${resultUrl} in list_pages: ${texts(pages).join(' | ').slice(0, 400)}`);
      const file = path.join(tmp, 'logged-in.png');
      const r = await agent.callTool('take_screenshot', { pageId, filePath: file });
      assert(!r.error && !r.result?.isError, `take_screenshot failed: ${JSON.stringify(r.error ?? texts(r))}`);
      const png = await fs.readFile(file);
      assert(png.subarray(1, 4).toString() === 'PNG', 'screenshot is not a PNG');
      if (process.env.E2E_SCREENSHOT_OUT) {
        await fs.mkdir(path.dirname(path.resolve(process.env.E2E_SCREENSHOT_OUT)), { recursive: true });
        await fs.copyFile(file, process.env.E2E_SCREENSHOT_OUT);
      }
      info(`page text: "${text}"; screenshot ${png.length} bytes${process.env.E2E_SCREENSHOT_OUT ? ` -> ${process.env.E2E_SCREENSHOT_OUT}` : ''}`);
      return file;
    });
    void shot;

    // 8
    await step('f shows link hint labels in the page; Esc removes them', 10000, async () => {
      const overlay = async () => (await cdp.send('Runtime.evaluate', {
        expression: `(() => { const o = document.getElementById(${JSON.stringify(HINTS_OVERLAY)}); return o ? o.children.length : -1; })()`,
        returnByValue: true,
      })).result.value;
      assert((await overlay()) === -1, 'hint labels in the page before f');
      viewer.write(kittyChar('f'));
      const labels = await until(async () => { const n = await overlay(); return n > 0 && n; }, {
        timeoutMs: 5000, what: 'the hint overlay in the page',
      });
      assert(viewer.tail.includes('f: type a label'), 'the status row never said `f: type a label`');
      viewer.write(KITTY.esc);
      await until(async () => (await overlay()) === -1, { timeoutMs: 5000, what: 'Esc to remove the hint overlay' });
      info(`overlay #${HINTS_OVERLAY} had ${labels} label(s); gone after Esc`);
    });

    // 9
    await step(':q quits the viewer with exit 0 and restores the terminal', 10000, async () => {
      await typeKeys(viewer, ':q');
      await until(() => viewer.tail.includes(':q█'), { timeoutMs: 3000, what: 'the `:q█` command line' });
      viewer.write(KITTY.enter);
      const { code, signal } = await viewer.exited;
      assert(code === 0, `viewer exited ${code ?? signal}; stderr: ${viewer.stderr}`);
      const end = viewer.tail.slice(-400);
      for (const seq of [`${ESC}[<u`, `${ESC}[?1003l`, `${ESC}[?1006l`, `${ESC}[?2004l`, `${ESC}[?1049l`]) {
        assert(end.includes(seq), `pty output doesn't end with ${JSON.stringify(seq)}`);
      }
      assert(/\x1b\[\?1049l[\s\r\n]*$/.test(end), `last sequence isn't ?1049l: ${JSON.stringify(end.slice(-60))}`);
      info(`viewer exit 0; ${viewer.frames} frames, ${(viewer.bytes / 1e6).toFixed(1)} MB through the pty; tail ${JSON.stringify(end.slice(-120))}`);
      viewer = null;
    });

    // 10
    await step('agent closes (stdin end): its Chrome is gone and the registry is empty', 20000, async () => {
      cdp?.close();
      cdp = null;
      agent.child.stdin.end();
      const { code, signal } = await agent.exited;
      assert(code === 0, `termbrowse mcp exited ${code ?? signal}`);
      await until(() => !alive(chromePid), { timeoutMs: 5000, what: `Chrome pid ${chromePid} to exit` });
      const rows = await termbrowseJson(['agents', '--json'], env);
      assert(Array.isArray(rows) && rows.length === 0, `registry not empty: ${JSON.stringify(rows)}`);
      info(`mcp exit 0; Chrome ${chromePid} gone; registry []`);
      agent = null;
    });
  } catch (err) {
    failed = true;
    if (agent) console.log(`--- termbrowse mcp stderr ---\n${agent.stderr().slice(-3000)}`);
    if (viewer) console.log(`--- viewer stderr ---\n${viewer.stderr.slice(-3000)}\n--- pty tail ---\n${JSON.stringify(viewer.tail.slice(-800))}`);
    if (!(err instanceof CheckFailed)) console.log(err.stack);
  } finally {
    const start = Date.now();
    cdp?.close();
    if (viewer) {
      viewer.child.kill('SIGTERM');
      await Promise.race([viewer.exited, sleep(3000)]);
      if (viewer.child.exitCode === null) viewer.child.kill('SIGKILL');
    }
    if (agent) {
      agent.child.stdin.end();
      await Promise.race([agent.exited, sleep(8000)]);
      if (agent.child.exitCode === null) agent.child.kill('SIGKILL');
    }
    // Our own Chrome (from the temp registry), if the agent didn't close it.
    if (chromePid && alive(chromePid)) {
      try { process.kill(-chromePid, 'SIGKILL'); } catch { try { process.kill(chromePid, 'SIGKILL'); } catch { /* gone */ } }
    }
    if (site) await new Promise((r) => { site.closeAllConnections?.(); site.close(r); });
    await fs.rm(tmp, { recursive: true, force: true });
    console.log(`cleanup done (${Date.now() - start} ms): temp dir removed, site closed, started processes stopped`);
  }
  console.log(failed ? `E2E FAIL (${elapsed()})` : `E2E PASS: ${stepNo} steps (${elapsed()})`);
  return failed ? 1 : 0;
}

process.exitCode = await main();
