// Compact, JSON-friendly snapshots of a match. The host sends one per tick to
// every guest; locally the same format feeds the renderer, so local, host and
// guest all draw from identical data.

const r2 = (v) => Math.round(v * 100) / 100;

const FLAG_ARMED = 1;
const FLAG_KICK = 2;
const FLAG_SPRINT = 4;
const FLAG_TIRED = 8;

export function encodeSnapshot(match, events = []) {
  const s = {
    k: match.tick,
    ph: match.phase,
    pt: match.phaseTicks,
    ko: match.kickoffTeam === 'red' ? 0 : 1,
    sc: [match.score.red, match.score.blue],
    el: match.elapsed,
    ot: match.overtime ? 1 : 0,
    pa: match.paused ? 1 : 0,
    tl: match.settings.timeLimit,
    sl: match.settings.scoreLimit,
    b: [r2(match.ball.x), r2(match.ball.y)],
    p: match.players.map((p) => [
      p.id,
      p.team === 'red' ? 0 : 1,
      r2(p.x),
      r2(p.y),
      (p.kickArmed ? FLAG_ARMED : 0) |
        (p.input.kick ? FLAG_KICK : 0) |
        (p.sprinting ? FLAG_SPRINT : 0) |
        (p.exhausted ? FLAG_TIRED : 0),
      Math.round(p.stamina * 100),
    ]),
  };
  if (events.length) s.ev = events;
  if (match.phase === 'over') {
    s.w = match.winner;
    s.gl = match.goals;
  }
  return s;
}

const team = (n) => (n === 0 ? 'red' : 'blue');

/** Turn a wire snapshot into the "view" object the renderer and HUD read. */
export function decodeSnapshot(s) {
  return {
    tick: s.k,
    phase: s.ph,
    phaseTicks: s.pt,
    kickoffTeam: team(s.ko),
    score: { red: s.sc[0], blue: s.sc[1] },
    elapsed: s.el,
    overtime: !!s.ot,
    paused: !!s.pa,
    timeLimit: s.tl,
    scoreLimit: s.sl,
    ball: { x: s.b[0], y: s.b[1] },
    players: s.p.map(([id, t, x, y, flags, stamina]) => ({
      id,
      team: team(t),
      x,
      y,
      armed: !!(flags & FLAG_ARMED),
      kicking: !!(flags & FLAG_KICK),
      sprinting: !!(flags & FLAG_SPRINT),
      tired: !!(flags & FLAG_TIRED),
      stamina: stamina / 100,
    })),
    events: s.ev || [],
    winner: s.w || null,
    goals: s.gl || [],
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Blend two views for smooth rendering between ticks. Non-positional data comes from `a`. */
export function lerpView(a, b, t) {
  if (!b || t <= 0) return a;
  // A kick-off reset teleports everyone; don't draw them sliding across the pitch.
  if (b.phase === 'kickoff' && a.phase !== 'kickoff') return a;
  const prev = new Map(a.players.map((p) => [p.id, p]));
  return {
    ...a,
    ball: { x: lerp(a.ball.x, b.ball.x, t), y: lerp(a.ball.y, b.ball.y, t) },
    players: b.players.map((pb) => {
      const pa = prev.get(pb.id);
      if (!pa) return pb;
      return { ...pa, x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t) };
    }),
  };
}
