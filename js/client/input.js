// Keyboard, gamepad and touch input, merged into {x, y, kick, sprint}.

export const SCHEMES = {
  // Online / practice: either hand position works.
  solo: {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    kick: ['Space', 'KeyX', 'KeyK', 'Enter', 'NumpadEnter', 'Numpad0'],
    sprint: ['ShiftLeft', 'ShiftRight', 'KeyZ', 'KeyJ'],
  },
  // Two players sharing one keyboard.
  p1: {
    up: ['KeyW'],
    down: ['KeyS'],
    left: ['KeyA'],
    right: ['KeyD'],
    kick: ['Space'],
    sprint: ['ShiftLeft'],
  },
  p2: {
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    kick: ['Enter', 'NumpadEnter', 'Numpad0'],
    sprint: ['ShiftRight', 'Period', 'NumpadDecimal'],
  },
};

const GAME_KEYS = new Set(Object.values(SCHEMES).flatMap((s) => Object.values(s).flat()));

const isTyping = (el) =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

export class Keyboard {
  constructor() {
    this.down = new Set();
    this.captureGameKeys = false; // only steal Space/arrows while a match is on screen
    this.onKey = null; // (code, event) => void, for shortcuts like pause
    window.addEventListener('keydown', (e) => {
      if (isTyping(e.target)) return;
      if (this.captureGameKeys && GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat && this.onKey) this.onKey(e.code, e);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    document.addEventListener('visibilitychange', () => this.down.clear());
  }

  any(codes) {
    return codes.some((c) => this.down.has(c));
  }

  read(scheme) {
    const s = SCHEMES[scheme];
    return {
      x: (this.any(s.right) ? 1 : 0) - (this.any(s.left) ? 1 : 0),
      y: (this.any(s.down) ? 1 : 0) - (this.any(s.up) ? 1 : 0),
      kick: this.any(s.kick),
      sprint: this.any(s.sprint),
    };
  }
}

export function readGamepad(index) {
  if (!navigator.getGamepads) return null;
  const pads = [...navigator.getGamepads()].filter((p) => p && p.connected);
  const gp = pads[index];
  if (!gp) return null;
  const pressed = (i) => !!gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4);
  let x = gp.axes[0] || 0;
  let y = gp.axes[1] || 0;
  const mag = Math.hypot(x, y);
  if (mag < 0.2) {
    x = 0;
    y = 0;
  }
  if (pressed(12)) y = -1;
  if (pressed(13)) y = 1;
  if (pressed(14)) x = -1;
  if (pressed(15)) x = 1;
  return {
    x,
    y,
    kick: pressed(0) || pressed(2),
    sprint: pressed(1) || pressed(5) || pressed(7),
  };
}

export function mergeInputs(...inputs) {
  const out = { x: 0, y: 0, kick: false, sprint: false };
  for (const i of inputs) {
    if (!i) continue;
    out.x += i.x;
    out.y += i.y;
    out.kick = out.kick || i.kick;
    out.sprint = out.sprint || i.sprint;
  }
  const len = Math.hypot(out.x, out.y);
  if (len > 1) {
    out.x /= len;
    out.y /= len;
  }
  return out;
}

/** On-screen joystick (left half) plus KICK and SPRINT buttons for phones and tablets. */
export class TouchControls {
  constructor(root) {
    this.root = root;
    this.state = { x: 0, y: 0, kick: false, sprint: false };
    this.stick = root.querySelector('.stick');
    this.knob = root.querySelector('.knob');
    this.stickId = null;
    this.origin = null;
    this.radius = 56;

    const zone = root.querySelector('.stick-zone');
    zone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      this.stickId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      this.origin = { x: e.clientX, y: e.clientY };
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.stick.classList.add('active');
      this.moveStick(e);
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e);
    });
    const release = (e) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.state.x = this.state.y = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
      this.stick.classList.remove('active');
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);

    for (const btn of root.querySelectorAll('[data-touch]')) {
      const key = btn.dataset.touch;
      const set = (on) => (e) => {
        this.state[key] = on;
        btn.classList.toggle('active', on);
        e.preventDefault();
      };
      btn.addEventListener('pointerdown', set(true));
      btn.addEventListener('pointerup', set(false));
      btn.addEventListener('pointercancel', set(false));
      btn.addEventListener('pointerleave', set(false));
    }
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  moveStick(e) {
    let dx = e.clientX - this.origin.x;
    let dy = e.clientY - this.origin.y;
    const d = Math.hypot(dx, dy);
    if (d > this.radius) {
      dx = (dx / d) * this.radius;
      dy = (dy / d) * this.radius;
    }
    this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // Full speed from 60% deflection; a tiny dead zone in the middle.
    const m = Math.min(1, d / (this.radius * 0.6));
    const len = Math.hypot(dx, dy) || 1;
    this.state.x = d < 6 ? 0 : (dx / len) * m;
    this.state.y = d < 6 ? 0 : (dy / len) * m;
  }

  read() {
    return { ...this.state };
  }

  reset() {
    this.state = { x: 0, y: 0, kick: false, sprint: false };
    for (const el of this.root.querySelectorAll('.active')) el.classList.remove('active');
    this.stickId = null;
  }
}

export const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;
