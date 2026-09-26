// Procedural sound design: every effect is synthesised from oscillators,
// noise and filters (no samples), then placed on the cue list written by the
// renderer (out/events.json), panned by on-screen position and sent through a
// small stereo reverb.  Output: out/audio.wav (48 kHz, 24-bit).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const SR = 48000;
const { duration, events } = JSON.parse(fs.readFileSync(path.join(OUT, 'events.json'), 'utf8'));
const LEN = Math.ceil((duration + 0.05) * SR);

const dryL = new Float32Array(LEN), dryR = new Float32Array(LEN);
const send = new Float32Array(LEN);

// ---------- DSP helpers ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function biquad(type, f, Q) {
  const s = { x1: 0, x2: 0, y1: 0, y2: 0 };
  s.set = (ff, qq = Q) => {
    const w0 = (2 * Math.PI * Math.min(ff, SR * 0.45)) / SR, c = Math.cos(w0), a = Math.sin(w0) / (2 * qq);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = a; b1 = 0; b2 = -a; } // band-pass, 0 dB peak
    const a0 = 1 + a;
    s.b0 = b0 / a0; s.b1 = b1 / a0; s.b2 = b2 / a0; s.a1 = (-2 * c) / a0; s.a2 = (1 - a) / a0;
  };
  s.set(f, Q);
  s.run = (x) => {
    const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
    s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
    return y;
  };
  return s;
}
const buf = (sec) => new Float32Array(Math.ceil(sec * SR));
// damped sine partial
function partial(out, f, amp, tau, { attack = 0.0006, phase = 0, glideTo = null, glideRate = 0 } = {}) {
  let ph = phase;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const ff = glideTo ? glideTo + (f - glideTo) * Math.exp(-glideRate * t) : f;
    ph += (2 * Math.PI * ff) / SR;
    const env = Math.min(1, t / attack) * Math.exp(-t / tau);
    out[i] += amp * env * Math.sin(ph);
  }
}
// filtered noise burst
function noiseBurst(out, r, { amp, tau, type = 'bp', f = 4000, Q = 1, attack = 0.0002, start = 0 }) {
  const flt = biquad(type, f, Q);
  const s0 = Math.floor(start * SR);
  for (let i = s0; i < out.length; i++) {
    const t = (i - s0) / SR;
    const env = Math.min(1, t / attack) * Math.exp(-t / tau);
    if (env < 1e-5 && t > attack) break;
    out[i] += amp * flt.run(r() * 2 - 1) * env;
  }
}
function place(mono, t, pan, gain, sendAmt) {
  const p = Math.max(-1, Math.min(1, pan * 0.75));
  const gl = Math.cos(((p + 1) * Math.PI) / 4) * gain, gr = Math.sin(((p + 1) * Math.PI) / 4) * gain;
  const s0 = Math.round(t * SR);
  for (let i = 0; i < mono.length; i++) {
    const k = s0 + i;
    if (k < 0 || k >= LEN) continue;
    dryL[k] += mono[i] * gl;
    dryR[k] += mono[i] * gr;
    send[k] += mono[i] * gain * sendAmt;
  }
}

