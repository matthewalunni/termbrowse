import http from 'node:http';
import { WebSocketServer } from 'ws';

// Fake Chrome DevTools endpoint: HTTP discovery + a CDP WebSocket.
// handlers: { 'Method.name': (params, msg) => result | Promise<result> }
// A handler that throws replies with a CDP error {code, message}.
// connectDelay(url): ms to hold a WebSocket handshake for (e.g. to slow one tab's connect).
export async function startFakeCdp({ handlers = {}, targets, connectDelay } = {}) {
  const received = [];
  const sockets = new Set();
  const server = http.createServer();
  const wss = new WebSocketServer({
    server,
    path: '/devtools/page/fake',
    verifyClient: ({ req }, cb) => {
      const ms = connectDelay?.(req.url) ?? 0;
      if (ms > 0) setTimeout(() => cb(true), ms);
      else cb(true);
    },
  });
  let port;
  let conns = 0;
  const wsUrl = () => `ws://127.0.0.1:${port}/devtools/page/fake`;

  server.on('request', (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/json/list') {
      res.end(JSON.stringify(targets ?? [
        { id: 'T1', type: 'page', url: 'https://example.com/', title: 'Example', webSocketDebuggerUrl: wsUrl() },
      ]));
    } else if (req.url === '/json/version') {
      res.end(JSON.stringify({ Browser: 'Chrome/Fake', webSocketDebuggerUrl: wsUrl() }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    const conn = ++conns; // which connection a message came on (received[i].conn)
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      received.push({ ...msg, conn });
      const handler = handlers[msg.method];
      try {
        const result = handler ? await handler(msg.params, msg) : {};
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: err.message } }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  return {
    port,
    wsUrl: wsUrl(),
    received,
    handlers,
    send(msg) {
      for (const ws of sockets) ws.send(JSON.stringify(msg));
    },
    closeSockets() {
      for (const ws of sockets) ws.close();
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
