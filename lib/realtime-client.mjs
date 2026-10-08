// Minimal Supabase Realtime (Phoenix channels) broadcast client. Isomorphic: uses the global WebSocket
// (browsers and Node 22). It only ever LISTENS for "changed" pings on a team channel and tells the
// caller to refetch authoritative state; correctness never depends on a ping arriving.
//
//   const sub = subscribeTeamChannel({ url, apikey, token, onPing, onStatus });
//   sub.close();
//
// onPing(): a teammate changed something -> refetch /api/state.
// onStatus('connected' | 'disconnected'): on every (re)connect the caller should refetch too, since
// events may have been missed while the socket was down.

export function subscribeTeamChannel({ url, apikey, token, onPing, onStatus, WebSocketImpl }) {
  const WS = WebSocketImpl ?? globalThis.WebSocket;
  const wsUrl = `${url.replace(/^http/, 'ws').replace(/\/$/, '')}/realtime/v1/websocket?apikey=${encodeURIComponent(apikey)}&vsn=1.0.0`;
  const topic = `realtime:team:${token}`;
  let ws = null;
  let closed = false;
  let ref = 0;
  let heartbeat = null;
  let retry = 0;
  let retryTimer = null;
  let joined = false;

  const send = (obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };
  const nextRef = () => String(++ref);

  function connect() {
    if (closed) return;
    ws = new WS(wsUrl);
    ws.onopen = () => {
      send({ topic, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { enabled: false }, private: false } }, ref: nextRef() });
      heartbeat = setInterval(() => send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: nextRef() }), 25000);
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.topic !== topic) return;
      if (msg.event === 'phx_reply' && msg.payload?.status === 'ok' && !joined) {
        joined = true;
        retry = 0;
        onStatus?.('connected');
      } else if (msg.event === 'broadcast') {
        onPing?.();
      } else if (msg.event === 'phx_error' || msg.event === 'phx_close') {
        ws.close();
      }
    };
    ws.onclose = () => {
      clearInterval(heartbeat);
      if (joined) onStatus?.('disconnected');
      joined = false;
      if (closed) return;
      const wait = Math.min(15000, 500 * 2 ** retry++) + Math.random() * 250;
      retryTimer = setTimeout(connect, wait);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };
  }
  connect();

  return {
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
    },
    // test hook: drop the socket as a network failure would; the client must recover by itself
    _drop() {
      try {
        ws?.close();
      } catch {}
    },
  };
}