// ---------- voices ----------
const V = {
  // bright UI tick
  tick(r, v) {
    const o = buf(0.05);
    noiseBurst(o, r, { amp: 0.9, tau: 0.0007, f: 3800 + 3200 * v, Q: 1.1 });
    partial(o, 1700 + 1500 * v, 0.28, 0.005);
    partial(o, 5200 + 900 * v, 0.08, 0.002);
    return { o, send: 0.18 };
  },
  // small mechanical click (anchor points popping in)
  node(r, v) {
    const o = buf(0.07);
    noiseBurst(o, r, { amp: 0.8, tau: 0.0009, f: 3000 + 2000 * v, Q: 0.9 });
    partial(o, 950 + 600 * v, 0.34, 0.009);
    partial(o, 2500 + 900 * v, 0.14, 0.0035);
    partial(o, 110 + 40 * v, 0.3, 0.018);
    return { o, send: 0.16 };
  },
  // heavier clack (guide lines / boxes)
  click(r, v) {
    const o = buf(0.12);
    noiseBurst(o, r, { amp: 0.9, tau: 0.0012, f: 2400 + 1200 * v, Q: 0.8 });
    partial(o, 430 + 120 * v, 0.42, 0.018);
    partial(o, 1250 + 300 * v, 0.16, 0.007);
    partial(o, 92, 0.38, 0.03);
    return { o, send: 0.22 };
  },
  // low punchy hit (glyphs filling in), tuned descending in D
  thock(r, v) {
    const o = buf(0.42);
    const base = [73.42, 82.41, 92.5, 110.0, 123.47, 110.0, 92.5, 73.42][Math.min(7, Math.round(v * 7))];
    partial(o, base * 3.2, 0.9, 0.11, { glideTo: base, glideRate: 38, attack: 0.001 });
    noiseBurst(o, r, { amp: 0.55, tau: 0.0025, type: 'lp', f: 2600, Q: 0.7 });
    partial(o, base * 6.4, 0.1, 0.012);
    for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * 1.6) / 1.2;
    return { o, send: 0.2 };
  },
  // quiet pentatonic data blips under the scan
  scan(r, v) {
    const notes = [1174.66, 1318.51, 1479.98, 1760.0, 1975.53, 2349.32];
    const o = buf(0.04);
    partial(o, notes[Math.floor(v * notes.length) % notes.length], 0.5, 0.006, { attack: 0.0008 });
    noiseBurst(o, r, { amp: 0.25, tau: 0.0005, f: 7000, Q: 1.2 });
    return { o, send: 0.3 };
  },
  // clean bell-like sine ping
  ping(r, v, e) {
    const f = e.f || 880;
    const o = buf(2.2);
    partial(o, f, 0.6, 0.62, { attack: 0.002 });
    partial(o, f * 2, 0.1, 0.22, { attack: 0.002 });
    partial(o, f * 3.01, 0.035, 0.09, { attack: 0.002 });
    partial(o, f * 0.5, 0.12, 0.5, { attack: 0.004 });
    noiseBurst(o, r, { amp: 0.12, tau: 0.001, f: 6000, Q: 0.8 });
    return { o, send: 0.55 };
  },
  // keyboard key: press + softer release
  key(r, v) {
    const o = buf(0.2);
    noiseBurst(o, r, { amp: 0.75, tau: 0.0014, f: 2100 + 1100 * v, Q: 0.9 });
    partial(o, 290 + 110 * v, 0.3, 0.013);
    partial(o, 1150 + 380 * v, 0.14, 0.006);
    const rel = 0.068 + 0.03 * r();
    noiseBurst(o, r, { amp: 0.28, tau: 0.0009, f: 3300 + 800 * v, Q: 1, start: rel });
    return { o, send: 0.14 };
  },
  space(r, v) {
    const o = buf(0.24);
    noiseBurst(o, r, { amp: 0.7, tau: 0.002, f: 1500, Q: 0.8 });
    partial(o, 185 + 20 * v, 0.38, 0.022);
    partial(o, 720, 0.1, 0.01);
    noiseBurst(o, r, { amp: 0.22, tau: 0.0012, f: 2600, Q: 1, start: 0.09 });
    return { o, send: 0.14 };
  },
  // band-passed noise sweep
  whoosh(r, v, e) {
    const dur = e.dur || 0.5, dir = e.dir || 1;
    const o = buf(dur + 0.1);
    const f = biquad('bp', 400, 1.4), f2 = biquad('lp', 5000, 0.7);
    for (let i = 0; i < o.length; i++) {
      const u = Math.min(1, i / SR / dur);
      if (i % 32 === 0) f.set(dir > 0 ? 350 * Math.pow(9, u) : 3200 * Math.pow(1 / 9, u), 1.4);
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, u)), 2);
      o[i] = f2.run(f.run(r() * 2 - 1)) * env * 1.6;
    }
    return { o, send: 0.35 };
  },
};

