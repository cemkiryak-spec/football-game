// Connections between the host and guests.
//
// First choice is a direct browser-to-browser WebRTC connection via PeerJS:
// the host registers a short room code with the PeerJS signalling server and
// guests connect straight to it. Some networks (carrier-grade or symmetric
// NAT, strict firewalls) make that impossible, so if it doesn't open quickly
// the guest falls back to the relay in relay.js. The host listens on both.
//
// URL overrides (handy for self-hosting, troubleshooting and tests):
//   ?signal=host[:port][/path]   use your own PeerServer instead of 0.peerjs.com
//   ?secure=0|1                  force ws:// or wss:// for that server
//   ?ice=none                    skip STUN/TURN (same-machine / LAN testing)
//   ?direct=off                  never try direct connections (relay only)
//   ?relay=...|off               see relay.js

import { RelayHost, RelayGuest, relayBrokers } from './relay.js';

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

const DIRECT_TIMEOUT_MS = 7000;

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

const param = (name) => new URLSearchParams(location.search).get(name);
const directAllowed = () => param('direct') !== 'off' && param('direct') !== '0';

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
  opts.config = { iceServers: params.get('ice') === 'none' ? [] : ICE_SERVERS };
  return opts;
}

const fail = (type, message) => Object.assign(new Error(message || type), { type });

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
    case 'offline':
      return "Couldn't reach the game servers. Check your internet connection and try again.";
    case 'missing-lib':
      return 'Part of the game failed to load. Check your connection and reload the page.';
    case 'unreachable':
      return "Couldn't reach the host. Make sure they still have the game open and on screen (phones pause pages in the background), then try again.";
    case 'timeout':
      return 'The host took too long to answer. Try again in a moment.';
    default:
      return (err && err.message) || 'Something went wrong with the connection.';
  }
}

/** Host side: owns the room code and accepts guests, directly and through the relay. */
export class HostLink {
  constructor({ onConnection, onError }) {
    this.onConnection = onConnection;
    this.onError = onError;
    this.peer = null;
    this.code = null;
    this.direct = false;
    this.closed = false;
    this.relay = new RelayHost({ onConnection });
    this.onVisible = () => {
      // Phones suspend background pages; reconnect to signalling on return.
      if (document.visibilityState === 'visible' && this.peer && this.peer.disconnected && !this.peer.destroyed) {
        this.peer.reconnect();
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  async open() {
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode();
      const [direct, relay] = await Promise.allSettled([
        directAllowed() ? this.openDirect(code) : Promise.reject(fail('disabled')),
        this.relay.open(code),
      ]);
      if (direct.status === 'rejected' && direct.reason.type === 'unavailable-id') {
        this.relay.close();
        continue;
      }
      this.direct = direct.status === 'fulfilled';
      if (!this.direct && !(relay.status === 'fulfilled' && relay.value > 0)) {
        this.relay.close();
        const reason = direct.reason && direct.reason.type !== 'disabled' ? direct.reason : null;
        throw reason || fail('network');
      }
      this.code = code;
      return code;
    }
    throw fail('unavailable-id', 'Could not reserve a room code.');
  }

  openDirect(code) {
    if (typeof window.Peer !== 'function') return Promise.reject(fail('missing-lib'));
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(ID_PREFIX + code, peerOptions());
      let opened = false;
      const timer = setTimeout(() => {
        if (opened) return;
        peer.destroy();
        reject(fail('network', 'signalling timed out'));
      }, DIRECT_TIMEOUT_MS);
      peer.on('open', () => {
        opened = true;
        clearTimeout(timer);
        this.peer = peer;
        resolve();
      });
      peer.on('connection', (conn) => this.onConnection(conn));
      peer.on('disconnected', () => {
        // Lost the signalling server; existing players are unaffected, but
        // reconnect so new players can still join directly.
        if (!this.closed) setTimeout(() => !this.closed && !peer.destroyed && peer.reconnect(), 2000);
      });
      peer.on('error', (err) => {
        if (!opened) {
          clearTimeout(timer);
          peer.destroy();
          reject(err);
        } else if (
          !['peer-unavailable', 'network', 'socket-error', 'socket-closed', 'disconnected'].includes(err.type)
        ) {
          if (this.onError) this.onError(err);
        }
      });
    });
  }

  close() {
    this.closed = true;
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.peer) this.peer.destroy();
    this.relay.close();
  }
}

/** Guest side: one connection to the host — direct if possible, otherwise relayed. */
export class GuestLink {
  constructor({ onData, onClose, onStatus }) {
    this.onData = onData;
    this.onClose = onClose;
    this.onStatus = onStatus || (() => {});
    this.mode = null; // 'direct' | 'relay'
    this.peer = null;
    this.conn = null;
    this.relay = null;
    this.closed = false;
  }

  async connect(code, hello) {
    let directErr = null;
    if (directAllowed()) {
      this.onStatus('direct');
      try {
        await this.connectDirect(code, hello);
        this.mode = 'direct';
        return;
      } catch (err) {
        directErr = err;
        this.closeDirect();
        if (this.closed) throw err;
      }
    }
    if (!relayBrokers().length) throw directErr || fail('unreachable');

    this.onStatus('relay', directErr);
    this.relay = new RelayGuest({ onData: (msg) => !this.closed && this.onData(msg) });
    try {
      await this.relay.connect(code, hello);
      this.mode = 'relay';
    } catch (relayErr) {
      this.relay = null;
      if (this.closed) throw fail('cancelled');
      if (directErr && directErr.type === 'peer-unavailable') throw directErr;
      if (relayErr.type === 'relay-unreachable' && (!directErr || directErr.type === 'network')) throw fail('offline');
      throw fail('unreachable');
    }
  }

  connectDirect(code, hello) {
    if (typeof window.Peer !== 'function') return Promise.reject(fail('missing-lib'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(fail('timeout')), DIRECT_TIMEOUT_MS);

      const peer = new window.Peer(peerOptions());
      this.peer = peer;
      peer.on('error', (err) => done(err));
      peer.on('open', () => {
        // `reliable: false` gives an unordered (but still retransmitting)
        // channel, so one lost packet doesn't stall every snapshot behind it.
        const conn = peer.connect(ID_PREFIX + code, { reliable: false, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => {
          if (settled) return;
          conn.send(hello);
          done();
        });
        conn.on('data', (msg) => this.onData(msg));
        conn.on('close', () => this.handleClose());
        conn.on('error', () => this.handleClose());
      });
    });
  }

  send(msg, opts) {
    if (this.mode === 'relay') this.relay.send(msg, opts);
    else if (this.conn && this.conn.open) this.conn.send(msg);
  }

  handleClose() {
    if (this.closed || this.mode !== 'direct') return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  closeDirect() {
    const { conn, peer } = this;
    this.conn = null;
    this.peer = null;
    if (conn) conn.close();
    if (peer) peer.destroy();
  }

  close() {
    this.closed = true;
    this.closeDirect();
    if (this.relay) this.relay.close();
    this.relay = null;
  }
}
