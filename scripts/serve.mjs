// Minimal static file server for playing/testing locally: `npm start`.
// (Any static server works — the game is just files.)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'ENOENT' });
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Kickabout running at http://localhost:${port}/`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${port}/`);
    }
  }
});