// sustained elements rendered straight into the buses
function pad(t0, dur, gain) {
  const notes = [146.83, 220.0, 329.63, 369.99, 554.37]; // Dmaj9
  const n = Math.ceil((dur + 1.2) * SR), s0 = Math.round(t0 * SR);
  const lpL = biquad('lp', 900, 0.6), lpR = biquad('lp', 900, 0.6);
  const voices = [];
  notes.forEach((f, i) => [-6, 0, 6].forEach((c, j) => voices.push({ f: f * Math.pow(2, c / 1200), ph: (i * 0.37 + j * 0.61) % 1, pan: j - 1 })));
  const blep = (t, dt) => (t < dt ? ((t /= dt), t + t - t * t - 1) : t > 1 - dt ? ((t = (t - 1) / dt), t * t + t + t + 1) : 0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.7) * (t > dur ? Math.exp(-(t - dur) / 0.35) : 1);
    if (i % 64 === 0) { const fc = 700 + 380 * Math.sin(2 * Math.PI * 0.35 * t); lpL.set(fc, 0.6); lpR.set(fc, 0.6); }
    let l = 0, rr = 0;
    for (const vo of voices) {
      const dt = vo.f / SR;
      vo.ph += dt; if (vo.ph >= 1) vo.ph -= 1;
      const s = 2 * vo.ph - 1 - blep(vo.ph, dt);
      l += s * (vo.pan <= 0 ? 1 : 0.4); rr += s * (vo.pan >= 0 ? 1 : 0.4);
    }
    const k = s0 + i;
    if (k >= LEN) break;
    const L = lpL.run(l) * env * gain * 0.06, R = lpR.run(rr) * env * gain * 0.06;
    dryL[k] += L; dryR[k] += R; send[k] += (L + R) * 0.5;
  }
}
function sub(t0, dur, gain) {
  const s0 = Math.round(t0 * SR), n = Math.ceil(dur * SR);
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.25) * Math.min(1, (dur - t) / 0.5);
    const s = (Math.sin(2 * Math.PI * 73.42 * t) * 0.7 + Math.sin(2 * Math.PI * 146.83 * t) * 0.3) * env * gain * 0.35;
    dryL[s0 + i] += s; dryR[s0 + i] += s;
  }
}

// ---------- place events ----------
let lastNode = -1;
events.forEach((e, idx) => {
  const r = rng(idx * 7919 + 17);
  const v = e.v ?? r();
  let t = e.t, gain = e.gain ?? 0.5;
  if (e.type === 'pad') return pad(t, e.dur, gain);
  if (e.type === 'sub') return sub(t, e.dur, gain);
  if (e.type === 'node') {
    // keep simultaneous pops from stacking into one loud transient
    if (t - lastNode < 0.012) { t = lastNode + 0.012; gain *= 0.7; }
    lastNode = t;
  }
  const voice = V[e.type];
  if (!voice) { console.warn('unknown cue', e.type); return; }
  const { o, send: s } = voice(r, v, e);
  place(o, t, e.pan ?? 0, gain, s);
});

// ---------- stereo reverb (Freeverb-style) ----------
function reverb(input, spread) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => ({ b: new Float32Array(Math.round((d + spread) * (SR / 44100))), i: 0, f: 0 }));
  const aps = [556, 441, 341, 225].map((d) => ({ b: new Float32Array(Math.round((d + spread) * (SR / 44100))), i: 0 }));
  const fb = 0.8, damp = 0.32;
  const out = new Float32Array(input.length);
  for (let n = 0; n < input.length; n++) {
    const x = input[n] * 0.015;
    let y = 0;
    for (const c of combs) {
      const o = c.b[c.i];
      c.f = o * (1 - damp) + c.f * damp;
      c.b[c.i] = x + c.f * fb;
      c.i = (c.i + 1) % c.b.length;
      y += o;
    }
    for (const a of aps) {
      const o = a.b[a.i];
      a.b[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.b.length;
      y = o - y;
    }
    out[n] = y;
  }
  return out;
}
const wetL = reverb(send, 0), wetR = reverb(send, 23);

// ---------- master ----------
const hpL = biquad('hp', 28, 0.7), hpR = biquad('hp', 28, 0.7);
const L = new Float32Array(LEN), R = new Float32Array(LEN);
let peak = 0;
for (let i = 0; i < LEN; i++) {
  const fade = Math.min(1, (LEN - i) / (0.3 * SR));
  L[i] = hpL.run(dryL[i] + wetL[i] * 0.9) * fade;
  R[i] = hpR.run(dryR[i] + wetR[i] * 0.9) * fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
// normalise to -3 dBFS peak before the loudness pass in encode.mjs
const g = Math.pow(10, -3 / 20) / (peak || 1);
const data = Buffer.alloc(LEN * 2 * 3);
let o = 0;
for (let i = 0; i < LEN; i++) {
  for (const ch of [L, R]) {
    const s = Math.max(-1, Math.min(1, ch[i] * g));
    const q = Math.round(s * 8388607);
    data.writeIntLE(q, o, 3);
    o += 3;
  }
}
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 6, 28); hdr.writeUInt16LE(6, 32); hdr.writeUInt16LE(24, 34);
hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
fs.writeFileSync(path.join(OUT, 'audio.wav'), Buffer.concat([hdr, data]));
console.log(`audio -> out/audio.wav  ${(LEN / SR).toFixed(2)}s  ${events.length} cues  raw peak ${peak.toFixed(3)}`);
