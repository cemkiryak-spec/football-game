// End-to-end check of online play: two real browsers (host + guest) find each
// other through a local PeerJS signalling server and a local MQTT relay
// broker, then play a match. Three scenarios:
//
//   1. direct     — WebRTC works: the guest connects browser-to-browser.
//   2. blocked    — WebRTC can't get through (like a strict NAT or firewall):
//                   the guest must fall back to the relay.
//   3. no-signal  — the PeerJS server is unreachable: everything goes through the relay.
//
//   npm install && npm run test:e2e
//
// Needs the dev dependencies (peer, aedes, ws, playwright) and a Chromium
// that Playwright can launch.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PeerServer } from 'peer';
import { chromium } from 'playwright';
import { startBroker } from '../helpers/broker.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const WEB_PORT = 8765;
const PEER_PORT = 9765;
const shots = process.env.SHOTS_DIR || `${root}/test-results`;
mkdirSync(shots, { recursive: true });

const web = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(WEB_PORT) },
  stdio: 'ignore',
});
const signal = PeerServer({ port: PEER_PORT, host: '127.0.0.1', path: '/' });
const broker = await startBroker();
await new Promise((r) => setTimeout(r, 800));

const browsers = [];
async function launch(args) {
  const b = await chromium.launch({ args });
  browsers.push(b);
  return b;
}

const errors = [];
const NETWORK_NOISE = /ERR_CONNECTION_REFUSED|Failed to load resource|WebSocket connection to .* failed/;
async function openPage(browser, label, { serverDown = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 720 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => {
    // The browser itself logs refused connections to a server that's down.
    if (m.type() !== 'error' || (serverDown && NETWORK_NOISE.test(m.text()))) return;
    errors.push(`[${label}] ${m.text()}`);
  });
  return page;
}

const step = (msg) => console.log(`  • ${msg}`);
const relayParam = `relay=${encodeURIComponent(broker.url)}`;
const url = (signalPort) =>
  `http://localhost:${WEB_PORT}/?signal=127.0.0.1:${signalPort}&secure=0&ice=none&${relayParam}`;

async function createRoom(host, startUrl) {
  await host.goto(startUrl);
  await host.fill('#name', 'Hosty');
  await host.click('#btn-create');
  await host.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  const code = (await host.textContent('#room-code')).trim();
  const link = await host.inputValue('#invite-link');
  assert.match(code, /^[A-Z0-9]{5}$/);
  assert.ok(link.includes(`room=${code}`), link);
  assert.ok(link.includes('relay='), 'invite links keep the relay override');
  step(`room ${code} is open`);
  return { code, link };
}

async function join(guest, link, name = 'Guesty') {
  await guest.goto(link);
  await guest.waitForSelector('#invite-banner:not([hidden])');
  await guest.fill('#name', name);
  await guest.click('#btn-accept-invite');
  await guest.waitForSelector('#screen-lobby:not([hidden]), #screen-game:not([hidden])', { timeout: 30000 });
}

const hostState = (host) =>
  host.evaluate(() => {
    const m = window.kickabout.game.sim.match;
    return {
      tick: m.tick,
      players: m.players.map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y })),
    };
  });

