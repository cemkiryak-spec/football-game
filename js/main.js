// App shell: menus, lobby, HUD and the render loop.

import { TICK_RATE, FIELD, MAX_PER_TEAM } from './engine/constants.js';
import { createMatch, addPlayer, setPaused } from './engine/match.js';
import { Renderer, TEAM_COLORS } from './client/render.js';
import { Keyboard, readGamepad, mergeInputs, TouchControls, isTouchDevice } from './client/input.js';
import { Sound } from './client/audio.js';
import { Sim } from './client/sim.js';
import { HostRoom, GuestRoom, cleanName } from './client/online.js';
import { describeError, normalizeCode } from './client/net.js';
import { load, save } from './client/storage.js';

const $ = (sel) => document.querySelector(sel);

const TIME_OPTIONS = [
  [60, '1 min'],
  [120, '2 min'],
  [180, '3 min'],
  [300, '5 min'],
  [600, '10 min'],
  [0, 'No limit'],
];
const SCORE_OPTIONS = [
  [1, '1 goal'],
  [3, '3 goals'],
  [5, '5 goals'],
  [7, '7 goals'],
  [10, '10 goals'],
  [0, 'No limit'],
];
const NICKNAMES = ['Rocket', 'Maestro', 'Captain', 'Flash', 'Wizard', 'Tank', 'Falcon', 'Ace', 'Viper', 'Boss'];

const keyboard = new Keyboard();
const sound = new Sound();
const renderer = new Renderer($('#pitch'));
const touch = new TouchControls($('#touch'));

const app = {
  screen: null,
  game: null, // LocalGame | HostRoom | GuestRoom
  attract: null, // bots playing in the background of the menus
  settings: { timeLimit: 180, scoreLimit: 3, botLevel: 'normal', ...load('settings', {}) },
  touchMode: isTouchDevice(),
  view: null,
};

// ---------------------------------------------------------------------------
// Controls

function readControls(scheme) {
  const useTouch = app.touchMode && !$('#touch').hidden && scheme !== 'p2';
  return mergeInputs(keyboard.read(scheme), readGamepad(scheme === 'p2' ? 1 : 0), useTouch ? touch.read() : null);
}

const myControls = () => readControls('solo');

// ---------------------------------------------------------------------------
// Games on this device (two players on one keyboard, or practice vs CPU)

class LocalGame {
  constructor({ players, settings }) {
    this.role = 'local';
    this.players = players;
    this.settings = settings;
    this.start();
  }

  start() {
    if (this.sim) this.sim.stop();
    const match = createMatch(this.settings);
    for (const p of this.players) addPlayer(match, p);
    this.sim = new Sim(match);
    for (const p of this.players) {
      if (p.control === 'bot') this.sim.addBot(p.id, p.level);
      else this.sim.setController(p.id, () => readControls(p.control));
    }
  }

  view() {
    return this.sim.view();
  }

  drainEvents() {
    return this.sim.drainEvents();
  }

  togglePause() {
    setPaused(this.sim.match, !this.sim.match.paused);
  }

  rematch() {
    this.start();
  }

  leave() {
    this.sim.stop();
  }
}

function startAttract() {
  if (app.attract) return;
  const match = createMatch({ timeLimit: 0, scoreLimit: 0 });
  const levels = ['hard', 'normal', 'normal', 'hard'];
  levels.forEach((_, i) => addPlayer(match, { id: i + 1, name: '', team: i % 2 ? 'blue' : 'red' }));
  const sim = new Sim(match);
  levels.forEach((level, i) => sim.addBot(i + 1, level));
  app.attract = sim;
}

function stopAttract() {
  if (!app.attract) return;
  app.attract.stop();
  app.attract = null;
}

// ---------------------------------------------------------------------------
// Screens

function show(screen) {
  app.screen = screen;
  for (const s of ['menu', 'connecting', 'lobby', 'game']) $(`#screen-${s}`).hidden = s !== screen;
  document.body.dataset.screen = screen;
  document.body.dataset.role = app.game ? app.game.role : '';
  keyboard.captureGameKeys = screen === 'game';
  if (screen === 'game') {
    stopAttract();
    if (document.activeElement) document.activeElement.blur();
    resetHud();
  } else {
    startAttract();
    touch.reset();
  }
  updateTouchVisibility();
  layout();
}

function layout() {
  const top = app.screen === 'game' ? $('#hud').getBoundingClientRect().bottom + 4 : 0;
  renderer.insets = { top, bottom: 0 };
  renderer.resize();
}

