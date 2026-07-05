// Thin WebSocket wrapper. Connects outward to the server that served this page
// (same host/port), so it works from behind any home router without port
// forwarding. Emits parsed messages to a single handler.
export class Net {
  constructor() {
    this.socket = null;
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${proto}://${location.host}`);
    this.socket.addEventListener('open', () => this.onOpen());
    this.socket.addEventListener('close', () => this.onClose());
    this.socket.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    });
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
    }
  }
}
