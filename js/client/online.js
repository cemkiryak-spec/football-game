// Online rooms. The host's browser runs the one true simulation; guests send
// their controls and draw what the host broadcasts.
//
// Messages (all JSON):
//   guest → host  hello {name, v} · in {q, x, y, k, s, kc} · team {team} · pause · ping {ts, rtt}
//   host → guest  welcome {id} · room {...} · s {m, s: snapshot} · pong {ts} · bye {reason}
//
// Guests are either connected directly (WebRTC) or through the relay; relayed
// guests get snapshots at 30 Hz instead of 60 to go easy on the brokers.

import { MAX_PER_TEAM } from '../engine/constants.js';
import { createMatch, addPlayer, removePlayer, setPaused } from '../engine/match.js';
import { HostLink, GuestLink, PROTOCOL_VERSION } from './net.js';
import { Sim, SnapshotBuffer } from './sim.js';

const MAX_PEOPLE = 10;
const TIMEOUT_MS = 10000;
const IDLE = Object.freeze({ x: 0, y: 0, kick: false, sprint: false });

export function cleanName(raw, fallback = 'Player') {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16);
  return name || fallback;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

const BYE_REASONS = {
  'host-left': 'The host closed the room.',
  full: 'That room is full.',
  version: 'The host is running a different version of the game. Both of you should reload the page.',
};

function teamCounts(players) {
  const c = { red: 0, blue: 0, spec: 0 };
  for (const p of players) c[p.team]++;
  return c;
}

export class HostRoom {
  constructor({ name, settings, onUpdate, onError }) {
    this.role = 'host';
    this.myId = 1;
    this.nextId = 2;
    this.players = [{ id: 1, name: cleanName(name), team: 'red', host: true, ping: null }];
    this.settings = { ...settings };
    this.inMatch = false;
    this.matchId = 0;
    this.sim = null;
    this.peers = new Map(); // id -> { conn, lastSeen, seq, kc, input, tap }
    this.rv = 0;
    this.pingDirty = false;
    this.onUpdate = onUpdate;
    this.localInput = () => IDLE;
    this.link = new HostLink({ onConnection: (conn) => this.accept(conn), onError });
  }

  async open() {
    this.code = await this.link.open();
    this.watchdog = setInterval(() => this.housekeeping(), 2000);
    return this.code;
  }

