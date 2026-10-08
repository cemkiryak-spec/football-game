// The authoritative match simulation: physics, kick-offs, goals and the clock.
// Pure data in, pure data out — no DOM — so it runs the same in the browser
// (local play / online host) and in Node (tests).

import {
  TICK_RATE,
  FIELD,
  PLAYER,
  BALL,
  STAMINA,
  WALL_BOUNCE,
  PLAYER_WALL_BOUNCE,
  GOAL_PAUSE_TICKS,
} from './constants.js';

export const otherTeam = (team) => (team === 'red' ? 'blue' : 'red');

/** The side of the pitch a team defends: red the left goal (-1), blue the right (+1). */
export const teamSide = (team) => (team === 'red' ? -1 : 1);

// Kick-off positions as fractions of the half-pitch, measured from the centre
// towards the team's own goal. Indexed by team size.
const FORMATIONS = [
  [],
  [[0.55, 0]],
  [
    [0.45, -0.4],
    [0.45, 0.4],
  ],
  [
    [0.38, -0.5],
    [0.38, 0.5],
    [0.72, 0],
  ],
  [
    [0.32, -0.55],
    [0.32, 0.55],
    [0.55, 0],
    [0.85, 0],
  ],
];

export function spawnPoint(team, index, count) {
  const formation = FORMATIONS[Math.min(count, FORMATIONS.length - 1)];
  const [fx, fy] = formation[index] || [0.3 + 0.15 * (index % 4), ((index % 3) - 1) * 0.6];
  return { x: teamSide(team) * fx * FIELD.halfW, y: fy * FIELD.halfH };
}

export function createMatch({ timeLimit = 180, scoreLimit = 3 } = {}) {
  return {
    tick: 0,
    phase: 'kickoff', // kickoff | play | goal | over
    phaseTicks: 0,
    kickoffTeam: 'red',
    score: { red: 0, blue: 0 },
    elapsed: 0, // ticks of match time played
    overtime: false,
    paused: false,
    settings: { timeLimit, scoreLimit },
    ball: makeDisc(0, 0, BALL),
    players: [],
    lastTouch: null,
    goals: [],
    events: [{ e: 'start' }],
    winner: null,
    endAfterGoal: false,
  };
}

function makeDisc(x, y, spec) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    r: spec.radius,
    invMass: spec.invMass,
    damping: spec.damping,
    bCoef: spec.bCoef,
  };
}

export function addPlayer(match, { id, name, team }) {
  const p = Object.assign(makeDisc(0, 0, PLAYER), {
    id,
    name,
    team,
    input: { x: 0, y: 0, kick: false, sprint: false },
    kickPrev: false,
    kickArmed: false,
    stamina: 1,
    exhausted: false,
    sprinting: false,
  });
  match.players.push(p);
  const mates = match.players.filter((q) => q.team === team);
  Object.assign(p, spawnPoint(team, mates.length - 1, mates.length));
  return p;
}

export function removePlayer(match, id) {
  match.players = match.players.filter((p) => p.id !== id);
  if (match.lastTouch && match.lastTouch.id === id) match.lastTouch = null;
}

export function setInput(match, id, input) {
  const p = match.players.find((q) => q.id === id);
  if (p) p.input = input;
}

export function resetPositions(match) {
  const counts = { red: 0, blue: 0 };
  const sizes = { red: 0, blue: 0 };
  for (const p of match.players) sizes[p.team]++;
  for (const p of match.players) {
    Object.assign(p, spawnPoint(p.team, counts[p.team]++, sizes[p.team]));
    p.vx = p.vy = 0;
    p.kickArmed = false;
  }
  const b = match.ball;
  b.x = b.y = b.vx = b.vy = 0;
}

function setPhase(match, phase) {
  match.phase = phase;
  match.phaseTicks = 0;
}

function startKickoff(match, team) {
  setPhase(match, 'kickoff');
  match.kickoffTeam = team;
  match.lastTouch = null;
  resetPositions(match);
  match.events.push({ e: 'kickoff', team });
}

function endMatch(match) {
  setPhase(match, 'over');
  const { red, blue } = match.score;
  match.winner = red > blue ? 'red' : blue > red ? 'blue' : null;
  match.events.push({ e: 'end', winner: match.winner });
}

