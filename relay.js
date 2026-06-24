// ============================================================
// QFwork.ai — OpenAI Realtime RELAY
// ------------------------------------------------------------
//   Browser  ⇄  (this relay, on your server)  ⇄  OpenAI Realtime
//
// WHY THIS EXISTS:
//   1. The OpenAI Realtime WebSocket requires the API key in an HTTP
//      header. Browsers CANNOT set headers on a WebSocket, so a server
//      relay is mandatory — the browser could never connect directly.
//   2. The key stays on the server, never shipped to the browser.
//   3. Hong Kong: the OpenAI-facing socket is opened by THIS server
//      (hosted in a supported region, e.g. Railway/US), not by the
//      HK browser — so it isn't geo-blocked.
//
// DESIGN: a transparent, stateless pass-through. The relay does NOT
//   understand the Realtime message format — it just forwards raw bytes
//   both ways. All the protocol logic (session.update, audio events)
//   lives in the browser client. This keeps the relay tiny and immune
//   to OpenAI changing event shapes.
// ============================================================

const WebSocket = require('ws');

const OPENAI_HOST = 'wss://api.openai.com/v1/realtime';

function attachRealtimeRelay(httpServer) {
  // Same HTTP server as Express, so one port / one Railway service.
  const wss = new WebSocket.Server({ server: httpServer, path: '/realtime' });

  wss.on('connection', (clientWs) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const model  = process.env.REALTIME_MODEL || 'gpt-realtime-mini';

    if (!apiKey) {
      clientWs.send(JSON.stringify({
        type: 'relay.error',
        message: 'OPENAI_API_KEY is not set on the server.'
      }));
      clientWs.close();
      return;
    }

    // Open the upstream connection to OpenAI.
    const upstream = new WebSocket(`${OPENAI_HOST}?model=${encodeURIComponent(model)}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`
        // Note: the GA Realtime API does NOT use an 'OpenAI-Beta' header.
        // (Only the older preview required 'OpenAI-Beta: realtime=v1'.)
      }
    });

    // Buffer anything the browser sends before OpenAI's socket is open.
    const pending = [];
    let upstreamReady = false;

    upstream.on('open', () => {
      upstreamReady = true;
      for (const m of pending) upstream.send(m);
      pending.length = 0;
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'relay.ready', model }));
      }
    });

    // OpenAI → browser
    upstream.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data.toString());
    });
    upstream.on('close', (code, reason) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'relay.upstream_closed', code, reason: reason.toString() }));
        clientWs.close();
      }
    });
    upstream.on('error', (err) => {
      console.error('Realtime upstream error:', err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'relay.error', message: err.message }));
      }
    });

    // browser → OpenAI
    clientWs.on('message', (data) => {
      const msg = data.toString();
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(msg);
      else pending.push(msg);
    });
    clientWs.on('close', () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });
    clientWs.on('error', () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });
  });

  console.log('🎙️  Realtime relay attached at  ws://<host>/realtime');
}

module.exports = { attachRealtimeRelay };