  accept(conn) {
    let id = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (id !== null) {
        this.handle(id, msg);
        return;
      }
      if (msg.t !== 'hello') return;
      if (msg.v !== PROTOCOL_VERSION) return this.refuse(conn, 'version');
      if (this.players.filter((p) => !p.bot).length >= MAX_PEOPLE) return this.refuse(conn, 'full');
      id = this.nextId++;
      const team = this.inMatch ? 'spec' : this.balancedTeam();
      const relay = !!conn.relay;
      this.players.push({ id, name: cleanName(msg.name, `Player ${id}`), team, ping: null, relay });
      this.peers.set(id, { conn, lastSeen: performance.now(), seq: -1, kc: 0, input: IDLE, tap: false });
      conn.send({ t: 'welcome', id, code: this.code });
      this.changed();
      // A relayed guest only starts listening to room-wide messages once welcomed.
      if (relay) conn.send({ t: 'room', ...this.roomState() });
    });
    const gone = () => {
      if (id !== null) this.drop(id);
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  refuse(conn, reason) {
    conn.send({ t: 'bye', reason });
    setTimeout(() => conn.close(), 300);
  }

  handle(id, msg) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.lastSeen = performance.now();
    switch (msg.t) {
      case 'in':
        if (typeof msg.q === 'number' && msg.q > peer.seq) {
          peer.seq = msg.q;
          peer.input = { x: num(msg.x), y: num(msg.y), kick: !!msg.k, sprint: !!msg.s };
          // A press shorter than one tick would otherwise be missed entirely.
          if (typeof msg.kc === 'number' && msg.kc > peer.kc) {
            peer.kc = msg.kc;
            peer.tap = true;
          }
        }
        break;
      case 'team':
        if (['red', 'blue', 'spec'].includes(msg.team)) this.setTeam(id, msg.team);
        break;
      case 'pause':
        this.togglePause();
        break;
      case 'ping': {
        peer.conn.send({ t: 'pong', ts: msg.ts });
        const p = this.players.find((q) => q.id === id);
        if (p && typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) {
          const rtt = Math.round(msg.rtt);
          if (p.ping === null || Math.abs(p.ping - rtt) >= 5) this.pingDirty = true;
          p.ping = rtt;
        }
        break;
      }
      default:
    }
  }

  housekeeping() {
    const now = performance.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > TIMEOUT_MS) {
        peer.conn.close();
        this.drop(id);
      }
    }
    // Refresh pings shown in the lobby.
    if (!this.inMatch && this.pingDirty) {
      this.pingDirty = false;
      this.changed();
    }
    // Relayed messages can occasionally get lost; repeat the room state.
    if (this.link.relay.guestCount) this.link.relay.broadcast({ t: 'room', ...this.roomState() });
  }

  drop(id) {
    if (!this.peers.has(id)) return;
    this.peers.delete(id);
    this.players = this.players.filter((p) => p.id !== id);
    if (this.sim) removePlayer(this.sim.match, id);
    this.changed();
  }

  balancedTeam() {
    const c = teamCounts(this.players);
    if (c.red >= MAX_PER_TEAM && c.blue >= MAX_PER_TEAM) return 'spec';
    return c.blue < c.red ? 'blue' : 'red';
  }

  setTeam(id, team) {
    if (this.inMatch) return;
    const p = this.players.find((q) => q.id === id);
    if (!p || p.team === team) return;
    if (team !== 'spec' && teamCounts(this.players)[team] >= MAX_PER_TEAM) return;
    p.team = team;
    this.changed();
  }

  addBot(team) {
    if (this.inMatch || teamCounts(this.players)[team] >= MAX_PER_TEAM) return;
    const used = new Set(this.players.filter((p) => p.bot).map((p) => p.name));
    let n = 1;
    while (used.has(`CPU ${n}`)) n++;
    this.players.push({ id: this.nextId++, name: `CPU ${n}`, team, bot: true, ping: null });
    this.changed();
  }

  removeBot(id) {
    if (this.inMatch) return;
    this.players = this.players.filter((p) => !(p.bot && p.id === id));
    this.changed();
  }

  setSettings(patch) {
    if (this.inMatch) return;
    Object.assign(this.settings, patch);
    this.changed();
  }

  canStart() {
    const c = teamCounts(this.players);
    return c.red > 0 && c.blue > 0;
  }

  startMatch() {
    if (this.sim) this.sim.stop();
    const match = createMatch(this.settings);
    for (const p of this.players) {
      if (p.team !== 'spec') addPlayer(match, { id: p.id, name: p.name, team: p.team });
    }
    this.matchId++;
    this.inMatch = true;
    const matchId = this.matchId;
    this.relayEvents = [];
    this.sim = new Sim(match, { onSnapshot: (s) => this.sendSnapshot(matchId, s) });
    for (const p of this.players) {
      if (p.team === 'spec') continue;
      if (p.id === this.myId) this.sim.setController(p.id, () => this.localInput());
      else if (p.bot) this.sim.addBot(p.id, this.settings.botLevel);
      else this.sim.setController(p.id, () => this.remoteInput(p.id));
    }
    this.changed();
  }

  remoteInput(id) {
    const peer = this.peers.get(id);
    if (!peer) return IDLE;
    if (!peer.tap) return peer.input;
    peer.tap = false;
    return { ...peer.input, kick: true };
  }

  toLobby() {
    if (this.sim) this.sim.stop();
    this.sim = null;
    this.inMatch = false;
    this.changed();
  }

  togglePause() {
    if (this.sim) setPaused(this.sim.match, !this.sim.match.paused);
  }

  broadcast(msg) {
    this.sendDirect(msg);
    this.link.relay.broadcast(msg);
  }

  sendDirect(msg) {
    for (const peer of this.peers.values()) {
      if (peer.conn.relay) continue;
      try {
        if (peer.conn.open) peer.conn.send(msg);
      } catch {
        /* the close handler will clean up */
      }
    }
  }

  sendSnapshot(matchId, s) {
    this.sendDirect({ t: 's', m: matchId, s });
    if (!this.link.relay.guestCount) return;
    // Relayed guests: every other tick, carrying the events of the skipped one.
    if (s.ev) this.relayEvents.push(...s.ev);
    if (s.k % 2 !== 0) return;
    const events = this.relayEvents;
    this.relayEvents = [];
    const out = events.length ? { ...s, ev: events } : s;
    this.link.relay.broadcast({ t: 's', m: matchId, s: out }, { droppable: !events.length });
  }

  roomState() {
    return {
      rv: this.rv,
      code: this.code,
      players: this.players.map(({ id, name, team, host, bot, ping, relay }) => ({
        id,
        name,
        team,
        host,
        bot,
        ping,
        relay,
      })),
      settings: this.settings,
      inMatch: this.inMatch,
      matchId: this.matchId,
    };
  }

  changed() {
    this.rv++;
    this.broadcast({ t: 'room', ...this.roomState() });
    if (this.onUpdate) this.onUpdate();
  }

  view() {
    return this.sim ? this.sim.view() : null;
  }

  drainEvents() {
    return this.sim ? this.sim.drainEvents() : [];
  }

  leave() {
    clearInterval(this.watchdog);
    if (this.sim) this.sim.stop();
    this.broadcast({ t: 'bye', reason: 'host-left' });
    // Give the goodbye a moment to go out before tearing down.
    setTimeout(() => this.link.close(), 200);
  }
}

