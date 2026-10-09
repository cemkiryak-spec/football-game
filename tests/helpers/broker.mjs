// A local MQTT-over-WebSocket broker for tests, standing in for the public
// brokers the relay uses in production.

import { createServer } from 'node:http';
import aedesFactory from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

export async function startBroker({ port = 0, host = '127.0.0.1' } = {}) {
  const aedes = aedesFactory();
  const server = createServer();
  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false),
  });
  wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    url: `ws://${host}:${server.address().port}/mqtt`,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => aedes.close(resolve));
    },
  };
}