function amPlaying(g) {
  if (!g) return false;
  if (g.role === 'local') return g.players.filter((p) => p.control !== 'bot').length === 1;
  const me = g.players.find((p) => p.id === g.myId);
  return !!me && me.team !== 'spec';
}

function updateTouchVisibility() {
  $('#touch').hidden = !(app.touchMode && app.screen === 'game' && amPlaying(app.game));
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), kind === 'error' ? 7000 : 2600);
}

function myName() {
  const input = $('#name');
  return cleanName(input.value, input.placeholder);
}

function currentSettings() {
  return { timeLimit: app.settings.timeLimit, scoreLimit: app.settings.scoreLimit, botLevel: app.settings.botLevel };
}

function storeSettings(patch) {
  Object.assign(app.settings, patch);
  save('settings', app.settings);
  for (const sel of document.querySelectorAll('.setting-time')) sel.value = String(app.settings.timeLimit);
  for (const sel of document.querySelectorAll('.setting-score')) sel.value = String(app.settings.scoreLimit);
}

// ---------------------------------------------------------------------------
// Starting and leaving games

function startLocal() {
  sound.unlock();
  const p2 = cleanName($('#p2-name').value, 'Player 2');
  save('p2name', $('#p2-name').value);
  app.game = new LocalGame({
    settings: currentSettings(),
    players: [
      { id: 1, name: myName(), team: 'red', control: 'p1' },
      { id: 2, name: p2, team: 'blue', control: 'p2' },
    ],
  });
  show('game');
}

function startPractice() {
  sound.unlock();
  const level = $('#practice-level').value;
  save('practiceLevel', level);
  app.game = new LocalGame({
    settings: currentSettings(),
    players: [
      { id: 1, name: myName(), team: 'red', control: 'solo' },
      { id: 2, name: 'CPU', team: 'blue', control: 'bot', level },
    ],
  });
  show('game');
}

async function createRoom() {
  sound.unlock();
  $('#connecting-text').textContent = 'Creating a room…';
  const room = new HostRoom({
    name: myName(),
    settings: currentSettings(),
    onUpdate: onRoomUpdate,
    onError: (err) => toast(describeError(err), 'error'),
  });
  room.localInput = myControls;
  app.game = room;
  show('connecting');
  try {
    await room.open();
  } catch (err) {
    room.leave();
    if (app.game !== room) return;
    app.game = null;
    show('menu');
    toast(describeError(err), 'error');
    return;
  }
  if (app.game !== room) {
    room.leave();
    return;
  }
  show('lobby');
  renderLobby();
}

async function joinRoom(rawCode) {
  const code = normalizeCode(rawCode);
  if (code.length < 4) {
    toast('Type in the room code your friend sent you.', 'error');
    $('#join-code').focus();
    return;
  }
  sound.unlock();
  $('#connecting-text').textContent = `Joining room ${code}…`;
  const room = new GuestRoom({
    name: myName(),
    code,
    onUpdate: onRoomUpdate,
    onStatus: (stage) => {
      if (app.game !== room) return;
      $('#connecting-text').textContent =
        stage === 'relay'
          ? "Your networks don't allow a direct connection — joining through the relay instead…"
          : `Joining room ${code}…`;
    },
    onClosed: (reason) => {
      if (app.game !== room) return;
      app.game = null;
      show('menu');
      toast(reason, 'error');
    },
  });
  app.game = room;
  show('connecting');
  try {
    await room.connect();
  } catch (err) {
    room.leave();
    if (app.game !== room) return;
    app.game = null;
    show('menu');
    toast(describeError(err, code), 'error');
    return;
  }
  if (app.game !== room) {
    room.leave();
    return;
  }
  show(room.inMatch ? 'game' : 'lobby');
  if (!room.inMatch) renderLobby();
}

function onRoomUpdate() {
  const g = app.game;
  if (!g || app.screen === 'connecting') return;
  if (g.inMatch && app.screen !== 'game') show('game');
  else if (!g.inMatch && app.screen !== 'lobby') show('lobby');
  if (app.screen === 'lobby') renderLobby();
  updateTouchVisibility();
}

/** The ✕ button during a match. */
function exitGame() {
  const g = app.game;
  if (g && g.role === 'host') {
    g.toLobby();
    return;
  }
  if (g) g.leave();
  app.game = null;
  show('menu');
}

function leaveRoom() {
  if (app.game) app.game.leave();
  app.game = null;
  show('menu');
}