export class GuestRoom {
  constructor({ name, code, onUpdate, onClosed, onStatus }) {
    this.role = 'guest';
    this.onStatus = onStatus;
    this.name = cleanName(name);
    this.code = code;
    this.onUpdate = onUpdate;
    this.onClosed = onClosed;
    this.myId = null;
    this.players = [];
    this.settings = {};
    this.inMatch = false;
    this.matchId = null;
    this.rv = -1;
    this.rtt = null;
    this.buffer = new SnapshotBuffer();
    this.seq = 0;
    this.kc = 0;
    this.lastKick = false;
    this.lastKey = '';
    this.lastSent = 0;
    this.lastHeard = performance.now();
    this.ended = false;
  }

  async connect() {
    this.link = new GuestLink({
      onData: (msg) => this.onData(msg),
      onClose: () => this.close('The connection to the host was lost.'),
      onStatus: this.onStatus,
    });
    const welcomed = new Promise((resolve, reject) => {
      this.welcomed = { resolve, reject };
    });
    welcomed.catch(() => {}); // may be rejected before anyone awaits it
    await this.link.connect(this.code, { t: 'hello', v: PROTOCOL_VERSION, name: this.name });
    const timer = setTimeout(
      () => this.welcomed.reject(Object.assign(new Error('timeout'), { type: 'timeout' })),
      10000,
    );
    try {
      await welcomed;
    } finally {
      clearTimeout(timer);
    }
    this.lastHeard = performance.now();
    this.pinger = setInterval(() => this.ping(), 1000);
  }

  onData(msg) {
    if (!msg || typeof msg !== 'object') return;
    this.lastHeard = performance.now();
    switch (msg.t) {
      case 'welcome':
        this.myId = msg.id;
        this.welcomed.resolve();
        break;
      case 'room':
        if (msg.rv > this.rv) {
          this.rv = msg.rv;
          this.players = msg.players;
          this.settings = msg.settings;
          this.inMatch = msg.inMatch;
          if (this.onUpdate) this.onUpdate();
        }
        break;
      case 's':
        if (msg.m !== this.matchId) {
          this.matchId = msg.m;
          this.buffer.reset();
        }
        this.buffer.push(msg.s);
        break;
      case 'pong':
        this.rtt = performance.now() - msg.ts;
        break;
      case 'bye':
        this.close(BYE_REASONS[msg.reason] || 'You left the room.');
        break;
      default:
    }
  }

  ping() {
    if (performance.now() - this.lastHeard > TIMEOUT_MS) {
      this.close('The host stopped responding.');
      return;
    }
    this.link.send({ t: 'ping', ts: performance.now(), rtt: this.rtt });
  }

  /** Called every frame with the local controls; only sends when something changed. */
  sendInput(input) {
    if (this.ended) return;
    if (input.kick && !this.lastKick) this.kc++;
    this.lastKick = input.kick;
    const x = Math.round(input.x * 100) / 100;
    const y = Math.round(input.y * 100) / 100;
    const key = `${x},${y},${input.kick},${input.sprint},${this.kc}`;
    const now = performance.now();
    if (key === this.lastKey && now - this.lastSent < 250) return;
    this.lastKey = key;
    this.lastSent = now;
    this.link.send({ t: 'in', q: ++this.seq, x, y, k: input.kick ? 1 : 0, s: input.sprint ? 1 : 0, kc: this.kc });
  }

  setTeam(team) {
    this.link.send({ t: 'team', team });
  }

  togglePause() {
    this.link.send({ t: 'pause' });
  }

  /** 'direct' or 'relay'. */
  get mode() {
    return this.link ? this.link.mode : null;
  }

  view() {
    return this.buffer.view();
  }

  drainEvents() {
    return this.buffer.drainEvents();
  }

  close(reason) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.pinger);
    if (this.link) this.link.close();
    if (this.myId === null) {
      // Still joining: let connect() report it.
      if (this.welcomed) this.welcomed.reject(Object.assign(new Error(reason || 'Cancelled.'), { type: 'closed' }));
      return;
    }
    if (reason && this.onClosed) this.onClosed(reason);
  }

  leave() {
    this.close(null);
  }
}
