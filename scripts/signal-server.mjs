// Optional: run your own PeerJS signalling server instead of the free public
// one (0.peerjs.com). Players then open the game with ?signal=HOST:9000
//   npm install && npm run signal
// Only the initial handshake goes through it; gameplay is peer-to-peer.

import { PeerServer } from 'peer';

const port = Number(process.env.PORT) || 9000;
const host = process.env.HOST || '0.0.0.0';
PeerServer({ port, host, path: '/' }, () => {
  console.log(`PeerJS signalling server listening on :${port}`);
  console.log(`Open the game with ?signal=<this-machine>:${port}&secure=0`);
});
