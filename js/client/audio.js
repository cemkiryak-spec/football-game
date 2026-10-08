// All sounds are synthesised with WebAudio — no audio files to load.

import { load, save } from './storage.js';

export class Sound {
  constructor() {
    this.ctx = null;
    this.noise = null;
    this.muted = load('muted', false);
  }

  /** Browsers only allow audio after a user gesture; call this from one. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    save('muted', muted);
  }

  ready() {
    return this.ctx && !this.muted && this.ctx.state === 'running';
  }

  env(gainNode, t, attack, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  noiseBurst({ t, type = 'bandpass', freq = 1000, q = 1, attack = 0.005, peak = 0.3, decay = 0.1 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    this.env(gain, t, attack, peak, decay);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
    return { filter, gain };
  }

  tone({ t, type = 'sine', freq, to, attack = 0.005, peak = 0.3, decay = 0.2 }) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    const gain = this.ctx.createGain();
    this.env(gain, t, attack, peak, decay);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
    return osc;
  }

  kick() {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone({ t, freq: 190, to: 55, peak: 0.7, decay: 0.12 });
    this.noiseBurst({ t, freq: 1800, q: 0.8, peak: 0.25, decay: 0.04 });
  }

  post() {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.tone({ t, type: 'triangle', freq: 1320, peak: 0.25, decay: 0.5 });
    this.tone({ t, type: 'sine', freq: 2093, peak: 0.12, decay: 0.35 });
    this.tone({ t, freq: 140, to: 60, peak: 0.4, decay: 0.08 });
  }

  net() {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    this.noiseBurst({ t, type: 'lowpass', freq: 900, attack: 0.02, peak: 0.35, decay: 0.35 });
  }

  whistle(kind = 'short') {
    if (!this.ready()) return;
    const blasts = { short: [0.22], long: [0.7], end: [0.25, 0.25, 0.9] }[kind] || [0.22];
    let t = this.ctx.currentTime + 0.02;
    for (const dur of blasts) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 2650;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 38; // the pea rattling in the whistle
      const depth = this.ctx.createGain();
      depth.gain.value = 140;
      lfo.connect(depth).connect(osc.frequency);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
      gain.gain.setValueAtTime(0.16, t + dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(this.master);
      osc.start(t);
      lfo.start(t);
      osc.stop(t + dur + 0.05);
      lfo.stop(t + dur + 0.05);
      t += dur + 0.12;
    }
  }

  crowd(intensity = 1) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime;
    const roar = this.noiseBurst({
      t,
      freq: 700,
      q: 0.6,
      attack: 0.25,
      peak: 0.45 * intensity,
      decay: 2.6,
    });
    roar.filter.frequency.setValueAtTime(500, t);
    roar.filter.frequency.linearRampToValueAtTime(1100, t + 0.4);
    roar.filter.frequency.linearRampToValueAtTime(650, t + 2.8);
    this.noiseBurst({ t: t + 0.05, freq: 2400, q: 1.5, attack: 0.2, peak: 0.12 * intensity, decay: 2 });
  }
}
