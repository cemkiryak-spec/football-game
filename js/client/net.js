// Peer-to-peer plumbing on top of PeerJS (WebRTC data channels).
//
// The host's browser registers a short room code with the PeerJS signalling
// server; guests connect straight to it. After the handshake all game traffic
// flows directly between browsers — no game server needed.
//
// URL overrides (handy for self-hosting the signalling server, or tests):
//   ?signal=host[:port][/path]   use your own PeerServer instead of 0.peerjs.com
//   ?secure=0|1                  force ws:// or wss:// for that server
//   ?ice=none                    skip STUN/TURN (same-machine / LAN testing)

export const PROTOCOL_VERSION = 1;
const ID_PREFIX = 'kickabout-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

export function randomCode() {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

function peerOptions() {
  const params = new URLSearchParams(location.search);
  const opts = { debug: 0 }; // we report errors ourselves
  const signal = params.get('signal');
  if (signal) {
    const m = signal.match(/^([^:/]+)(?::(\d+))?(\/.*)?$/);
    if (m) {
      opts.host = m[1];
      if (m[2]) opts.port = Number(m[2]);
      opts.path = m[3] || '/';
    }
  }
  if (params.has('secure')) opts.secure = params.get('secure') !== '0';
  if (params.get('ice') === 'none') opts.config = { iceServers: [] };
  return opts;
}

export function describeError(err, code) {
  switch (err && err.type) {
    case 'peer-unavailable':
      return `Room ${code || ''} wasn't found. Check the code, and make sure the host still has the game open.`;
    case 'unavailable-id':
      return 'That room code is already taken. Try again.';
    case 'browser-incompatible':
      return "Your browser doesn't support WebRTC, which online play needs. Try a recent Chrome, Firefox, Safari or Edge.";
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return "Couldn't reach the matchmaking server. Check your internet connection and try again.";
    case 'webrtc':
      return "Couldn't open a direct connection between your browsers. A strict firewall or VPN may be blocking it.";
    case 'timeout':
      return "Connecting took too long. The host's network may be blocking peer-to-peer connections — try again, or try another network.";
    default:
      return (err && err.message) || 'Something went wrong with the connection.';
  }
}

function needPeer() {
  if (typeof window.Peer !== 'function') {
    const err = new Error('The networking library failed to load. Check your connection and reload the page.');
    err.type = 'missing-lib';
    throw err;
  }
}

/** Host side: owns the room code and accepts guest connections. */
export class HostLink {
  constructor({ onConnection, onError }) {
    this.onConnection = onConnection;
    this.onError = onError;
    this.peer = null;
    this.code = null;
    this.closed = false;
  }

  async open() {
    needPeer();
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      try {
        await this.tryOpen(code);
        this.code = code;
        return code;
      } catch (err) {
        if (err.type !== 'unavailable-id') throw err;
      }
    }
    const err = new Error('Could not reserve a room code.');
    err.type = 'unavailable-id';
    throw err;
  }

  tryOpen(code) {
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(ID_PREFIX + code, peerOptions());
      let opened = false;
      peer.on('open', () => {
        opened = true;
        this.peer = peer;
        resolve();
      });
      peer.on('connection', (conn) => this.onConnection(conn));
      peer.on('disconnected', () => {
        // Lost the signalling server; existing players are unaffected, but
        // reconnect so new players can still join.
        if (!this.closed) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.on('error', (err) => {
        if (!opened) {
          peer.destroy();
          reject(err);
        } else if (err.type !== 'peer-unavailable' && this.onError) {
          this.onError(err);
        }
      });
    });
  }

  close() {
    this.closed = true;
    if (this.peer) this.peer.destroy();
  }
}

/** Guest side: a single connection to the host. */
export class GuestLink {
  constructor({ onData, onClose }) {
    this.onData = onData;
    this.onClose = onClose;
    this.peer = null;
    this.conn = null;
    this.closed = false;
  }

  connect(code, hello) {
    needPeer();
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.close();
        reject(err);
      };
      const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { type: 'timeout' })), 20000);

      const peer = new window.Peer(peerOptions());
      this.peer = peer;
      peer.on('error', (err) => {
        if (!settled) fail(err);
      });
      peer.on('open', () => {
        // `reliable: false` gives an unordered (but still retransmitting)
        // channel, so one lost packet doesn't stall every snapshot behind it.
        const conn = peer.connect(ID_PREFIX + code, { reliable: false, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          conn.send(hello);
          resolve();
        });
        conn.on('data', (msg) => this.onData(msg));
        conn.on('close', () => this.handleClose());
        conn.on('error', () => this.handleClose());
      });
    });
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  close() {
    this.closed = true;
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
  }
}
