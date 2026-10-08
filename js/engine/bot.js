// A simple computer player. It reads the match state and produces the same
// kind of input a human would ({x, y, kick, sprint}), so bots obey exactly the
// same physics as everyone else.

import { FIELD, BALL, PLAYER } from './constants.js';
import { spawnPoint, teamSide } from './match.js';

// speed: fraction of top speed · lag: reaction delay in ticks ·
// kickAlign: how square behind the ball it must be before striking.
export const BOT_LEVELS = {
  easy: { speed: 0.62, lag: 14, kickAlign: 0.88, sprint: false },
  normal: { speed: 0.84, lag: 7, kickAlign: 0.93, sprint: true },
  hard: { speed: 1, lag: 2, kickAlign: 0.97, sprint: true },
};

export function createBot(level = 'normal', random = Math.random) {
  return {
    level: BOT_LEVELS[level] || BOT_LEVELS.normal,
    random,
    seen: [], // delayed copy of the ball: bots react with a little lag
    aimY: 0,
    aimUntil: 0,
    prevKick: false,
    last: null,
    stuck: 0,
    sidestep: 0,
    exit: null,
    stale: 0,
    scramble: 0,
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function botInput(bot, match, me) {
  const { level } = bot;
  bot.seen.push({ x: match.ball.x, y: match.ball.y, vx: match.ball.vx, vy: match.ball.vy });
  while (bot.seen.length > level.lag + 1) bot.seen.shift();
  const ball = bot.seen[0];

  if (match.phase === 'over' || match.phase === 'goal' || match.paused) return idle(bot, match, me);
  if (match.phase === 'kickoff' && match.kickoffTeam !== me.team) return idle(bot, match, me);

  const side = teamSide(me.team);
  const attack = -side;
  const reach = me.r + BALL.radius;

  // Only the team-mate closest to the ball chases it; the rest cover.
  const mates = match.players.filter((p) => p.team === me.team);
  const myDist = Math.hypot(me.x - ball.x, me.y - ball.y);
  const chaser = mates.every((p) => p === me || Math.hypot(p.x - ball.x, p.y - ball.y) >= myDist - 1);
  if (!chaser) {
    const tx = side * FIELD.halfW + (ball.x - side * FIELD.halfW) * 0.4;
    return steer(bot, me, tx, ball.y * 0.5, false, false);
  }

  // Lead the ball a little.
  const lead = clamp(myDist / 4, 0, 20);
  const bx = clamp(ball.x + ball.vx * lead, -FIELD.halfW + BALL.radius, FIELD.halfW - BALL.radius);
  const by = clamp(ball.y + ball.vy * lead, -FIELD.halfH + BALL.radius, FIELD.halfH - BALL.radius);

  if (match.tick >= bot.aimUntil) {
    bot.aimY = (bot.random() * 2 - 1) * FIELD.goalHalfW * 0.55;
    bot.aimUntil = match.tick + 120;
  }

  // From a tight angle by the byline a shot only finds the side netting, so
  // cut the ball back towards the penalty spot instead.
  const goalX = attack * FIELD.halfW;
  const toGoalX = Math.abs(goalX - bx);
  const steep = Math.abs(by) > FIELD.goalHalfW && toGoalX < (Math.abs(by) - FIELD.goalHalfW * 0.5) * 0.8;
  let ax = (steep ? goalX - attack * 90 : goalX) - bx;
  let ay = (steep ? 0 : bot.aimY) - by;
  const aLen = Math.hypot(ax, ay) || 1;
  ax /= aLen;
  ay /= aLen;

  const relX = me.x - bx;
  const relY = me.y - by;
  const along = relX * ax + relY * ay; // < 0 means we are behind the ball
  const lateral = relX * -ay + relY * ax;
  // The ball leaves along the line from us through it, so this is how close
  // to the aim a touch right now would send it (1 = dead on).
  const align = myDist > 0 ? -along / Math.hypot(relX, relY) : 0;

  let tx;
  let ty;
  let kick = false;
  let speed = 1;
  if (align > level.kickAlign) {
    // Square behind the ball: drive through it.
    tx = bx + ax * 40;
    ty = by + ay * 40;
    if (steep) {
      speed = 0.6; // a gentle cut-back, not a clearance
    } else {
      kick = myDist < reach + PLAYER.kickReach + 3 && (toGoalX < 380 || level.lag <= 2);
    }
  } else if (along < -reach * 0.3) {
    // Behind it but at an angle: get square first.
    tx = bx - ax * (reach + 8);
    ty = by - ay * (reach + 8);
  } else {
    // Wrong side of the ball: get round it on the side we're already on.
    // Step clear sideways first — brushing it on the way round is how own goals happen.
    const s = lateral >= 0 ? 1 : -1;
    const off = reach + 20;
    if (Math.abs(lateral) < reach + 8) {
      tx = bx + ax * Math.max(along, 0) - ay * s * off;
      ty = by + ay * Math.max(along, 0) + ax * s * off;
    } else {
      tx = bx - ax * off - ay * s * off;
      ty = by - ay * off + ax * s * off;
    }
  }

  // Scramble: if the ball is wedged against a post, or nothing has happened
  // for a while, just run straight at it to knock it loose.
  const nearPost = Math.abs(Math.abs(bx) - FIELD.halfW) < 22 && Math.abs(Math.abs(by) - FIELD.goalHalfW) < 22;
  bot.stale = Math.hypot(ball.vx, ball.vy) < 0.05 ? bot.stale + 1 : 0;
  if (bot.stale > 180) {
    bot.stale = 0;
    bot.scramble = 60;
  }
  if (bot.scramble > 0) bot.scramble--;
  if (nearPost || bot.scramble > 0) {
    tx = bx;
    ty = by;
    speed = 1;
  }

  // Clear it if it's loose near our own goal and we're facing away from it.
  const inDanger = Math.abs(ball.x - side * FIELD.halfW) < 160;
  if (inDanger && myDist < reach + PLAYER.kickReach + 4 && (ball.x - me.x) * attack > 0) kick = true;

  const sprint = level.sprint && myDist > 140 && me.stamina > 0.5;
  return steer(bot, me, tx, ty, kick, sprint, speed);
}

function idle(bot, match, me) {
  const mates = match.players.filter((p) => p.team === me.team);
  const home = spawnPoint(me.team, mates.indexOf(me), mates.length);
  return steer(bot, me, home.x, home.y, false, false);
}

/** Which side of a goal's netting a y-coordinate is on: above, between the posts, below. */
const netBand = (y) => (y < -FIELD.goalHalfW ? -1 : y > FIELD.goalHalfW ? 1 : 0);

/** If a goalpost sits on the straight line to the target, aim to pass beside it instead. */
function avoidPosts(me, tx, ty) {
  const clear = me.r + FIELD.postR + 3;
  const dx = tx - me.x;
  const dy = ty - me.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return [tx, ty];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = sx * FIELD.halfW;
      const py = sy * FIELD.goalHalfW;
      const t = ((px - me.x) * dx + (py - me.y) * dy) / len2;
      if (t <= 0 || t >= 0.9) continue;
      const cx = me.x + dx * t;
      const cy = me.y + dy * t;
      let nx = cx - px;
      let ny = cy - py;
      const d = Math.hypot(nx, ny);
      if (d >= clear) continue;
      if (d < 1e-6) [nx, ny] = [-dy, dx];
      const n = Math.hypot(nx, ny);
      return [px + (nx / n) * (clear + 6), py + (ny / n) * (clear + 6)];
    }
  }
  return [tx, ty];
}

