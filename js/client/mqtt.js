// A minimal MQTT 3.1.1 client over WebSocket (QoS 0 only) — just enough to
// use a public MQTT broker as a message relay. Works in browsers and Node 22+.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CONNECT = 0x10;
const CONNACK = 2;
const PUBLISH = 3;
const SUBSCRIBE = 0x82;
const SUBACK = 9;
const PINGRESP = 13;

function utf8(s) {
  const bytes = encoder.encode(s);
  const out = new Uint8Array(bytes.length + 2);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 255;
  out.set(bytes, 2);
  return out;
}

function remainingLength(n) {
  const out = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 128;
    out.push(digit);
  } while (n > 0);
  return out;
}

function packet(header, ...parts) {
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const len = remainingLength(size);
  const out = new Uint8Array(1 + len.length + size);
  out[0] = header;
  out.set(len, 1);
  let at = 1 + len.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function connectPacket(clientId, keepAliveSecs) {
  // Protocol "MQTT" level 4 (3.1.1), clean session, keep-alive.
  const header = Uint8Array.of(...utf8('MQTT'), 4, 0x02, keepAliveSecs >> 8, keepAliveSecs & 255);
  return packet(CONNECT, header, utf8(clientId));
}

export function subscribePacket(packetId, topic) {
  return packet(SUBSCRIBE, Uint8Array.of(packetId >> 8, packetId & 255), utf8(topic), Uint8Array.of(0));
}

export function publishPacket(topic, payload) {
  return packet(0x30, utf8(topic), encoder.encode(payload));
}

export const PINGREQ = Uint8Array.of(0xc0, 0);
export const DISCONNECT = Uint8Array.of(0xe0, 0);

/** Reassembles MQTT packets from WebSocket frames (which may split or batch them). */
export class PacketReader {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const packets = [];
    let at = 0;
    while (at + 2 <= merged.length) {
      let len = 0;
      let mult = 1;
      let i = at + 1;
      let complete = false;
      for (; i < merged.length && i < at + 5; i++) {
        len += (merged[i] & 127) * mult;
        mult *= 128;
        if ((merged[i] & 128) === 0) {
          complete = true;
          i++;
          break;
        }
      }
      if (!complete || i + len > merged.length) break;
      packets.push({ type: merged[at] >> 4, flags: merged[at] & 15, body: merged.subarray(i, i + len) });
      at = i + len;
    }
    this.buf = merged.slice(at);
    return packets;
  }
}

export function parsePublish(flags, body) {
  const topicLen = (body[0] << 8) | body[1];
  const topic = decoder.decode(body.subarray(2, 2 + topicLen));
  const qos = (flags >> 1) & 3;
  const payloadAt = 2 + topicLen + (qos > 0 ? 2 : 0);
  return { topic, payload: decoder.decode(body.subarray(payloadAt)) };
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return 'kab' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class MqttClient {
  constructor(url, { keepAlive = 15 } = {}) {
    this.url = url;
    this.keepAlive = keepAlive;
    this.ws = null;
    this.reader = new PacketReader();
    this.nextPacketId = 0;
    this.pendingSubs = new Map();
    this.onMessage = null; // (topic, payload) => void
    this.onClose = null; // () => void, after a successful connect
    this.connected = false;
    this.closed = false;
  }

  connect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.teardown();
        reject(Object.assign(new Error(`${this.url}: ${why}`), { type: 'relay-unreachable' }));
      };
      const timer = setTimeout(() => fail('timed out'), timeoutMs);
      let ws;
      try {
        ws = new WebSocket(this.url, ['mqtt']);
      } catch (err) {
        fail(err.message);
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => ws.send(connectPacket(randomId(), this.keepAlive));
      ws.onerror = () => fail('connection error');
      ws.onclose = () => {
        if (!settled) fail('closed');
        else this.handleClose();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') return;
        this.lastRx = Date.now();
        for (const p of this.reader.push(new Uint8Array(e.data))) {
          if (p.type === CONNACK) {
            if (p.body[1] !== 0) {
              fail(`refused (${p.body[1]})`);
              return;
            }
            settled = true;
            clearTimeout(timer);
            this.connected = true;
            this.startKeepAlive();
            resolve();
          } else {
            this.handlePacket(p);
          }
        }
      };
    });
  }

  handlePacket(p) {
    if (p.type === PUBLISH) {
      const { topic, payload } = parsePublish(p.flags, p.body);
      if (this.onMessage) this.onMessage(topic, payload);
    } else if (p.type === SUBACK) {
      const id = (p.body[0] << 8) | p.body[1];
      const pending = this.pendingSubs.get(id);
      if (!pending) return;
      this.pendingSubs.delete(id);
      if (p.body[2] === 0x80) pending.reject(new Error('subscription refused'));
      else pending.resolve();
    } else if (p.type === PINGRESP) {
      // lastRx already updated
    }
  }

  startKeepAlive() {
    this.lastRx = Date.now();
    const every = Math.max(5, this.keepAlive / 2) * 1000;
    this.pinger = setInterval(() => {
      // No reply to two pings in a row: the connection is dead.
      if (Date.now() - this.lastRx > every * 2.5) {
        this.ws.close();
        this.handleClose();
        return;
      }
      this.write(PINGREQ);
    }, every);
  }

  write(bytes) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(bytes);
      return true;
    }
    return false;
  }

  subscribe(topic, timeoutMs = 6000) {
    this.nextPacketId = (this.nextPacketId % 0xffff) + 1;
    const id = this.nextPacketId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSubs.delete(id);
        reject(new Error('subscribe timed out'));
      }, timeoutMs);
      this.pendingSubs.set(id, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      if (!this.write(subscribePacket(id, topic))) this.pendingSubs.get(id).reject(new Error('not connected'));
    });
  }

  /**
   * Publish a message. With `droppable`, the message is skipped instead of
   * queued when the connection is backed up (fine for game snapshots, which
   * are superseded 30 times a second anyway).
   */
  publish(topic, payload, { droppable = false } = {}) {
    if (droppable && this.ws && this.ws.bufferedAmount > 32 * 1024) return false;
    return this.write(publishPacket(topic, payload));
  }

  handleClose() {
    if (!this.connected) return;
    this.connected = false;
    this.teardown();
    if (!this.closed && this.onClose) this.onClose();
  }

  teardown() {
    clearInterval(this.pinger);
    for (const p of this.pendingSubs.values()) p.reject(new Error('connection closed'));
    this.pendingSubs.clear();
    if (this.ws) {
      this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      if (this.ws.readyState <= 1) this.ws.close();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.write(DISCONNECT);
    this.connected = false;
    this.teardown();
  }
}
