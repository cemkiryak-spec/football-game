// Runs a match at a fixed tick rate in the browser (local games and the
// online host), and smooths incoming snapshots on online guests.

import { TICK_MS } from '../engine/constants.js';
import { step, takeEvents } from '../engine/match.js';
import { createBot, botInput } from '../engine/bot.js';
import { encodeSnapshot, decodeSnapshot, lerpView } from '../engine/snapshot.js';

/**
 * A background-tab-proof heartbeat. requestAnimationFrame stops when the
 * host's tab is hidden, which would freeze the game for everybody, so the
 * simulation is also driven from a worker timer (not throttled like main-thread timers).
 */
export function startHeartbeat(fn) {
  try {
    const src = 'setInterval(() => postMessage(0), 8);';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = fn;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(fn, 8);
    return () => clearInterval(id);
  }
}

export class Sim {
  /**
   * @param match       a match from engine/match.js
   * @param onSnapshot  called after every tick with (wireSnapshot) — used to broadcast
   */
  constructor(match, { onSnapshot } = {}) {
    this.match = match;
    this.onSnapshot = onSnapshot;
    this.controllers = new Map(); // player id -> () => input
    this.bots = new Map(); // player id -> bot brain
    this.last = performance.now();
    this.acc = 0;
    this.pendingEvents = takeEvents(match);
    const first = encodeSnapshot(match, this.pendingEvents);
    this.prev = this.curr = decodeSnapshot(first);
    if (onSnapshot) onSnapshot(first);
    this.stopHeartbeat = startHeartbeat(() => this.advance());
  }

  setController(id, fn) {
    this.controllers.set(id, fn);
  }

  addBot(id, level) {
    this.bots.set(id, createBot(level));
  }

  /** Run however many ticks are due. Safe to call as often as you like. */
  advance(now = performance.now()) {
    this.acc += now - this.last;
    this.last = now;
    // After a long stall (e.g. the laptop slept) don't fast-forward minutes of play.
    if (this.acc > 250) this.acc = TICK_MS;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.tick();
    }
  }

  tick() {
    const m = this.match;
    for (const p of m.players) {
      const ctl = this.controllers.get(p.id);
      const bot = this.bots.get(p.id);
      if (ctl) p.input = ctl();
      else if (bot) p.input = botInput(bot, m, p);
    }
    step(m);
    const events = takeEvents(m);
    const wire = encodeSnapshot(m, events);
    this.prev = this.curr;
    this.curr = decodeSnapshot(wire);
    this.pendingEvents.push(...events);
    if (this.onSnapshot) this.onSnapshot(wire);
  }

  view() {
    this.advance();
    return lerpView(this.prev, this.curr, this.acc / TICK_MS);
  }

  drainEvents() {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  stop() {
    this.stopHeartbeat();
  }
}

/**
 * Guest-side jitter buffer. Snapshots arrive in bursts and occasionally out of
 * order; we render slightly in the past and interpolate between the two
 * snapshots around that moment. Sounds/effects fire when the rendered time
 * reaches the tick they happened on, so they line up with what you see.
 */
export class SnapshotBuffer {
  constructor() {
    this.reset();
  }

  reset() {
    this.snaps = [];
    this.offset = null; // estimate of (local time - host tick time)
    this.lateness = 0;
    this.delay = 60;
    this.events = [];
    this.lastEventTick = -1;
    this.newest = null;
  }

  push(wire) {
    const now = performance.now();
    const view = decodeSnapshot(wire);
    const est = now - view.tick * TICK_MS;
    if (this.offset === null || est < this.offset) this.offset = est;
    else this.offset += (est - this.offset) * 0.002; // drift slowly with clock skew
    const late = est - this.offset;
    this.lateness = Math.max(late, this.lateness * 0.995);

    let i = this.snaps.length;
    while (i > 0 && this.snaps[i - 1].tick > view.tick) i--;
    if (i > 0 && this.snaps[i - 1].tick === view.tick) return;
    this.snaps.splice(i, 0, view);
    if (!this.newest || view.tick > this.newest.tick) this.newest = view;
    for (const e of view.events) {
      if (view.tick > this.lastEventTick) this.events.push({ tick: view.tick, e });
    }
    if (this.snaps.length > 240) this.snaps.splice(0, this.snaps.length - 240);
  }

  renderTick(now) {
    if (this.offset === null) return null;
    const target = Math.min(250, Math.max(TICK_MS * 1.5, this.lateness + TICK_MS));
    this.delay += (target - this.delay) * 0.05;
    return (now - this.offset - this.delay) / TICK_MS;
  }

  view(now = performance.now()) {
    if (!this.snaps.length) return null;
    const t = this.renderTick(now);
    const s = this.snaps;
    if (t <= s[0].tick) return s[0];
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i].tick <= t && t < s[i + 1].tick) {
        // Drop what we no longer need, but keep a little history.
        if (i > 4) s.splice(0, i - 4);
        const a = s[Math.min(i, 4)];
        const b = s[Math.min(i, 4) + 1];
        return lerpView(a, b, (t - a.tick) / (b.tick - a.tick));
      }
    }
    return s[s.length - 1];
  }

  drainEvents(now = performance.now()) {
    const t = this.renderTick(now);
    if (t === null) return [];
    const due = [];
    const keep = [];
    for (const item of this.events) (item.tick <= t ? due : keep).push(item);
    this.events = keep;
    for (const item of due) this.lastEventTick = Math.max(this.lastEventTick, item.tick);
    return due.map((d) => d.e);
  }

  latest() {
    return this.newest;
  }
}
