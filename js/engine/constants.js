// Shared tuning values for the simulation. Everything is in "pitch units"
// (roughly pixels at 1x zoom) and per-tick quantities at a fixed 60 Hz.

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;

export const FIELD = {
  halfW: 420, // x of each goal line
  halfH: 200, // y of each touchline
  goalHalfW: 64, // half the width of the goal mouth
  goalDepth: 36,
  margin: 36, // how far players may run beyond the lines
  centerR: 70, // centre circle radius (also the kick-off barrier)
  postR: 6,
};

export const PLAYER = {
  radius: 15,
  invMass: 0.5,
  damping: 0.96,
  bCoef: 0.5,
  accel: 0.1, // top speed = accel * damping / (1 - damping) = 2.4 units/tick
  kickingAccel: 0.07, // you move slower while holding kick
  sprintAccel: 0.135,
  kickStrength: 5.4,
  kickReach: 4, // gap between player and ball that still counts as touching
};

export const BALL = {
  radius: 10,
  invMass: 1,
  damping: 0.99,
  bCoef: 0.5,
};

export const STAMINA = {
  drain: 1 / 150, // ~2.5 s of sprinting from full
  regen: 1 / 330, // ~5.5 s to refill
  recoverAt: 0.3, // once empty, sprint unlocks again at this level
};

export const WALL_BOUNCE = 1; // multiplied with a disc's bCoef
export const PLAYER_WALL_BOUNCE = 0.3;

export const GOAL_PAUSE_TICKS = Math.round(2.6 * TICK_RATE);

export const MAX_PER_TEAM = 4;

export const TEAMS = ['red', 'blue'];
