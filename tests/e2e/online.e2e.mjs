// End-to-end check of online play: two real browsers (host + guest) connect
// through a local PeerJS signalling server and play a match.
//
//   npm install && npm run test:e2e
//
// Needs the dev dependencies (peer, playwright) and a Chromium that
// Playwright can launch.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PeerServer } from 'peer';
import { chromium } from 'playwright';

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
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({
  // Same-machine WebRTC: don't hide host candidates behind mDNS names.
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});

const errors = [];
async function openPage(label) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 720 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  return page;
}

const step = (msg) => console.log(`• ${msg}`);
const query = `?signal=127.0.0.1:${PEER_PORT}&secure=0&ice=none`;

try {
  const host = await openPage('host');
  const guest = await openPage('guest');

  step('host creates a room');
  await host.goto(`http://localhost:${WEB_PORT}/${query}`);
  await host.fill('#name', 'Hosty');
  await host.click('#btn-create');
  await host.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  const code = (await host.textContent('#room-code')).trim();
  const link = await host.inputValue('#invite-link');
  assert.match(code, /^[A-Z0-9]{5}$/);
  assert.ok(link.includes(`room=${code}`), link);
  step(`room ${code} is open`);

  step('guest opens the invite link and joins');
  await guest.goto(link);
  await guest.waitForSelector('#invite-banner:not([hidden])');
  await guest.fill('#name', 'Guesty');
  await guest.click('#btn-accept-invite');
  await guest.waitForSelector('#screen-lobby:not([hidden])', { timeout: 20000 });
  await host.waitForFunction(() => document.querySelector('#list-blue').textContent.includes('Guesty'));
  await guest.waitForFunction(() => document.querySelector('#list-red').textContent.includes('Hosty'));
  await host.screenshot({ path: `${shots}/lobby-host.png` });

  step('guest can switch teams, then goes back to blue');
  await guest.click('[data-join="spec"]');
  await host.waitForFunction(() => document.querySelector('#list-spec').textContent.includes('Guesty'));
  assert.equal(await host.isDisabled('#btn-start'), true, 'cannot start with an empty team');
  await guest.click('[data-join="blue"]');
  await host.waitForFunction(() => document.querySelector('#list-blue').textContent.includes('Guesty'));

  step('host changes the settings and starts the match');
  await host.selectOption('#lobby-score', '1');
  await guest.waitForFunction(() => document.querySelector('#lobby-score').value === '1');
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])');
  await guest.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });

  const hostState = () =>
    host.evaluate(() => {
      const m = window.kickabout.game.sim.match;
      return {
        tick: m.tick,
        phase: m.phase,
        paused: m.paused,
        score: { ...m.score },
        players: m.players.map((p) => ({ id: p.id, team: p.team, x: p.x, y: p.y })),
      };
    });
  const guestView = () =>
    guest.evaluate(() => {
      const v = window.kickabout.view;
      return v && { tick: v.tick, players: v.players.map((p) => ({ id: p.id, x: p.x, y: p.y })) };
    });

  await guest.waitForFunction(() => window.kickabout.view && window.kickabout.view.players.length === 2);
  const before = await hostState();
  const guestId = before.players.find((p) => p.team === 'blue').id;

  step('guest controls reach the host');
  await guest.keyboard.down('ArrowDown');
  await guest.waitForTimeout(700);
  await guest.keyboard.up('ArrowDown');
  const afterMove = await hostState();
  const gBefore = before.players.find((p) => p.id === guestId);
  const gAfter = afterMove.players.find((p) => p.id === guestId);
  assert.ok(gAfter.y - gBefore.y > 30, `guest moved down on the host (${gBefore.y} -> ${gAfter.y})`);

  step("host's simulation is mirrored on the guest");
  await guest.waitForTimeout(300);
  const [hs, gv] = [await hostState(), await guestView()];
  assert.ok(hs.tick - gv.tick < 30, `guest is close behind the host (host ${hs.tick}, guest ${gv.tick})`);
  const mirrored = gv.players.find((p) => p.id === guestId);
  const truth = hs.players.find((p) => p.id === guestId);
  assert.ok(Math.abs(mirrored.y - truth.y) < 20, 'guest sees itself where the host has it');

  step('host kicks off and the match goes live');
  await host.keyboard.down('KeyD');
  await host.waitForFunction(() => window.kickabout.game.sim.match.phase === 'play', null, { timeout: 8000 });
  await host.keyboard.up('KeyD');

  step('pause from the guest pauses everyone');
  await guest.keyboard.press('KeyP');
  await host.waitForFunction(() => window.kickabout.game.sim.match.paused);
  await guest.waitForSelector('#paused:not([hidden])');
  await host.screenshot({ path: `${shots}/paused-host.png` });
  await host.keyboard.press('KeyP');
  await host.waitForFunction(() => !window.kickabout.game.sim.match.paused);
  await guest.waitForSelector('#paused', { state: 'hidden' });

  step('a goal is scored and the match ends (first to 1)');
  await host.evaluate(() => {
    const m = window.kickabout.game.sim.match;
    m.ball.x = 400;
    m.ball.y = 0;
    m.ball.vx = 6;
    m.ball.vy = 0;
  });
  await host.waitForFunction(() => window.kickabout.game.sim.match.score.red === 1);
  await guest.waitForFunction(() => document.querySelector('#hud-red').textContent === '1', null, { timeout: 5000 });
  await guest.waitForSelector('#end-panel:not([hidden])', { timeout: 8000 });
  await guest.screenshot({ path: `${shots}/fulltime-guest.png` });
  assert.match(await guest.textContent('#end-title'), /Hosty wins/);
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
  await guest.waitForSelector('#toast.show.error', { timeout: 20000 });
  assert.match(await guest.textContent('#toast'), /wasn't found/);

  step('someone joining mid-match watches as a spectator');
  await host.click('[data-bot="blue"]');
  await host.click('#btn-start');
  await host.waitForSelector('#screen-game:not([hidden])');
  await guest.goto(link);
  await guest.fill('#name', 'Latecomer');
  await guest.click('#btn-accept-invite');
  await guest.waitForSelector('#screen-game:not([hidden])', { timeout: 20000 });
  const role = await guest.evaluate(() => {
    const g = window.kickabout.game;
    return g.players.find((p) => p.id === g.myId).team;
  });
  assert.equal(role, 'spec');
  await guest.waitForFunction(() => window.kickabout.view && window.kickabout.view.players.length === 3);
  await guest.screenshot({ path: `${shots}/spectator.png` });

  step('when the host closes the room, guests are told');
  await host.click('#btn-exit');
  await host.click('#btn-exit');
  await host.waitForSelector('#screen-lobby:not([hidden])');
  await guest.waitForSelector('#screen-lobby:not([hidden])', { timeout: 5000 });
  await host.click('#btn-leave-lobby');
  await guest.waitForSelector('#screen-menu:not([hidden])', { timeout: 10000 });
  assert.match(await guest.textContent('#toast'), /closed the room/);

  assert.deepEqual(errors, [], 'no errors in the browser consoles');
  console.log('\n✅ online e2e passed');
} catch (err) {
  console.error('\n❌ online e2e failed:', err);
  if (errors.length) console.error('Browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  web.kill();
  signal.close?.();
  setTimeout(() => process.exit(), 100);
}
