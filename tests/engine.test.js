import test from 'node:test';
import assert from 'node:assert/strict';

import { FIELD, TICK_RATE, GOAL_PAUSE_TICKS, PLAYER } from '../js/engine/constants.js';
import {
  createMatch,
  addPlayer,
  removePlayer,
  setInput,
  setPaused,
  step,
  takeEvents,
  goalScoredBy,
} from '../js/engine/match.js';
import { createBot, botInput } from '../js/engine/bot.js';
import { encodeSnapshot, decodeSnapshot, lerpView } from '../js/engine/snapshot.js';

function twoPlayerMatch(settings) {
  const m = createMatch(settings);
  addPlayer(m, { id: 1, name: 'Ann', team: 'red' });
  addPlayer(m, { id: 2, name: 'Bob', team: 'blue' });
  return m;
}

function run(m, ticks) {
  const events = [];
  for (let i = 0; i < ticks; i++) {
    step(m);
    events.push(...takeEvents(m));
  }
  return events;
}

const player = (m, id) => m.players.find((p) => p.id === id);

/** Small seeded PRNG so bot tests are repeatable. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('players start in their own halves, ball in the centre', () => {
  const m = twoPlayerMatch();
  assert.ok(player(m, 1).x < 0);
  assert.ok(player(m, 2).x > 0);
  assert.equal(m.ball.x, 0);
  assert.equal(m.phase, 'kickoff');
  assert.deepEqual(takeEvents(m), [{ e: 'start' }]);
});

test('holding a direction accelerates up to a capped top speed', () => {
  const m = twoPlayerMatch();
  setInput(m, 1, { x: 0, y: 1, kick: false, sprint: false });
  run(m, 75); // not long enough to reach the touchline
  const p = player(m, 1);
  const speed = Math.hypot(p.vx, p.vy);
  assert.ok(speed > 2.2 && speed < 2.4, `speed ${speed}`);
});

test('sprinting is faster but drains stamina, which then recovers', () => {
  const m = twoPlayerMatch();
  setInput(m, 1, { x: 0, y: 1, kick: false, sprint: true });
  run(m, 40);
  const p = player(m, 1);
  assert.ok(Math.hypot(p.vx, p.vy) > 2.6);
  assert.ok(p.stamina < 1);
  run(m, 400);
  assert.equal(p.exhausted, true, 'runs out eventually');
  setInput(m, 1, { x: 0, y: 0, kick: false, sprint: false });
  run(m, 400);
  assert.equal(p.exhausted, false);
  assert.ok(p.stamina > 0.9);
});

test('kicking the ball needs a fresh press and sends it away from the kicker', () => {
  const m = twoPlayerMatch();
  const p = player(m, 1);
  p.x = -PLAYER.radius - m.ball.r - 1;
  p.y = 0;
  setInput(m, 1, { x: 0, y: 0, kick: true, sprint: false });
  const events = run(m, 1);
  assert.ok(events.some((e) => e.e === 'kick' && e.id === 1));
  assert.ok(m.ball.vx > 4, `ball vx ${m.ball.vx}`);
  assert.equal(m.phase, 'play');

  // Still holding kick: no second kick even if the ball is back in reach.
  m.ball.x = p.x + PLAYER.radius + m.ball.r + 1;
  m.ball.y = p.y;
  m.ball.vx = m.ball.vy = 0;
  assert.ok(!run(m, 1).some((e) => e.e === 'kick'));
  setInput(m, 1, { x: 0, y: 0, kick: false, sprint: false });
  run(m, 1);
  m.ball.x = p.x + PLAYER.radius + m.ball.r + 1;
  m.ball.vx = m.ball.vy = 0;
  setInput(m, 1, { x: 0, y: 0, kick: true, sprint: false });
  assert.ok(run(m, 1).some((e) => e.e === 'kick'));
});

test('a kick out of reach does nothing', () => {
  const m = twoPlayerMatch();
  setInput(m, 1, { x: 0, y: 0, kick: true, sprint: false });
  run(m, 5);
  assert.equal(m.ball.vx, 0);
  assert.equal(m.phase, 'kickoff');
});

test('ball bounces off the touchline and the goal line beside the goal', () => {
  const m = twoPlayerMatch();
  m.phase = 'play';
  m.ball.x = 0;
  m.ball.y = FIELD.halfH - 30;
  m.ball.vy = 8;
  run(m, 10);
  assert.ok(m.ball.vy < 0, 'reflected');
  assert.ok(m.ball.y <= FIELD.halfH - m.ball.r + 1e-9);

  m.ball.x = FIELD.halfW - 40;
  m.ball.y = FIELD.goalHalfW + 40;
  m.ball.vx = 9;
  m.ball.vy = 0;
  run(m, 10);
  assert.ok(m.ball.vx < 0, 'bounced back off goal line');
  assert.equal(m.score.red, 0);
});

test('a fast ball can never escape the pitch', () => {
  const m = twoPlayerMatch();
  m.phase = 'play';
  for (let i = 0; i < 300; i++) {
    const a = (i / 300) * Math.PI * 2;
    m.ball.x = Math.cos(a) * 100;
    m.ball.y = Math.sin(a) * 100;
    m.ball.vx = Math.cos(a) * 25;
    m.ball.vy = Math.sin(a) * 25;
    for (let t = 0; t < 60; t++) {
      step(m);
      assert.ok(Math.abs(m.ball.y) <= FIELD.halfH, 'inside touchlines');
      assert.ok(Math.abs(m.ball.x) <= FIELD.halfW + FIELD.goalDepth, 'inside goal depth');
      if (m.phase !== 'play') break;
    }
    takeEvents(m);
    m.phase = 'play';
  }
});

test('ball over the line between the posts is a goal, credited to the last toucher', () => {
  const m = twoPlayerMatch();
  m.phase = 'play';
  m.lastTouch = { id: 1, team: 'red', name: 'Ann' };
  m.ball.x = FIELD.halfW - 20;
  m.ball.y = 0;
  m.ball.vx = 6;
  const events = run(m, 20);
  const goal = events.find((e) => e.e === 'goal');
  assert.ok(goal);
  assert.equal(goal.team, 'red');
  assert.equal(goal.name, 'Ann');
  assert.equal(goal.own, false);
  assert.deepEqual(m.score, { red: 1, blue: 0 });
  assert.equal(m.phase, 'goal');
  assert.equal(m.kickoffTeam, 'blue');

  // After the celebration everybody is reset for the conceding team's kick-off.
  const later = run(m, GOAL_PAUSE_TICKS);
  assert.ok(later.some((e) => e.e === 'kickoff' && e.team === 'blue'));
  assert.equal(m.phase, 'kickoff');
  assert.equal(m.ball.x, 0);
});

test('own goals are flagged', () => {
  const m = twoPlayerMatch();
  m.phase = 'play';
  m.lastTouch = { id: 2, team: 'blue', name: 'Bob' };
  m.ball.x = FIELD.halfW - 15;
  m.ball.vx = 5;
  const goal = run(m, 20).find((e) => e.e === 'goal');
  assert.equal(goal.team, 'red');
  assert.equal(goal.own, true);
});

test('goal detection needs the whole ball over the line and between the posts', () => {
  assert.equal(goalScoredBy({ x: FIELD.halfW + 5, y: 0, r: 10 }), null);
  assert.equal(goalScoredBy({ x: FIELD.halfW + 11, y: 0, r: 10 }), 'red');
  assert.equal(goalScoredBy({ x: -FIELD.halfW - 11, y: 10, r: 10 }), 'blue');
  assert.equal(goalScoredBy({ x: FIELD.halfW + 11, y: FIELD.goalHalfW + 1, r: 10 }), null);
});

test('at kick-off the defending team cannot enter the centre circle or cross halfway', () => {
  const m = twoPlayerMatch();
  // Blue tries to run at the ball from the right.
  setInput(m, 2, { x: -1, y: 0, kick: false, sprint: false });
  run(m, 300);
  const blue = player(m, 2);
  assert.ok(Math.hypot(blue.x, blue.y) >= FIELD.centerR + blue.r - 1e-6);
  assert.equal(m.ball.vx, 0, 'ball untouched');
  assert.equal(m.phase, 'kickoff');

  // Red (kicking off) can walk into the ball.
  setInput(m, 1, { x: 1, y: 0, kick: false, sprint: false });
  run(m, 300);
  assert.equal(m.phase, 'play');
});

test('during kick-off the kicking team cannot run deep into the other half', () => {
  const m = twoPlayerMatch();
  const red = player(m, 1);
  red.y = -150; // away from the ball, so it isn't touched
  setInput(m, 1, { x: 1, y: 0, kick: false, sprint: false });
  run(m, 300);
  assert.ok(red.x <= 1e-6, `red.x ${red.x}`);
});

test('players stay inside the outer boundary and out of the back of the net', () => {
  const m = twoPlayerMatch();
  m.phase = 'play';
  const p = player(m, 1);
  setInput(m, 1, { x: -1, y: 0, kick: false, sprint: false });
  run(m, 600);
  assert.ok(p.x >= -(FIELD.halfW + FIELD.margin - p.r) - 1e-6);
  assert.ok(p.x >= -(FIELD.halfW + FIELD.goalDepth - p.r) - 1e-6);
  setInput(m, 1, { x: 0, y: -1, kick: false, sprint: false });
  run(m, 600);
  assert.ok(p.y >= -(FIELD.halfH + FIELD.margin - p.r) - 1e-6);
});

test('time up with a leader ends the match', () => {
  const m = twoPlayerMatch({ timeLimit: 1, scoreLimit: 0 });
  m.score.blue = 1;
  const events = run(m, TICK_RATE + 1);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'blue');
  assert.ok(events.some((e) => e.e === 'end' && e.winner === 'blue'));
});

test('time up when level goes to golden goal', () => {
  const m = twoPlayerMatch({ timeLimit: 1, scoreLimit: 0 });
  const events = run(m, TICK_RATE + 1);
  assert.equal(m.overtime, true);
  assert.notEqual(m.phase, 'over');
  assert.ok(events.some((e) => e.e === 'overtime'));

  m.phase = 'play';
  m.ball.x = -FIELD.halfW + 15;
  m.ball.vx = -5;
  run(m, 20 + GOAL_PAUSE_TICKS);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'blue');
});

test('reaching the score limit ends the match after the celebration', () => {
  const m = twoPlayerMatch({ timeLimit: 0, scoreLimit: 2 });
  m.score.red = 1;
  m.phase = 'play';
  m.ball.x = FIELD.halfW - 15;
  m.ball.vx = 5;
  run(m, 20);
  assert.equal(m.phase, 'goal');
  run(m, GOAL_PAUSE_TICKS);
  assert.equal(m.phase, 'over');
  assert.equal(m.winner, 'red');
});

test('the clock stops while paused and during goal celebrations', () => {
  const m = twoPlayerMatch();
  run(m, 10);
  assert.equal(m.elapsed, 10);
  setPaused(m, true);
  run(m, 10);
  assert.equal(m.elapsed, 10);
  setPaused(m, false);
  m.phase = 'play';
  m.ball.x = FIELD.halfW - 15;
  m.ball.vx = 5;
  run(m, 30);
  assert.equal(m.phase, 'goal');
  const at = m.elapsed;
  run(m, 30);
  assert.equal(m.elapsed, at);
});

test('players can leave mid-match', () => {
  const m = twoPlayerMatch();
  m.lastTouch = { id: 2, team: 'blue', name: 'Bob' };
  removePlayer(m, 2);
  assert.equal(m.players.length, 1);
  assert.equal(m.lastTouch, null);
  run(m, 5);
});

test('kick-off is skipped when the kicking team is empty', () => {
  const m = createMatch();
  addPlayer(m, { id: 2, name: 'Bob', team: 'blue' });
  run(m, 1);
  assert.equal(m.phase, 'play');
});

test('normal and hard bots score against an idle opponent', () => {
  for (const level of ['normal', 'hard']) {
    for (let seed = 1; seed <= 10; seed++) {
      const m = twoPlayerMatch({ timeLimit: 0, scoreLimit: 1 });
      const bot = createBot(level, seeded(seed));
      const me = player(m, 2);
      m.kickoffTeam = 'blue';
      let scored = false;
      for (let i = 0; i < TICK_RATE * 60 && !scored; i++) {
        setInput(m, 2, botInput(bot, m, me));
        step(m);
        scored = takeEvents(m).some((e) => e.e === 'goal' && e.team === 'blue');
      }
      assert.ok(scored, `${level} bot (seed ${seed}) should score within a minute`);
    }
  }
});

test('a bot finds its way out of a goal to reach the ball', () => {
  for (const [y, by] of [
    [40, 150],
    [-40, -150],
    [0, 170],
  ]) {
    const m = twoPlayerMatch({ timeLimit: 0, scoreLimit: 0 });
    m.phase = 'play';
    const me = player(m, 2);
    Object.assign(me, { x: FIELD.halfW + 20, y });
    Object.assign(m.ball, { x: FIELD.halfW - 50, y: by });
    const bot = createBot('hard', seeded(7));
    let touched = false;
    for (let i = 0; i < TICK_RATE * 5 && !touched; i++) {
      setInput(m, 2, botInput(bot, m, me));
      step(m);
      takeEvents(m);
      touched = !!m.lastTouch && m.lastTouch.id === 2;
    }
    assert.ok(touched, `bot starting in the goal at y=${y} reaches a ball at y=${by}`);
  }
});

test('bots on both teams keep the game moving without errors', () => {
  const m = createMatch({ timeLimit: 30, scoreLimit: 0 });
  const bots = new Map();
  for (let i = 0; i < 4; i++) {
    const p = addPlayer(m, { id: i + 1, name: `B${i}`, team: i % 2 ? 'blue' : 'red' });
    bots.set(p, createBot(['easy', 'normal', 'hard'][i % 3], seeded(i + 1)));
  }
  let kicks = 0;
  for (let i = 0; i < TICK_RATE * 40 && m.phase !== 'over'; i++) {
    for (const [p, b] of bots) p.input = botInput(b, m, p);
    step(m);
    kicks += takeEvents(m).filter((e) => e.e === 'kick').length;
    for (const p of m.players) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
  }
  assert.equal(m.phase, 'over');
  assert.ok(kicks > 5, `only ${kicks} kicks`);
});

test('snapshots round-trip and interpolate', () => {
  const m = twoPlayerMatch();
  setInput(m, 1, { x: 1, y: 0, kick: true, sprint: false });
  step(m);
  const a = decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(m, takeEvents(m)))));
  step(m);
  const b = decodeSnapshot(encodeSnapshot(m));
  assert.equal(a.players.length, 2);
  assert.equal(a.players[0].kicking, true);
  assert.equal(a.players[0].armed, true);
  assert.equal(a.kickoffTeam, 'red');
  const mid = lerpView(a, b, 0.5);
  const pa = a.players[0].x;
  const pb = b.players[0].x;
  assert.ok(Math.abs(mid.players[0].x - (pa + pb) / 2) < 0.02);
});