/** Start a first-to-1 match and check controls, sync, pause, a goal and full time. */
async function playMatch(host, guest, label) {
  await host.waitForFunction(() => document.querySelector('#list-blue').textContent.includes('Guesty'));
  await host.selectOption('#lobby-score', '1');
  await guest.waitForFunction(() => document.querySelector('#lobby-score').value === '1');
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])');
  await guest.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
  await guest.waitForFunction(() => window.kickabout.view && window.kickabout.view.players.length === 2);

  step('guest controls reach the host');
  const before = await hostState(host);
  const guestId = before.players.find((p) => p.team === 'blue').id;
  await guest.keyboard.down('ArrowDown');
  await guest.waitForTimeout(900);
  await guest.keyboard.up('ArrowDown');
  await guest.waitForTimeout(300);
  const after = await hostState(host);
  const yBefore = before.players.find((p) => p.id === guestId).y;
  const yAfter = after.players.find((p) => p.id === guestId).y;
  assert.ok(yAfter - yBefore > 30, `guest moved down on the host (${yBefore} -> ${yAfter})`);

  step("host's simulation is mirrored on the guest");
  const truth = (await hostState(host)).players.find((p) => p.id === guestId);
  const seen = await guest.evaluate((id) => {
    const v = window.kickabout.view;
    return { tick: v.tick, me: v.players.find((p) => p.id === id) };
  }, guestId);
  assert.ok(Math.abs(seen.me.y - truth.y) < 20, 'guest sees itself where the host has it');

  step('pause from the guest pauses everyone');
  await guest.keyboard.press('KeyP');
  await host.waitForFunction(() => window.kickabout.game.sim.match.paused);
  await guest.waitForSelector('#paused:not([hidden])');
  await host.keyboard.press('KeyP');
  await host.waitForFunction(() => !window.kickabout.game.sim.match.paused);
  await guest.waitForSelector('#paused', { state: 'hidden' });

  step('a goal is scored, and both see full time');
  await host.keyboard.down('KeyD');
  await host.waitForFunction(() => window.kickabout.game.sim.match.phase === 'play', null, { timeout: 8000 });
  await host.keyboard.up('KeyD');
  await host.evaluate(() => {
    const m = window.kickabout.game.sim.match;
    Object.assign(m.ball, { x: 400, y: 0, vx: 6, vy: 0 });
  });
  await guest.waitForFunction(() => document.querySelector('#hud-red').textContent === '1', null, { timeout: 5000 });
  await guest.waitForSelector('#end-panel:not([hidden])', { timeout: 8000 });
  await guest.screenshot({ path: `${shots}/${label}-fulltime-guest.png` });
  assert.match(await guest.textContent('#end-title'), /Hosty wins/);
}

const mode = (guest) => guest.evaluate(() => window.kickabout.game.mode);

async function scenarioDirect(browser) {
  console.log('\nScenario 1: direct connection');
  const host = await openPage(browser, 'host');
  const guest = await openPage(browser, 'guest');
  const { link } = await createRoom(host, url(PEER_PORT));

  step('guest opens the invite link and joins directly');
  await join(guest, link);
  assert.equal(await mode(guest), 'direct');
  await guest.waitForFunction(() => document.querySelector('#list-red').textContent.includes('Hosty'));
  await host.screenshot({ path: `${shots}/lobby-host.png` });

  step('guest can switch teams, then goes back to blue');
  await guest.click('[data-join="spec"]');
  await host.waitForFunction(() => document.querySelector('#list-spec').textContent.includes('Guesty'));
  assert.equal(await host.isDisabled('#btn-start'), true, 'cannot start with an empty team');
  await guest.click('[data-join="blue"]');

  await playMatch(host, guest, 'direct');
  assert.equal(await guest.isVisible('#btn-rematch'), false, 'only the host can restart');

  step('rematch restarts for both');
  await host.click('#btn-rematch');
  await guest.waitForSelector('#end-panel', { state: 'hidden', timeout: 5000 });
  await guest.waitForFunction(() => document.querySelector('#hud-red').textContent === '0');

  step('host returns everyone to the lobby');
  await host.click('#btn-exit');
  await host.click('#btn-exit');
  await host.waitForSelector('#screen-lobby:not([hidden])');
  await guest.waitForSelector('#screen-lobby:not([hidden])', { timeout: 5000 });

  step('a CPU can be added for 2 v 1');
  await host.click('[data-bot="red"]');
  await guest.waitForFunction(() => document.querySelector('#list-red').textContent.includes('CPU 1'));

  step('guest leaves and the host sees it');
  await guest.click('#btn-leave-lobby');
  await host.waitForFunction(() => !document.querySelector('#list-blue').textContent.includes('Guesty'), null, {
    timeout: 15000,
  });

  step('joining a room that does not exist shows a helpful error');
  await guest.fill('#join-code', 'ZZZZZ');
  await guest.click('#join-form button');
  await guest.waitForSelector('#toast.show.error', { timeout: 30000 });
  assert.match(await guest.textContent('#toast'), /wasn't found/);

  step('someone joining mid-match watches as a spectator');
  await host.click('[data-bot="blue"]');
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])');
  await join(guest, link, 'Latecomer');
  await guest.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
  const role = await guest.evaluate(() => {
    const g = window.kickabout.game;
    return g.players.find((p) => p.id === g.myId).team;
  });
  assert.equal(role, 'spec');
  await guest.waitForFunction(() => window.kickabout.view && window.kickabout.view.players.length === 3);

  step('when the host closes the room, guests are told');
  await host.click('#btn-exit');
  await host.click('#btn-exit');
  await host.waitForSelector('#screen-lobby:not([hidden])');
  await guest.waitForSelector('#screen-lobby:not([hidden])', { timeout: 5000 });
  await host.click('#btn-leave-lobby');
  await guest.waitForSelector('#screen-menu:not([hidden])', { timeout: 10000 });
  assert.match(await guest.textContent('#toast'), /closed the room/);
}