// ---------------------------------------------------------------------------
// Lobby

function inviteLink(code) {
  const url = new URL(location.href);
  const params = new URLSearchParams();
  params.set('room', code);
  // Keep connection overrides so the friend ends up on the same servers.
  const current = new URLSearchParams(location.search);
  for (const k of ['signal', 'secure', 'ice', 'relay', 'direct']) if (current.has(k)) params.set(k, current.get(k));
  url.search = params.toString();
  url.hash = '';
  return url.toString();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function renderLobby() {
  const g = app.game;
  if (!g || g.role === 'local') return;
  document.body.dataset.role = g.role;
  const isHost = g.role === 'host';
  $('#room-code').textContent = g.code;
  $('#invite-link').value = inviteLink(g.code);
  $('#btn-share').hidden = !navigator.share;

  const me = g.players.find((p) => p.id === g.myId);
  const counts = { red: 0, blue: 0 };
  for (const p of g.players) if (p.team in counts) counts[p.team]++;

  for (const team of ['red', 'blue']) {
    const members = g.players.filter((p) => p.team === team);
    const items = members.map((p) => {
      const badges = [];
      if (p.id === g.myId) badges.push(el('span', { class: 'badge you', textContent: 'You' }));
      if (p.host) badges.push(el('span', { class: 'badge', textContent: 'Host' }));
      if (p.bot) badges.push(el('span', { class: 'badge', textContent: 'CPU' }));
      let tail = null;
      if (p.bot && isHost) {
        tail = el('button', { class: 'remove-bot ghost', textContent: '×', title: 'Remove CPU', 'data-remove': p.id });
      } else if (typeof p.ping === 'number') {
        tail = el('span', { class: 'ping', textContent: `${p.ping} ms${p.relay ? ' · relay' : ''}` });
      }
      return el('li', {}, el('span', { class: 'name', textContent: p.name }), ...badges, tail);
    });
    if (!items.length) items.push(el('li', { class: 'empty', textContent: 'Nobody yet' }));
    $(`#list-${team}`).replaceChildren(...items);
    const joinBtn = document.querySelector(`[data-join="${team}"]`);
    joinBtn.disabled = (me && me.team === team) || counts[team] >= MAX_PER_TEAM;
    document.querySelector(`[data-bot="${team}"]`).disabled = counts[team] >= MAX_PER_TEAM;
  }
  const specs = g.players.filter((p) => p.team === 'spec').map((p) => p.name);
  $('#list-spec').textContent = specs.length ? specs.join(', ') : 'nobody';
  document.querySelector('[data-join="spec"]').disabled = !!me && me.team === 'spec';

  const s = g.settings || {};
  $('#lobby-time').value = String(s.timeLimit ?? 180);
  $('#lobby-score').value = String(s.scoreLimit ?? 3);
  $('#lobby-bot').value = s.botLevel || 'normal';
  for (const id of ['#lobby-time', '#lobby-score', '#lobby-bot']) $(id).disabled = !isHost;

  const humans = g.players.filter((p) => !p.bot).length;
  if (isHost) {
    $('#btn-start').disabled = !g.canStart();
    $('#lobby-hint').textContent =
      humans < 2
        ? 'Send the invite link to your friend. They can join from any browser — or add a CPU to play right away.'
        : g.canStart()
          ? 'Everyone ready? Hit Start match.'
          : 'Each team needs at least one player.';
  } else {
    $('#lobby-hint').textContent = "You're in! Pick a team — the host starts the match.";
  }

  // Let the host know early if their network limits who can join.
  const net = $('#lobby-net');
  net.hidden = true;
  if (isHost) {
    if (!g.link.direct && g.link.relay.reachable) {
      net.hidden = false;
      net.textContent =
        "Direct connections aren't available on your network, so friends will join through the relay (slightly more lag).";
    } else if (g.link.direct && !g.link.relay.reachable) {
      net.hidden = false;
      net.textContent =
        "The relay servers can't be reached from your network, so only friends whose networks allow direct connections can join.";
    }
  }
}

// ---------------------------------------------------------------------------
// HUD, banners and the end-of-match panel

const hudText = new Map();
function setText(sel, text) {
  if (hudText.get(sel) === text) return;
  hudText.set(sel, text);
  $(sel).textContent = text;
}

function resetHud() {
  hudText.clear();
  endShown = false;
  $('#end-panel').hidden = true;
  $('#paused').hidden = true;
  $('#banner').classList.remove('show');
}

function fmtClock(secs) {
  const s = Math.max(0, secs);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

let metaCache = { game: null, key: null, meta: null };
function gameMeta(g) {
  const key = g.role === 'local' ? 'local' : g.rv;
  if (metaCache.game === g && metaCache.key === key) return metaCache.meta;
  const names = new Map();
  const labels = new Map();
  const me = new Set();
  for (const p of g.players) names.set(p.id, p.name);
  if (g.role === 'local') {
    const humans = g.players.filter((p) => p.control !== 'bot');
    if (humans.length > 1) humans.forEach((p, i) => labels.set(p.id, `P${i + 1}`));
    else humans.forEach((p) => me.add(p.id));
  } else if (g.myId !== null) {
    me.add(g.myId);
  }
  const meta = { names, labels, me };
  metaCache = { game: g, key, meta };
  return meta;
}

function teamLabel(team, view, meta) {
  const members = view.players.filter((p) => p.team === team);
  if (members.length === 1 && meta.names.get(members[0].id)) return meta.names.get(members[0].id);
  return TEAM_COLORS[team].name;
}

function updateHud(view, meta) {
  if (!view) return;
  setText('#hud-red', String(view.score.red));
  setText('#hud-blue', String(view.score.blue));
  setText('#hud-red-name', teamLabel('red', view, meta));
  setText('#hud-blue-name', teamLabel('blue', view, meta));

  const secs = view.elapsed / TICK_RATE;
  let time;
  let sub;
  if (view.overtime) {
    time = `+${fmtClock(secs - view.timeLimit)}`;
    sub = 'Golden goal';
  } else if (view.timeLimit > 0) {
    time = fmtClock(Math.ceil(view.timeLimit - secs));
    sub = view.scoreLimit ? `First to ${view.scoreLimit}` : '';
  } else {
    time = fmtClock(secs);
    sub = view.scoreLimit ? `First to ${view.scoreLimit}` : 'Friendly';
  }
  setText('#hud-time', time);
  setText('#hud-sub', sub);
  $('#hud-sub').classList.toggle('golden', view.overtime);

  const g = app.game;
  const ping = $('#hud-ping');
  if (g.role === 'guest' && typeof g.rtt === 'number') {
    ping.hidden = false;
    setText('#hud-ping', `${Math.round(g.rtt)} ms${g.mode === 'relay' ? ' · relay' : ''}`);
  } else {
    ping.hidden = true;
  }

  $('#paused').hidden = !view.paused || view.phase === 'over';
  if (view.phase === 'over') showEnd(view, meta);
  else if (endShown) {
    $('#end-panel').hidden = true;
    endShown = false;
  }
}

let endShown = false;
function showEnd(view, meta) {
  if (endShown) return;
  endShown = true;
  const g = app.game;
  $('#end-title').textContent = view.winner ? `${teamLabel(view.winner, view, meta)} wins!` : "It's a draw";
  $('#end-red').textContent = view.score.red;
  $('#end-blue').textContent = view.score.blue;
  const goals = view.goals.map((goal) =>
    el(
      'li',
      {},
      el('span', { class: `dot ${goal.team}` }),
      el('span', { class: 'min', textContent: fmtClock(goal.t / TICK_RATE) }),
      el('span', {
        textContent: `${goal.name || TEAM_COLORS[goal.team].name}${goal.own ? ' (own goal)' : ''}`,
      }),
    ),
  );
  $('#end-goals').replaceChildren(...goals);
  const canRestart = g.role !== 'guest';
  $('#btn-rematch').hidden = !canRestart;
  $('#btn-to-lobby').hidden = !canRestart;
  $('#btn-to-lobby').textContent = g.role === 'host' ? 'Back to lobby' : 'Main menu';
  $('#end-wait').hidden = canRestart;
  $('#btn-leave-end').hidden = canRestart;
  $('#end-panel').hidden = false;
}

function banner(title, sub, team, short = false) {
  const b = $('#banner');
  b.querySelector('.banner-title').textContent = title;
  b.querySelector('.banner-sub').textContent = sub || '';
  b.style.setProperty('--team', team ? TEAM_COLORS[team].fill : 'rgba(0,0,0,0.35)');
  b.classList.remove('show');
  b.classList.toggle('short', short);
  void b.offsetWidth; // restart the CSS animation
  b.classList.add('show');
}

function matchSubtitle(view) {
  if (!view) return '';
  const parts = [];
  if (view.scoreLimit) parts.push(`First to ${view.scoreLimit}`);
  if (view.timeLimit) parts.push(`${Math.round(view.timeLimit / 60)} min`);
  return parts.join(' · ');
}

function onGameEvent(e, view) {
  const ball = view ? view.ball : { x: 0, y: 0 };
  switch (e.e) {
    case 'start':
      sound.whistle('long');
      banner('Kick-off!', matchSubtitle(view), null, true);
      break;
    case 'kickoff':
      sound.whistle('short');
      break;
    case 'kick':
      sound.kick();
      renderer.burst('dust', ball.x, ball.y);
      break;
    case 'post':
      sound.post();
      renderer.burst('spark', ball.x, ball.y);
      break;
    case 'net':
      sound.net();
      break;
    case 'goal': {
      sound.crowd();
      const x = (e.team === 'red' ? 1 : -1) * (FIELD.halfW + FIELD.goalDepth / 2);
      renderer.burst('confetti', x, ball.y, e.team);
      const who = e.name ? (e.own ? `Own goal by ${e.name}` : e.name) : `${TEAM_COLORS[e.team].name} scores`;
      banner('GOAL!', who, e.team);
      break;
    }
    case 'overtime':
      sound.whistle('long');
      banner('Golden goal', 'Next goal wins', null, true);
      break;
    case 'end':
      sound.whistle('end');
      break;
    default:
  }
}

// ---------------------------------------------------------------------------
// Main loop

function frame() {
  requestAnimationFrame(frame);
  const g = app.game;
  let view = null;
  let opts = {};
  if (app.screen === 'game' && g) {
    if (g.role === 'guest') g.sendInput(amPlaying(g) ? myControls() : { x: 0, y: 0, kick: false, sprint: false });
    view = g.view();
    const meta = gameMeta(g);
    for (const e of g.drainEvents()) onGameEvent(e, view);
    opts = meta;
    updateHud(view, meta);
  } else if (app.attract) {
    view = app.attract.view();
    app.attract.drainEvents();
  }
  app.view = view;
  renderer.draw(view, opts);
}

// ---------------------------------------------------------------------------
// Wiring

function fillSelect(sel, options, value) {
  sel.replaceChildren(...options.map(([v, label]) => el('option', { value: String(v), textContent: label })));
  sel.value = String(value);
}

function toggleMute() {
  sound.setMuted(!sound.muted);
  $('#btn-mute').classList.toggle('muted', sound.muted);
}

function init() {
  for (const sel of document.querySelectorAll('.setting-time')) fillSelect(sel, TIME_OPTIONS, app.settings.timeLimit);
  for (const sel of document.querySelectorAll('.setting-score'))
    fillSelect(sel, SCORE_OPTIONS, app.settings.scoreLimit);

  const nameInput = $('#name');
  let fallback = load('fallbackName', null);
  if (!fallback) {
    fallback = `${NICKNAMES[Math.floor(Math.random() * NICKNAMES.length)]} ${10 + Math.floor(Math.random() * 90)}`;
    save('fallbackName', fallback);
  }
  nameInput.placeholder = fallback;
  nameInput.value = load('name', '');
  nameInput.addEventListener('input', () => save('name', nameInput.value));
  $('#p2-name').value = load('p2name', '');
  $('#practice-level').value = load('practiceLevel', 'normal');
  $('#btn-mute').classList.toggle('muted', sound.muted);

  const invited = normalizeCode(new URLSearchParams(location.search).get('room'));
  if (invited) {
    $('#invite-banner').hidden = false;
    $('#invite-code').textContent = invited;
    $('#join-code').value = invited;
    $('#btn-accept-invite').addEventListener('click', () => joinRoom(invited));
  }

  $('#btn-create').addEventListener('click', createRoom);
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom($('#join-code').value);
  });
  $('#btn-local').addEventListener('click', startLocal);
  $('#btn-practice').addEventListener('click', startPractice);
  $('#menu-time').addEventListener('change', (e) => storeSettings({ timeLimit: Number(e.target.value) }));
  $('#menu-score').addEventListener('change', (e) => storeSettings({ scoreLimit: Number(e.target.value) }));
  $('#btn-cancel-connect').addEventListener('click', leaveRoom);

  // Lobby
  $('#btn-copy').addEventListener('click', async () => {
    const link = $('#invite-link').value;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied — send it to your friend!');
    } catch {
      $('#invite-link').select();
      toast('Copy the link above and send it to your friend.');
    }
  });
  $('#btn-share').addEventListener('click', () => {
    navigator
      .share({ title: 'Kickabout', text: 'Join my football match!', url: $('#invite-link').value })
      .catch(() => {});
  });
  $('#invite-link').addEventListener('focus', (e) => e.target.select());
  document.querySelector('.teams').addEventListener('click', (e) => {
    const g = app.game;
    const btn = e.target.closest('button');
    if (!g || !btn) return;
    if (btn.dataset.join) {
      if (g.role === 'host') g.setTeam(g.myId, btn.dataset.join);
      else g.setTeam(btn.dataset.join);
    } else if (btn.dataset.bot && g.role === 'host') {
      g.addBot(btn.dataset.bot);
    } else if (btn.dataset.remove && g.role === 'host') {
      g.removeBot(Number(btn.dataset.remove));
    }
  });
  document.querySelector('[data-join="spec"]').addEventListener('click', () => {
    const g = app.game;
    if (!g) return;
    if (g.role === 'host') g.setTeam(g.myId, 'spec');
    else g.setTeam('spec');
  });
  const hostSetting = (key, parse) => (e) => {
    const g = app.game;
    if (!g || g.role !== 'host') return;
    const value = parse(e.target.value);
    g.setSettings({ [key]: value });
    storeSettings({ [key]: value });
  };
  $('#lobby-time').addEventListener('change', hostSetting('timeLimit', Number));
  $('#lobby-score').addEventListener('change', hostSetting('scoreLimit', Number));
  $('#lobby-bot').addEventListener('change', hostSetting('botLevel', String));
  $('#btn-start').addEventListener('click', () => {
    const g = app.game;
    if (g && g.role === 'host' && g.canStart()) {
      sound.unlock();
      g.startMatch();
    }
  });
  $('#btn-leave-lobby').addEventListener('click', leaveRoom);

  // In game
  $('#btn-mute').addEventListener('click', toggleMute);
  $('#btn-pause').addEventListener('click', () => app.game && app.game.togglePause());
  $('#btn-resume').addEventListener('click', () => app.game && app.game.togglePause());
  const fsBtn = $('#btn-fullscreen');
  fsBtn.hidden = !document.fullscreenEnabled;
  fsBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }
    } catch {
      /* not allowed here */
    }
  });
  const exitBtn = $('#btn-exit');
  let exitArmedAt = 0;
  const exitIcon = exitBtn.innerHTML;
  const disarmExit = () => {
    exitArmedAt = 0;
    exitBtn.classList.remove('confirm');
    exitBtn.innerHTML = exitIcon;
  };
  exitBtn.addEventListener('click', () => {
    const over = app.view && app.view.phase === 'over';
    if (!over && performance.now() - exitArmedAt > 3000) {
      exitArmedAt = performance.now();
      exitBtn.classList.add('confirm');
      exitBtn.textContent = app.game && app.game.role === 'host' ? 'End match?' : 'Leave?';
      setTimeout(() => performance.now() - exitArmedAt >= 2900 && disarmExit(), 3000);
      return;
    }
    disarmExit();
    exitGame();
  });
  $('#btn-rematch').addEventListener('click', () => {
    const g = app.game;
    if (!g) return;
    resetHud();
    if (g.role === 'host') g.startMatch();
    else g.rematch();
  });
  $('#btn-leave-end').addEventListener('click', exitGame);
  $('#btn-to-lobby').addEventListener('click', () => {
    const g = app.game;
    if (g && g.role === 'host') g.toLobby();
    else exitGame();
  });

  keyboard.onKey = (code) => {
    if (app.screen !== 'game' || !app.game) return;
    if (code === 'KeyP' || code === 'Escape') app.game.togglePause();
    else if (code === 'KeyM') toggleMute();
  };

  // Unlock audio on the first interaction, and switch to touch controls on the first touch.
  window.addEventListener('pointerdown', (e) => {
    sound.unlock();
    if (e.pointerType === 'touch' && !app.touchMode) {
      app.touchMode = true;
      updateTouchVisibility();
    }
  });
  window.addEventListener('keydown', () => sound.unlock(), { once: true });
  window.addEventListener('resize', layout);
  window.addEventListener('beforeunload', (e) => {
    const g = app.game;
    if (g && g.role === 'host' && g.peers.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  show('menu');
  requestAnimationFrame(frame);

  // Read-only handle for automated tests and curious players.
  window.kickabout = app;
}

init();
