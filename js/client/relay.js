// Relay transport: the fallback for when two browsers can't open a direct
// WebRTC connection (strict or carrier-grade NAT, firewalls, some mobile
// networks). Messages travel through public MQTT brokers over secure
// WebSockets instead, which get through practically any network.
//
// Topics, per room code:
//   kickabout/v1/<CODE>/h        guests → host, wrapped as {k: guestKey, m: message}
//   kickabout/v1/<CODE>/g/<key>  host → one guest
//   kickabout/v1/<CODE>/a        host → all relayed guests (room state, snapshots)
//
// The host listens on every broker at once; each guest uses whichever broker
// first gets an answer from the host.
//
// URL overrides: ?relay=wss://broker/path,wss://other/path  ·  ?relay=off

import { MqttClient } from './mqtt.js';

export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt', // port 443 gets through strict firewalls
  'wss://test.mosquitto.org:8081/mqtt',
];

export function relayBrokers() {
  const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('relay');
  if (param === 'off' || param === '0') return [];
  if (param) return param.split(',').filter(Boolean);
  return DEFAULT_BROKERS;
}

function topicsFor(code) {
  const root = `kickabout/v1/${code}`;
  return { host: `${root}/h`, all: `${root}/a`, guest: (key) => `${root}/g/${key}` };
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

function parse(payload) {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** One broker connection that reconnects and re-subscribes by itself. */
class BrokerLine {
  constructor(url, onMessage) {
    this.url = url;
    this.onMessage = onMessage;
    this.topics = new Set();
    this.client = null;
    this.closed = false;
    this.everUp = false;
    this.failures = 0;
    this.retryDelay = 1000;
  }

  /** First connection attempt; resolves true/false. Retries continue in the background either way. */
  async start() {
    try {
      await this.connect();
      return true;
    } catch {
      this.retryLater();
      return false;
    }
  }

  async connect() {
    const client = new MqttClient(this.url);
    client.onMessage = (topic, payload) => this.onMessage(this, topic, payload);
    client.onClose = () => {
      if (this.client !== client) return;
      this.client = null;
      this.retryLater();
    };
    await client.connect();
    try {
      for (const t of this.topics) await client.subscribe(t);
    } catch (err) {
      client.close();
      throw err;
    }
    if (this.closed) {
      client.close();
      return;
    }
    this.client = client;
    this.everUp = true;
    this.failures = 0;
    this.retryDelay = 1000;
  }

  retryLater() {
    if (this.closed || this.retryTimer) return;
    // A broker that never worked from here is probably blocked or gone; stop
    // knocking. One that dropped mid-game keeps reconnecting.
    if (!this.everUp && ++this.failures > 3) return;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try {
        await this.connect();
      } catch {
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
        this.retryLater();
      }
    }, this.retryDelay);
  }

  async subscribe(topic) {
    this.topics.add(topic);
    if (this.client) await this.client.subscribe(topic);
  }

  publish(topic, payload, opts) {
    return this.client ? this.client.publish(topic, payload, opts) : false;
  }

  get up() {
    return !!this.client;
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    if (this.client) this.client.close();
    this.client = null;
  }
}

/** Host-side view of one relayed guest; quacks like a PeerJS DataConnection. */
class RelayConn {
  constructor(hub, line, key) {
    this.hub = hub;
    this.line = line;
    this.key = key;
    this.relay = true;
    this.open = true;
    this.handlers = {};
  }

  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] || []) fn(...args);
  }

  send(msg) {
    if (this.open) this.line.publish(this.hub.topics.guest(this.key), JSON.stringify(msg));
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.hub.conns.delete(this.key);
    this.emit('close');
  }
}

export class RelayHost {
  constructor({ onConnection, brokers = relayBrokers() }) {
    this.onConnection = onConnection;
    this.brokers = brokers;
    this.lines = [];
    this.conns = new Map(); // guest key -> RelayConn
  }

