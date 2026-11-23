// Minimal Chrome DevTools Protocol client: HTTP discovery plus one WebSocket session.

const base = (port) => `http://127.0.0.1:${port}`;

export async function listTargets(port) {
  const res = await fetch(`${base(port)}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`GET /json/list failed: HTTP ${res.status}`);
  return res.json();
}

export async function browserVersion(port) {
  try {
    const res = await fetch(`${base(port)}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function waitForPort(port, timeoutMs = 15000, signal) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    if (await browserVersion(port)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Chrome did not open its debugging port ${port} within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export class CdpSession extends EventTarget {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #closed = false;

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Could not connect to ${wsUrl}`)), { once: true });
    });
  }

  constructor(ws) {
    super();
    this.#ws = ws;
    ws.addEventListener('message', (e) => this.#onMessage(e.data));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => {});
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      this.dispatchEvent(new CustomEvent('event', { detail: { method: msg.method, params: msg.params } }));
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new Error('CDP session closed'));
    this.#pending.clear();
    this.dispatchEvent(new Event('close'));
  }

  send(method, params = {}) {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP session closed'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

export function pickTarget(targets, match) {
  const pages = targets.filter((t) => t.type === 'page');
  if (match) {
    const m = match.toLowerCase();
    const hit = pages.find((t) => `${t.url}`.toLowerCase().includes(m) || `${t.title}`.toLowerCase().includes(m));
    if (hit) return hit;
  }
  return pages[0] ?? null;
}
