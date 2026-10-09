import test from 'node:test';
import assert from 'node:assert/strict';

import { MqttClient, PacketReader, publishPacket, parsePublish, connectPacket } from '../js/client/mqtt.js';
import { RelayHost, RelayGuest } from '../js/client/relay.js';
import { startBroker } from './helpers/broker.mjs';

const DEAD = 'ws://127.0.0.1:9/mqtt'; // nothing listens on the discard port

function waitFor(check, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('packet reader copes with split and batched frames', () => {
  const a = publishPacket('room/x', 'hello');
  const b = publishPacket('room/y', 'x'.repeat(300)); // multi-byte remaining length
  const both = new Uint8Array(a.length + b.length);
  both.set(a);
  both.set(b, a.length);

  const reader = new PacketReader();
  const out = [];
  for (let i = 0; i < both.length; i += 7) out.push(...reader.push(both.subarray(i, i + 7)));
  assert.equal(out.length, 2);
  assert.deepEqual(parsePublish(out[0].flags, out[0].body), { topic: 'room/x', payload: 'hello' });
  assert.equal(parsePublish(out[1].flags, out[1].body).payload.length, 300);

  assert.equal(new PacketReader().push(both).length, 2);
});

test('connect packet is well formed', () => {
  const p = connectPacket('kab123', 15);
  assert.equal(p[0], 0x10);
  assert.equal(p[1], p.length - 2);
  assert.equal(new TextDecoder().decode(p.subarray(4, 8)), 'MQTT');
  assert.equal(p[8], 4); // MQTT 3.1.1
});

test('mqtt client publishes and receives through a broker', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const a = new MqttClient(broker.url);
  const b = new MqttClient(broker.url);
  await Promise.all([a.connect(), b.connect()]);
  t.after(() => (a.close(), b.close()));
  const got = [];
  b.onMessage = (topic, payload) => got.push([topic, payload]);
  await b.subscribe('t/1');
  a.publish('t/1', JSON.stringify({ hi: 'ünïcødé ⚽' }));
  await waitFor(() => got.length);
  assert.deepEqual(got[0], ['t/1', '{"hi":"ünïcødé ⚽"}']);
});

test('connecting to a dead broker fails cleanly', async () => {
  await assert.rejects(new MqttClient(DEAD).connect(2000), { type: 'relay-unreachable' });
});

test('host and guest talk through the relay, skipping a dead broker', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());

  // The host answers a hello with a welcome, like HostRoom does.
  const conns = [];
  const hostData = [];
  const accept = (conn) => {
    conns.push(conn);
    conn.on('data', (m) => {
      hostData.push(m);
      if (m.t === 'hello') conn.send({ t: 'welcome', id: 2 });
    });
  };
  const host = new RelayHost({ brokers: [DEAD, broker.url], onConnection: accept });
  t.after(() => host.close());
  assert.equal(await host.open('ABCDE'), 1, 'one of the two brokers is reachable');

  const guestData = [];
  const guest = new RelayGuest({ brokers: [broker.url, DEAD], onData: (m) => guestData.push(m) });
  await guest.connect('ABCDE', { t: 'hello', name: 'Ann', v: 1 });
  assert.deepEqual(guestData[0], { t: 'welcome', id: 2 });
  assert.equal(conns.length, 1, 'one guest, even though it knocked on several brokers');
  assert.equal(conns[0].relay, true);

  guest.send({ t: 'in', x: 1 });
  await waitFor(() => hostData.some((m) => m.t === 'in'));

  // Room-wide broadcasts reach the guest once it has been welcomed.
  await new Promise((r) => setTimeout(r, 100)); // let its subscription settle
  host.broadcast({ t: 'room', rv: 3 });
  await waitFor(() => guestData.some((m) => m.t === 'room'));

  // Leaving closes the host's side straight away.
  let closed = false;
  conns[0].on('close', () => (closed = true));
  guest.close();
  await waitFor(() => closed);
  assert.equal(host.guestCount, 0);
});

test('a guest gets a clear error when no host answers', async (t) => {
  const broker = await startBroker();
  t.after(() => broker.close());
  const guest = new RelayGuest({ brokers: [broker.url], onData: () => {} });
  await assert.rejects(guest.connect('NOONE', { t: 'hello' }, 1500), { type: 'relay-no-host' });
});

test('a guest that cannot reach any broker is told so', async () => {
  const guest = new RelayGuest({ brokers: [DEAD], onData: () => {} });
  await assert.rejects(guest.connect('NOONE', { t: 'hello' }, 1500), { type: 'relay-unreachable' });
});
