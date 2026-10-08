// Canvas renderer: draws a view (see engine/snapshot.js) plus purely
// cosmetic effects such as particles, ball spin and screen shake.

import { FIELD, PLAYER, BALL } from '../engine/constants.js';

export const TEAM_COLORS = {
  red: { fill: '#e5484d', light: '#ff9a9c', dark: '#8f1d22', name: 'Red' },
  blue: { fill: '#3d7ff0', light: '#9cc2ff', dark: '#1b3f91', name: 'Blue' },
};

const VIEW_W = 2 * (FIELD.halfW + FIELD.goalDepth + 26);
const VIEW_H = 2 * (FIELD.halfH + FIELD.margin + 14);
const OUTER_W = FIELD.halfW + FIELD.margin;
const OUTER_H = FIELD.halfH + FIELD.margin;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pitch = document.createElement('canvas');
    this.insets = { top: 0, bottom: 0 };
    this.particles = [];
    this.trail = [];
    this.ballAngle = 0;
    this.lastBall = null;
    this.shake = 0;
    this.flash = 0;
    this.lastFrame = performance.now();
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.cssW = w;
    this.cssH = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    const availH = Math.max(100, h - this.insets.top - this.insets.bottom);
    this.scale = Math.min((w - 16) / VIEW_W, (availH - 8) / VIEW_H) * dpr;
    this.ox = (w / 2) * dpr;
    this.oy = (this.insets.top + availH / 2) * dpr;
    this.pitch.width = this.canvas.width;
    this.pitch.height = this.canvas.height;
    this.drawPitch(this.pitch.getContext('2d'));
  }

  /** Screen (CSS pixel) rectangle of the playing area, for positioning overlays. */
  fieldRect() {
    const s = this.scale / this.dpr;
    return {
      left: this.ox / this.dpr - FIELD.halfW * s,
      top: this.oy / this.dpr - FIELD.halfH * s,
      width: FIELD.halfW * 2 * s,
      height: FIELD.halfH * 2 * s,
    };
  }

  toWorld(ctx) {
    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox, this.oy);
  }

  drawPitch(ctx) {
    const { halfW, halfH, goalHalfW, goalDepth, centerR, postR } = FIELD;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bg = ctx.createRadialGradient(
      this.ox,
      this.oy,
      0,
      this.ox,
      this.oy,
      Math.max(this.canvas.width, this.canvas.height) * 0.7,
    );
    bg.addColorStop(0, '#1d5a2a');
    bg.addColorStop(1, '#0c2614');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    this.toWorld(ctx);

    // Mowed grass stripes over everything players can reach.
    const stripes = 14;
    const sw = (halfW * 2) / stripes;
    for (let i = -1; i <= stripes; i++) {
      const x0 = -halfW + i * sw;
      if (x0 + sw < -OUTER_W || x0 > OUTER_W) continue;
      ctx.fillStyle = i % 2 === 0 ? '#3f8f43' : '#479b4b';
      const left = Math.max(x0, -OUTER_W);
      const right = Math.min(x0 + sw, OUTER_W);
      ctx.fillRect(left, -OUTER_H, right - left, OUTER_H * 2);
    }
    // Slightly darker run-off area outside the lines.
    ctx.fillStyle = 'rgba(0, 20, 0, 0.16)';
    ctx.fillRect(-OUTER_W, -OUTER_H, OUTER_W * 2, OUTER_H - halfH);
    ctx.fillRect(-OUTER_W, halfH, OUTER_W * 2, OUTER_H - halfH);
    ctx.fillRect(-OUTER_W, -halfH, OUTER_W - halfW, halfH * 2);
    ctx.fillRect(halfW, -halfH, OUTER_W - halfW, halfH * 2);
    // Advertising-board style border.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-OUTER_W, -OUTER_H, OUTER_W * 2, OUTER_H * 2);

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.strokeRect(-halfW, -halfH, halfW * 2, halfH * 2);
    line(ctx, 0, -halfH, 0, halfH);
    circle(ctx, 0, 0, centerR);
    ctx.stroke();
    circle(ctx, 0, 0, 3);
    ctx.fill();

    for (const s of [-1, 1]) {
      const gx = s * halfW;
      const boxD = 104;
      const boxH = 128;
      ctx.strokeRect(Math.min(gx, gx - s * boxD), -boxH, boxD, boxH * 2);
      ctx.strokeRect(Math.min(gx, gx - s * 36), -92, 36, 184);
      const spotX = gx - s * 74;
      circle(ctx, spotX, 0, 2.5);
      ctx.fill();
      // Penalty arc: only the part outside the box.
      const a = Math.acos((boxD - 74) / 56);
      ctx.beginPath();
      if (s > 0) ctx.arc(spotX, 0, 56, Math.PI - a, Math.PI + a);
      else ctx.arc(spotX, 0, 56, -a, a);
      ctx.stroke();
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        const start = s > 0 ? (sy > 0 ? Math.PI : Math.PI / 2) : sy > 0 ? 1.5 * Math.PI : 0;
        ctx.arc(gx, sy * halfH, 9, start, start + Math.PI / 2);
        ctx.stroke();
      }
    }

    // Goals with netting.
    for (const s of [-1, 1]) {
      const x0 = s > 0 ? halfW : -halfW - goalDepth;
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fillRect(x0, -goalHalfW, goalDepth, goalHalfW * 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, -goalHalfW, goalDepth, goalHalfW * 2);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 0.8;
      for (let d = -goalHalfW * 2; d < goalHalfW * 2 + goalDepth; d += 7) {
        line(ctx, x0 + d, -goalHalfW, x0 + d + goalHalfW * 2, goalHalfW);
        line(ctx, x0 + d, goalHalfW, x0 + d + goalHalfW * 2, -goalHalfW);
      }
      ctx.restore();
      ctx.strokeStyle = '#f4f4f4';
      ctx.lineWidth = 3;
      const back = s * (halfW + goalDepth);
      ctx.beginPath();
      ctx.moveTo(s * halfW, -goalHalfW);
      ctx.lineTo(back, -goalHalfW);
      ctx.lineTo(back, goalHalfW);
      ctx.lineTo(s * halfW, goalHalfW);
      ctx.stroke();
      const team = TEAM_COLORS[s < 0 ? 'red' : 'blue'];
      for (const sy of [-1, 1]) {
        circle(ctx, s * halfW, sy * goalHalfW, postR);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = team.dark;
        ctx.stroke();
      }
    }
  }

  /** Spawn cosmetic particles. */
  burst(kind, x, y, team) {
    if (kind === 'confetti') {
      const colors = [TEAM_COLORS[team].fill, TEAM_COLORS[team].light, '#ffffff', '#ffd84d'];
      for (let i = 0; i < 90; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 60 + Math.random() * 260;
        this.particles.push({
          x,
          y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v - 80,
          life: 1.4 + Math.random() * 1.2,
          age: 0,
          size: 2.5 + Math.random() * 3,
          spin: Math.random() * 10,
          color: colors[i % colors.length],
          drag: 1.6,
          shape: 'rect',
        });
      }
      this.shake = Math.max(this.shake, 14);
      this.flash = 0.45;
    } else if (kind === 'dust') {
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 20 + Math.random() * 50;
        this.particles.push({
          x,
          y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: 0.35 + Math.random() * 0.2,
          age: 0,
          size: 2 + Math.random() * 2,
          color: 'rgba(235,255,225,0.7)',
          drag: 5,
          shape: 'dot',
        });
      }
      this.shake = Math.max(this.shake, 2.5);
    } else if (kind === 'spark') {
      for (let i = 0; i < 14; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 60 + Math.random() * 120;
        this.particles.push({
          x,
          y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          life: 0.3 + Math.random() * 0.2,
          age: 0,
          size: 1.8,
          color: '#fff6c8',
          drag: 4,
          shape: 'dot',
        });
      }
      this.shake = Math.max(this.shake, 5);
    }
  }

  /**
   * @param view   interpolated match view, or null
   * @param opts   { names: Map, labels: Map, me: Set of ids, dim: boolean }
   */
  draw(view, opts = {}) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const ctx = this.ctx;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c2614';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.1) {
      sx = (Math.random() - 0.5) * this.shake * this.dpr;
      sy = (Math.random() - 0.5) * this.shake * this.dpr;
      this.shake *= Math.pow(0.02, dt);
    } else {
      this.shake = 0;
    }
    ctx.drawImage(this.pitch, sx, sy);
    if (!view) return;

    ctx.setTransform(this.scale, 0, 0, this.scale, this.ox + sx, this.oy + sy);

    if (view.phase === 'kickoff') {
      const c = TEAM_COLORS[view.kickoffTeam];
      ctx.fillStyle = hexAlpha(c.fill, 0.16);
      circle(ctx, 0, 0, FIELD.centerR);
      ctx.fill();
    }

    this.updateBallFx(view.ball);

    // Shadows first so nothing is drawn over by a neighbour's shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (const p of view.players) {
      circle(ctx, p.x + 3, p.y + 4, PLAYER.radius);
      ctx.fill();
    }
    circle(ctx, view.ball.x + 2.5, view.ball.y + 3.5, BALL.radius);
    ctx.fill();

    this.drawTrail(ctx);

    const names = opts.names || new Map();
    const labels = opts.labels || new Map();
    const me = opts.me || new Set();
    for (const p of view.players) this.drawPlayer(ctx, p, names.get(p.id), labels.get(p.id), me.has(p.id), now);
    this.drawBall(ctx, view.ball);
    for (const p of view.players) this.drawName(ctx, p, names.get(p.id), labels.get(p.id), me.has(p.id), now);

    this.drawParticles(ctx, dt);

    if (this.flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255,255,255,${this.flash})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.flash = Math.max(0, this.flash - dt * 1.6);
    }
  }

  updateBallFx(ball) {
    if (this.lastBall) {
      const d = Math.hypot(ball.x - this.lastBall.x, ball.y - this.lastBall.y);
      if (d > 60) {
        this.trail = []; // teleported (kick-off reset)
      } else {
        this.ballAngle += (d / BALL.radius) * (ball.x >= this.lastBall.x ? 1 : -1);
        if (d > 3.2) this.trail.push({ x: ball.x, y: ball.y, life: 1 });
      }
    }
    this.lastBall = { x: ball.x, y: ball.y };
    for (const t of this.trail) t.life -= 0.12;
    this.trail = this.trail.filter((t) => t.life > 0).slice(-10);
  }

  drawTrail(ctx) {
    for (const t of this.trail) {
      ctx.fillStyle = `rgba(255,255,255,${0.22 * t.life})`;
      circle(ctx, t.x, t.y, BALL.radius * (0.55 + 0.45 * t.life));
      ctx.fill();
    }
  }

  drawPlayer(ctx, p, name, label, isMe, now) {
    const c = TEAM_COLORS[p.team];
    const r = PLAYER.radius;
    const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
    g.addColorStop(0, c.light);
    g.addColorStop(0.55, c.fill);
    g.addColorStop(1, c.dark);
    circle(ctx, p.x, p.y, r);
    ctx.fillStyle = g;
    ctx.fill();
    if (p.armed) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
    } else {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    }
    ctx.stroke();

    if (isMe) {
      // Gentle pulsing halo so you never lose yourself in a scramble.
      const pulse = 0.5 + 0.5 * Math.sin(now / 220);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + pulse * 0.3})`;
      circle(ctx, p.x, p.y, r + 4 + pulse * 1.5);
      ctx.stroke();
    }

    if (p.stamina < 0.995) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 7.5, -Math.PI / 2, Math.PI * 1.5);
      ctx.stroke();
      ctx.strokeStyle = p.tired ? '#ff6b5b' : '#ffd84d';
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 7.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.stamina);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    const text = label || (name ? initials(name) : '');
    if (text) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 ${text.length > 1 ? 11 : 13}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 2;
      ctx.fillText(text, p.x, p.y + 0.5);
      ctx.shadowBlur = 0;
    }
  }

  drawName(ctx, p, name, label, isMe, now) {
    if (!name) return;
    const y = p.y + PLAYER.radius + 14;
    ctx.font = `700 11px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(name, p.x, y);
    ctx.fillStyle = isMe ? '#fff7c2' : 'rgba(255,255,255,0.92)';
    ctx.fillText(name, p.x, y);
    if (isMe) {
      const bob = Math.sin(now / 180) * 1.5;
      const top = p.y - PLAYER.radius - 12 + bob;
      ctx.fillStyle = '#fff7c2';
      ctx.beginPath();
      ctx.moveTo(p.x - 5, top - 5);
      ctx.lineTo(p.x + 5, top - 5);
      ctx.lineTo(p.x, top + 1);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawBall(ctx, b) {
    const r = BALL.radius;
    const g = ctx.createRadialGradient(b.x - r * 0.35, b.y - r * 0.4, r * 0.1, b.x, b.y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#d8dde3');
    circle(ctx, b.x, b.y, r);
    ctx.fillStyle = g;
    ctx.fill();

    // Classic black patches, rotated as the ball rolls.
    ctx.save();
    circle(ctx, b.x, b.y, r);
    ctx.clip();
    ctx.translate(b.x, b.y);
    ctx.rotate(this.ballAngle);
    ctx.fillStyle = '#1b1f24';
    polygon(ctx, 0, 0, r * 0.38, 5, 0);
    ctx.fill();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      polygon(ctx, Math.cos(a) * r * 0.98, Math.sin(a) * r * 0.98, r * 0.3, 5, a);
      ctx.fill();
    }
    ctx.restore();

    circle(ctx, b.x, b.y, r);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#11151a';
    ctx.stroke();
  }

  drawParticles(ctx, dt) {
    for (const p of this.particles) {
      p.age += dt;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      if (p.shape === 'rect') p.vy += 90 * dt; // confetti drifts "down" the screen
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const a = Math.max(0, 1 - p.age / p.life);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin * p.age);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      } else {
        circle(ctx, p.x, p.y, p.size * (0.5 + a * 0.5));
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    this.particles = this.particles.filter((p) => p.age < p.life);
  }
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function polygon(ctx, x, y, r, n, rot) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** "Ada Lovelace" → "AL", "Rocket 27" → "R", "CPU 1" → "C". */
export function initials(name) {
  const words = name.match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return '';
  const first = [...words[0]][0];
  const second = words[1] && /^\p{L}/u.test(words[1]) ? [...words[1]][0] : '';
  return (first + second).toUpperCase();
}