export function setPaused(match, paused) {
  if (match.phase === 'over' || match.paused === paused) return;
  match.paused = paused;
  match.events.push({ e: 'pause', on: paused });
}

/** Hand over (and clear) the events produced since the last call: kicks, goals, whistles. */
export function takeEvents(match) {
  const events = match.events;
  match.events = [];
  return events;
}

/** Advance the match by one tick. Events produced during the tick are queued in match.events. */
export function step(match) {
  // The tick counter keeps going while paused so every snapshot is unique.
  match.tick++;
  if (match.paused) return;
  match.phaseTicks++;

  const { ball, players } = match;

  for (const p of players) applyInput(match, p);

  for (const p of players) integrate(p);
  integrate(ball);

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < players.length; i++) {
      const a = players[i];
      for (let j = i + 1; j < players.length; j++) collideDiscs(a, players[j]);
      if (collideDiscs(a, ball)) match.lastTouch = { id: a.id, team: a.team, name: a.name };
    }
    for (const p of players) {
      collidePosts(p);
      collideNets(p);
      constrainPlayer(p);
      if (match.phase === 'kickoff') kickoffBarrier(match, p);
    }
    const postHit = collidePosts(ball);
    const netHit = constrainBall(ball);
    if (pass === 0) {
      if (postHit > 1) match.events.push({ e: 'post', v: round2(postHit) });
      if (netHit > 0.8) match.events.push({ e: 'net', v: round2(netHit) });
    }
  }

  updateRules(match);
}

function updateRules(match) {
  const { ball } = match;

  if (match.phase === 'kickoff') {
    const kickersPresent = match.players.some((p) => p.team === match.kickoffTeam);
    if (!kickersPresent || ball.vx !== 0 || ball.vy !== 0) setPhase(match, 'play');
  }

  if (match.phase === 'play') {
    const scorer = goalScoredBy(ball);
    if (scorer) onGoal(match, scorer);
  }

  if (match.phase === 'play' || match.phase === 'kickoff') {
    match.elapsed++;
    const limit = match.settings.timeLimit * TICK_RATE;
    if (limit > 0 && !match.overtime && match.elapsed >= limit) {
      if (match.score.red === match.score.blue) {
        match.overtime = true;
        match.events.push({ e: 'overtime' });
      } else {
        endMatch(match);
      }
    }
  }

  if (match.phase === 'goal' && match.phaseTicks >= GOAL_PAUSE_TICKS) {
    if (match.endAfterGoal) endMatch(match);
    else startKickoff(match, match.kickoffTeam);
  }
}

/** Returns the team that scored if the ball is completely over a goal line, between the posts. */
export function goalScoredBy(ball) {
  if (Math.abs(ball.y) >= FIELD.goalHalfW) return null;
  if (ball.x > FIELD.halfW + ball.r) return 'red';
  if (ball.x < -FIELD.halfW - ball.r) return 'blue';
  return null;
}

function onGoal(match, team) {
  match.score[team]++;
  const touch = match.lastTouch;
  const goal = {
    team,
    id: touch ? touch.id : null,
    name: touch ? touch.name : null,
    own: !!touch && touch.team !== team,
    t: match.elapsed,
  };
  match.goals.push(goal);
  match.events.push({ e: 'goal', ...goal });
  setPhase(match, 'goal');
  match.kickoffTeam = otherTeam(team);
  const limit = match.settings.scoreLimit;
  if ((limit > 0 && match.score[team] >= limit) || match.overtime) match.endAfterGoal = true;
}