async function scenarioBlocked(browser) {
  console.log('\nScenario 2: direct connection blocked (strict NAT / firewall)');
  const host = await openPage(browser, 'host');
  const guest = await openPage(browser, 'guest');
  const { link } = await createRoom(host, url(PEER_PORT));

  step('guest tries direct, then falls back to the relay');
  const joined = join(guest, link);
  await guest.waitForFunction(() => document.querySelector('#connecting-text').textContent.includes('relay'), null, {
    timeout: 15000,
  });
  await joined;
  assert.equal(await mode(guest), 'relay');
  await host.waitForFunction(() => document.querySelector('#list-blue').textContent.includes('Guesty'));

  await playMatch(host, guest, 'relay');
  await guest.waitForFunction(() => /relay/.test(document.querySelector('#hud-ping').textContent), null, {
    timeout: 5000,
  });

  step('guest leaves from the full-time screen and the host sees it at once');
  await guest.click('#btn-leave-end');
  await guest.waitForSelector('#screen-menu:not([hidden])');
  await host.waitForFunction(() => window.kickabout.game.players.length === 1, null, { timeout: 5000 });
  await host.click('#btn-exit');
  await host.waitForSelector('#screen-lobby:not([hidden])');
  await host.click('#btn-leave-lobby');
}

async function scenarioNoSignalling(browser) {
  console.log('\nScenario 3: matchmaking server unreachable');
  const host = await openPage(browser, 'host', { serverDown: true });
  const guest = await openPage(browser, 'guest', { serverDown: true });
  const { link } = await createRoom(host, url(PEER_PORT + 1)); // nothing listens there

  step('host is warned that only relayed joins will work');
  assert.equal(await host.isVisible('#lobby-net'), true);
  assert.match(await host.textContent('#lobby-net'), /through the relay/);

  step('guest still gets in through the relay');
  await join(guest, link);
  assert.equal(await mode(guest), 'relay');
  await playMatch(host, guest, 'no-signal');
}

try {
  // Same-machine WebRTC: don't hide host candidates behind mDNS names.
  const normal = await launch(['--disable-features=WebRtcHideLocalIpsWithMdns']);
  // No UDP without a proxy: WebRTC can't connect at all, like behind a strict firewall.
  const blocked = await launch(['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);

  await scenarioDirect(normal);
  await scenarioBlocked(blocked);
  await scenarioNoSignalling(normal);

  assert.deepEqual(errors, [], 'no errors in the browser consoles');
  console.log('\n✅ online e2e passed');
} catch (err) {
  console.error('\n❌ online e2e failed:', err);
  if (errors.length) console.error('Browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  for (const b of browsers) await b.close();
  web.kill();
  signal.close?.();
  await broker.close();
  setTimeout(() => process.exit(), 100);
}