  /**
   * Listen for guests on every broker. Resolves as soon as one broker is
   * listening (with the count so far), or with 0 once every broker failed.
   * Brokers that are slow or down keep retrying in the background.
   */
  open(code) {
    this.close();
    this.topics = topicsFor(code);
    this.lines = this.brokers.map((url) => new BrokerLine(url, (line, topic, payload) => this.receive(line, payload)));
    if (!this.lines.length) return Promise.resolve(0);
    return new Promise((resolve) => {
      let pending = this.lines.length;
      for (const line of this.lines) {
        line.topics.add(this.topics.host);
        line.start().then((ok) => {
          pending--;
          if (ok || pending === 0) resolve(this.reachable);
        });
      }
    });
  }

  receive(line, payload) {
    const env = parse(payload);
    if (!env || typeof env.k !== 'string' || !/^[a-z0-9]{1,24}$/.test(env.k) || !env.m) return;
    const conn = this.conns.get(env.k);
    if (!conn) {
      if (env.m.t !== 'hello') return;
      const fresh = new RelayConn(this, line, env.k);
      this.conns.set(env.k, fresh);
      this.onConnection(fresh);
      fresh.emit('data', env.m);
      return;
    }
    if (conn.line !== line) return; // the same guest trying us through another broker
    if (env.m.t === 'leave') conn.close();
    else conn.emit('data', env.m);
  }

  /** Send one message to every relayed guest (one publish per broker in use). */
  broadcast(msg, opts) {
    const lines = new Set();
    for (const conn of this.conns.values()) if (conn.open) lines.add(conn.line);
    if (!lines.size) return;
    const payload = JSON.stringify(msg);
    for (const line of lines) line.publish(this.topics.all, payload, opts);
  }

  get guestCount() {
    return this.conns.size;
  }

  get reachable() {
    return this.lines.filter((l) => l.up).length;
  }

  close() {
    for (const line of this.lines) line.close();
    this.lines = [];
  }
}

/** Guest side: one relayed connection to a host. */
export class RelayGuest {
  constructor({ onData, brokers = relayBrokers() }) {
    this.onData = onData;
    this.brokers = brokers;
    this.lines = [];
    this.line = null;
    this.key = randomKey();
  }

  /**
   * Knock on every broker at once; the first one the host answers through
   * wins. Resolves once the host's first reply (normally `welcome`) arrived.
   */
  connect(code, hello, timeoutMs = 9000) {
    this.topics = topicsFor(code);
    const wrapped = JSON.stringify({ k: this.key, m: hello });
    return new Promise((resolve, reject) => {
      let reached = 0;
      const timer = setTimeout(() => {
        this.close();
        const err = new Error(reached ? 'The host did not answer through the relay.' : 'No relay server reachable.');
        err.type = reached ? 'relay-no-host' : 'relay-unreachable';
        reject(err);
      }, timeoutMs);

      const onMessage = (line, topic, payload) => {
        if (this.line && line !== this.line) return;
        const msg = parse(payload);
        if (!msg) return;
        if (!this.line) {
          this.line = line;
          clearTimeout(timer);
          for (const other of this.lines) if (other !== line) other.close();
          this.lines = [line];
          line.subscribe(this.topics.all).catch(() => {});
          resolve();
        }
        this.onData(msg);
      };

      this.lines = this.brokers.map((url) => new BrokerLine(url, onMessage));
      for (const line of this.lines) {
        line.topics.add(this.topics.guest(this.key));
        line.start().then((ok) => {
          if (!ok || line.closed) return;
          reached++;
          // Say hello now, and again every couple of seconds in case the host's
          // own link to this broker is still coming up.
          const knock = () => {
            if (this.line || line.closed) return;
            line.publish(this.topics.host, wrapped);
            setTimeout(knock, 2000);
          };
          knock();
        });
      }
    });
  }

  send(msg, opts) {
    if (this.line) this.line.publish(this.topics.host, JSON.stringify({ k: this.key, m: msg }), opts);
  }

  close() {
    if (this.line) this.send({ t: 'leave' });
    const lines = this.lines;
    this.lines = [];
    this.line = null;
    // Let the goodbye go out before hanging up.
    setTimeout(() => lines.forEach((l) => l.close()), 150);
  }
}