function applyInput(match, p) {
  const input = p.input;
  let ix = input.x || 0;
  let iy = input.y || 0;
  const len = Math.hypot(ix, iy);
  if (len > 1) {
    ix /= len;
    iy /= len;
  }

  let accel = PLAYER.accel;
  const wantsSprint = input.sprint && len > 0.1 && !input.kick && !p.exhausted;
  if (wantsSprint) {
    accel = PLAYER.sprintAccel;
    p.sprinting = true;
    p.stamina -= STAMINA.drain;
    if (p.stamina <= 0) {
      p.stamina = 0;
      p.exhausted = true;
    }
  } else {
    p.sprinting = false;
    p.stamina = Math.min(1, p.stamina + STAMINA.regen);
    if (p.exhausted && p.stamina >= STAMINA.recoverAt) p.exhausted = false;
  }
  if (input.kick) accel = PLAYER.kickingAccel;

  p.vx += ix * accel;
  p.vy += iy * accel;

  // Kicking: pressing the button arms a kick that fires the moment the ball is
  // in reach. To kick again you have to release and press again.
  if (input.kick && !p.kickPrev) p.kickArmed = true;
  if (!input.kick) p.kickArmed = false;
  p.kickPrev = !!input.kick;

  if (p.kickArmed) {
    const ball = match.ball;
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist - p.r - ball.r < PLAYER.kickReach && dist > 0) {
      const k = PLAYER.kickStrength * ball.invMass;
      ball.vx += (dx / dist) * k;
      ball.vy += (dy / dist) * k;
      p.kickArmed = false;
      match.lastTouch = { id: p.id, team: p.team, name: p.name };
      match.events.push({ e: 'kick', id: p.id });
    }
  }
}

function integrate(d) {
  d.x += d.vx;
  d.y += d.vy;
  d.vx *= d.damping;
  d.vy *= d.damping;
}

/** Elastic-ish collision between two moving discs. Returns true if they touched. */
export function collideDiscs(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return false;
  const dist = Math.sqrt(d2);
  const nx = dist > 1e-9 ? dx / dist : 1;
  const ny = dist > 1e-9 ? dy / dist : 0;
  const massA = a.invMass / (a.invMass + b.invMass);
  const pen = rr - dist;
  a.x += nx * pen * massA;
  a.y += ny * pen * massA;
  b.x -= nx * pen * (1 - massA);
  b.y -= ny * pen * (1 - massA);
  const rv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (rv < 0) {
    const j = rv * (1 + a.bCoef * b.bCoef);
    a.vx -= nx * j * massA;
    a.vy -= ny * j * massA;
    b.vx += nx * j * (1 - massA);
    b.vy += ny * j * (1 - massA);
  }
  return true;
}

/** Push a disc out of a static point/circle. Returns the impact speed (0 if none). */
function collidePoint(d, px, py, pr, bCoef) {
  const dx = d.x - px;
  const dy = d.y - py;
  const rr = d.r + pr;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return 0;
  const dist = Math.sqrt(d2);
  const nx = dist > 1e-9 ? dx / dist : 1;
  const ny = dist > 1e-9 ? dy / dist : 0;
  d.x = px + nx * rr;
  d.y = py + ny * rr;
  const vn = d.vx * nx + d.vy * ny;
  if (vn >= 0) return 0;
  d.vx -= (1 + bCoef) * vn * nx;
  d.vy -= (1 + bCoef) * vn * ny;
  return -vn;
}

function collideSegment(d, x1, y1, x2, y2, bCoef) {
  const sx = x2 - x1;
  const sy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((d.x - x1) * sx + (d.y - y1) * sy) / (sx * sx + sy * sy)));
  return collidePoint(d, x1 + sx * t, y1 + sy * t, 0, bCoef);
}

function collidePosts(d) {
  let hit = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const v = collidePoint(d, sx * FIELD.halfW, sy * FIELD.goalHalfW, FIELD.postR, d.bCoef * 0.5);
      hit = Math.max(hit, v);
    }
  }
  return hit;
}

/** Players can step into the goal mouth but not through the side or back netting. */
function collideNets(d) {
  const { halfW, goalHalfW, goalDepth } = FIELD;
  const back = halfW + goalDepth;
  for (const sx of [-1, 1]) {
    if (Math.abs(d.x) < halfW - d.r) continue;
    collideSegment(d, sx * halfW, -goalHalfW, sx * back, -goalHalfW, 0);
    collideSegment(d, sx * halfW, goalHalfW, sx * back, goalHalfW, 0);
    collideSegment(d, sx * back, -goalHalfW, sx * back, goalHalfW, 0);
  }
}