function steer(bot, me, tx, ty, wantKick, sprint, speed = 1) {
  // Behind a goal line the netting is in the way of anything on the other
  // side of it: walk back out in front of the goal first.
  if (bot.exit && (Math.hypot(me.x - bot.exit.x, me.y - bot.exit.y) < 10 || netBand(me.y) === netBand(ty))) {
    bot.exit = null;
  }
  if (!bot.exit && Math.abs(me.x) > FIELD.halfW && netBand(me.y) !== netBand(ty)) {
    bot.exit = { x: Math.sign(me.x) * (FIELD.halfW - 40), y: me.y };
  }
  if (bot.exit) [tx, ty] = [bot.exit.x, bot.exit.y];
  else [tx, ty] = avoidPosts(me, tx, ty);

  let dx = tx - me.x;
  let dy = ty - me.y;
  const d = Math.hypot(dx, dy);
  // Ease off when arriving so we don't overshoot and jitter.
  const mag = d < 1 ? 0 : bot.level.speed * speed * Math.min(1, d / 18);

  // Last resort: if we're pushing but going nowhere, sidestep for a moment.
  const moved = bot.last ? Math.hypot(me.x - bot.last.x, me.y - bot.last.y) : 1;
  bot.last = { x: me.x, y: me.y };
  bot.stuck = mag > 0.3 && moved < 0.1 ? bot.stuck + 1 : Math.max(0, bot.stuck - 1);
  if (bot.stuck > 30) {
    bot.stuck = 0;
    bot.sidestep = 40;
  }
  if (bot.sidestep > 0) {
    bot.sidestep--;
    [dx, dy] = [-dy, dx];
  }
  // A kick only arms on a fresh press, so let go for a tick if a held kick was spent.
  const kick = wantKick && !(bot.prevKick && !me.kickArmed);
  bot.prevKick = kick;
  return { x: d ? (dx / d) * mag : 0, y: d ? (dy / d) * mag : 0, kick, sprint };
}