function constrainPlayer(p) {
  const maxX = FIELD.halfW + FIELD.margin - p.r;
  const maxY = FIELD.halfH + FIELD.margin - p.r;
  if (p.x > maxX) {
    p.x = maxX;
    if (p.vx > 0) p.vx = -p.vx * PLAYER_WALL_BOUNCE;
  } else if (p.x < -maxX) {
    p.x = -maxX;
    if (p.vx < 0) p.vx = -p.vx * PLAYER_WALL_BOUNCE;
  }
  if (p.y > maxY) {
    p.y = maxY;
    if (p.vy > 0) p.vy = -p.vy * PLAYER_WALL_BOUNCE;
  } else if (p.y < -maxY) {
    p.y = -maxY;
    if (p.vy < 0) p.vy = -p.vy * PLAYER_WALL_BOUNCE;
  }
}

/**
 * The ball bounces off the touchlines and the goal lines, except between the
 * posts, where it can roll into the net. Uses half-spaces rather than thin
 * segments so a fast ball can never tunnel out of the pitch.
 * Returns the speed with which it hit the back of a net (for sound).
 */
function constrainBall(b) {
  const { halfW, halfH, goalHalfW, goalDepth } = FIELD;
  const bounce = b.bCoef * WALL_BOUNCE;
  let netHit = 0;
  const sx = b.x < 0 ? -1 : 1;

  if (Math.abs(b.y) > goalHalfW) {
    // Beside the goal: goal line and touchline.
    const maxX = halfW - b.r;
    if (Math.abs(b.x) > maxX) {
      b.x = sx * maxX;
      if (b.vx * sx > 0) b.vx = -b.vx * bounce;
    }
  } else if (Math.abs(b.x) > halfW) {
    // Inside a goal: side netting and back of the net (soft).
    const maxY = goalHalfW - b.r;
    if (Math.abs(b.y) > maxY) {
      const sy = b.y < 0 ? -1 : 1;
      b.y = sy * maxY;
      if (b.vy * sy > 0) b.vy = -b.vy * 0.3;
    }
    const maxX = halfW + goalDepth - b.r;
    if (Math.abs(b.x) > maxX) {
      b.x = sx * maxX;
      if (b.vx * sx > 0) {
        netHit = Math.abs(b.vx);
        b.vx = -b.vx * 0.15;
        b.vy *= 0.6;
      }
    }
  }

  const maxY = halfH - b.r;
  if (Math.abs(b.y) > maxY) {
    const sy = b.y < 0 ? -1 : 1;
    b.y = sy * maxY;
    if (b.vy * sy > 0) b.vy = -b.vy * bounce;
  }
  return netHit;
}

/**
 * At kick-off everyone stays in their own half. The kicking team may step into
 * the centre circle; the other team has to stay outside it.
 */
function kickoffBarrier(match, p) {
  const side = teamSide(p.team);
  const R = FIELD.centerR;
  const own = p.x * side; // > 0 when in own half
  const dist = Math.hypot(p.x, p.y);

  if (p.team === match.kickoffTeam) {
    if (own < 0 && dist > R) {
      // Snap to whichever allowed edge is closer: the halfway line or the circle.
      if (-own <= dist - R) {
        p.x = 0;
        if (p.vx * side < 0) p.vx = 0;
      } else {
        const nx = p.x / dist;
        const ny = p.y / dist;
        p.x = nx * R;
        p.y = ny * R;
        const vn = p.vx * nx + p.vy * ny;
        if (vn > 0) {
          p.vx -= vn * nx;
          p.vy -= vn * ny;
        }
      }
    }
    return;
  }

  if (own < p.r) {
    p.x = side * p.r;
    if (p.vx * side < 0) p.vx = 0;
  }
  const minDist = R + p.r;
  const d = Math.hypot(p.x, p.y);
  if (d < minDist) {
    const nx = d > 1e-9 ? p.x / d : side;
    const ny = d > 1e-9 ? p.y / d : 0;
    p.x = nx * minDist;
    p.y = ny * minDist;
    const vn = p.vx * nx + p.vy * ny;
    if (vn < 0) {
      p.vx -= vn * nx;
      p.vy -= vn * ny;
    }
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
