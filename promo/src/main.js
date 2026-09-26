/* Type-construction promo — deterministic canvas renderer.
 *
 * Every visual is a pure function of time t (seconds), so the same code drives
 * the live preview and the frame-exact offline render. The sound-effect cue
 * list (SCENE.events) is derived from the same timeline, which keeps picture
 * and audio locked to the frame.
 */
(async function () {
  const params = new URLSearchParams(location.search);
  const MODE = params.get('mode') || 'preview';
  const cfg = await (await fetch('config.json', { cache: 'no-store' })).json();
  const W = cfg.width, H = cfg.height, FPS = cfg.fps, DUR = cfg.duration;
  const SCALE = parseFloat(params.get('scale') || (MODE === 'render' ? '2' : String(Math.min(2, window.devicePixelRatio || 1))));
  const BG = cfg.palette.bg, INK = cfg.palette.ink;

  // ---------- fonts ----------
  const buf = await (await fetch('fonts/Geist-SemiBold.ttf')).arrayBuffer();
  const font = opentype.parse(buf);
  const faces = [
    new FontFace('GeistUI', 'url(fonts/Geist-Regular.ttf)', { weight: '400' }),
    new FontFace('GeistUI', 'url(fonts/Geist-Medium.ttf)', { weight: '500' }),
    new FontFace('GeistUI', 'url(fonts/Geist-SemiBold.ttf)', { weight: '600' }),
    new FontFace('GeistMonoUI', 'url(fonts/GeistMono-Medium.ttf)', { weight: '500' }),
  ];
  for (const f of faces) document.fonts.add(await f.load());

  // ---------- utils ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const inv = (a, b, x) => clamp((x - a) / (b - a));
  const E = {
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    inCubic: (t) => t * t * t,
    outQuart: (t) => 1 - Math.pow(1 - t, 4),
    inOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
    outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    outBack: (t, s = 2.2) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  };
  function hash(a, b = 0) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  const seedOf = (s) => [...s].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0;

  // ---------- glyph model (font units, y up) ----------
  const upm = font.unitsPerEm;
  const CAP = font.tables.os2.sCapHeight, XH = font.tables.os2.sxHeight;
  const chars = [...cfg.brand];
  const glyphs = chars.map((c) => font.charToGlyph(c));
  const G = [];
  {
    let pen = 0;
    glyphs.forEach((g, i) => {
      g.getPath(); // forces outline parse so g.points exists
      const kern = i < glyphs.length - 1 ? font.getKerningValue(g, glyphs[i + 1]) : 0;
      G.push({ ch: chars[i], g, x0: pen, adv: g.advanceWidth, cellW: g.advanceWidth + kern, contours: buildContours(g) });
      pen += g.advanceWidth + kern;
    });
  }
  const TOTAL = G.reduce((a, c) => a + c.cellW, 0);
  const N = G.length;

  function buildContours(g) {
    const raw = [];
    let cur = [];
    for (const p of g.points || []) {
      cur.push({ x: p.x, y: p.y, on: !!p.onCurve });
      if (p.lastPointOfContour) { raw.push(cur); cur = []; }
    }
    if (cur.length) raw.push(cur);
    return raw.map(decode);
  }

  // Decode a TrueType (quadratic) contour into a flattened polyline, keeping
  // track of where the pen passes each real point so nodes can pop in sync.
  function decode(c) {
    const n = c.length;
    let s = c.findIndex((p) => p.on);
    let pts;
    if (s < 0) pts = [{ x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, on: true, implied: true }, ...c.slice(1), c[0]];
    else pts = c.slice(s).concat(c.slice(0, s));
    const segs = [];
    let prev = pts[0], ctrl = null;
    for (let k = 1; k <= pts.length; k++) {
      const p = pts[k % pts.length];
      if (p.on) {
        segs.push(ctrl ? { q: true, p0: prev, c: ctrl, p1: p } : { q: false, p0: prev, p1: p });
        ctrl = null; prev = p;
      } else {
        if (ctrl) {
          const m = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2, on: true, implied: true };
          segs.push({ q: true, p0: prev, c: ctrl, p1: m });
          prev = m;
        }
        ctrl = p;
      }
    }
    // flatten
    const poly = [{ x: pts[0].x, y: pts[0].y }];
    const cum = [0];
    const passAt = new Map(); // point object -> arc length where the pen reaches it
    passAt.set(pts[0], 0);
    let L = 0;
    for (const sg of segs) {
      const steps = sg.q ? Math.max(8, Math.ceil(Math.hypot(sg.p1.x - sg.p0.x, sg.p1.y - sg.p0.y) / 10)) : 1;
      const segStart = L;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        let x, y;
        if (sg.q) {
          const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
          x = a * sg.p0.x + b * sg.c.x + d * sg.p1.x;
          y = a * sg.p0.y + b * sg.c.y + d * sg.p1.y;
        } else { x = sg.p0.x + (sg.p1.x - sg.p0.x) * t; y = sg.p0.y + (sg.p1.y - sg.p0.y) * t; }
        const last = poly[poly.length - 1];
        L += Math.hypot(x - last.x, y - last.y);
        poly.push({ x, y });
        cum.push(L);
      }
      if (sg.q && !passAt.has(sg.c)) passAt.set(sg.c, (segStart + L) / 2);
      if (!passAt.has(sg.p1)) passAt.set(sg.p1, L);
    }
    // node classification (smooth = circle, corner = square), font-editor style
    const real = pts.filter((p) => !p.implied);
    const nodes = real.map((p) => {
      const i = pts.indexOf(p);
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[(i + 1) % pts.length];
      let smooth = false;
      if (p.on) {
        const v1x = p.x - a.x, v1y = p.y - a.y, v2x = b.x - p.x, v2y = b.y - p.y;
        const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
        if (l1 > 0 && l2 > 0) {
          const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
          smooth = cos > 0.995;
        }
      }
      return { x: p.x, y: p.y, on: p.on, smooth, pass: (passAt.get(p) ?? 0) / L };
    });
    // control-polygon edges: any neighbour pair that involves an off-curve point
    const handles = [];
    for (let i = 0; i < real.length; i++) {
      const a = real[i], b = real[(i + 1) % real.length];
      if (!a.on || !b.on) {
        const pa = (passAt.get(a) ?? 0) / L, pb = (passAt.get(b) ?? 0) / L;
        handles.push({ a, b, pass: Math.max(pa, pb < pa ? 1 : pb) });
      }
    }
    return { poly, cum, len: L, nodes, handles };
  }

  // ---------- layout (logical px) ----------
  const WORD_W = 1180;
  const S = WORD_W / TOTAL; // px per font unit
  const WORD_CY = H / 2 - 12; // cap-height centre
  const MARGIN = 64;

  // ---------- timeline ----------
  const T = {
    hudIn: 0.1,
    guide0: 0.42, guideStep: 0.14, guideDur: 0.72,
    cell0: 0.98, cellStep: 0.036, cellDur: 0.34,
    num0: 1.02, numStep: 0.04, numDur: 0.42,
    trace0: 1.42, traceStep: 0.19, traceDur: 0.64,
    scan0: 3.72, scanDur: 1.02,
    box0: 4.92, boxDur: 0.3,
    tight0: 5.26, tightDur: 0.56,
    retract0: 5.96, retractDur: 0.46,
    move0: 6.22, moveDur: 0.66,
    type0: 6.98,
    outro: 9.46,
  };
  const SECTION_TIMES = [0.1, 1.32, 3.62, 4.88, 6.18];
  const GUIDES = [
    { y: CAP, num: String(CAP), name: 'Cap height' },
    { y: XH, num: String(XH), name: 'x-height' },
    { y: 0, num: '0', name: 'Baseline' },
  ];

  // Typing schedule for the tagline (deterministic jitter).
  const tagline = cfg.tagline;
  const keyTimes = [];
  {
    let t = T.type0;
    for (let i = 0; i < tagline.length; i++) {
      keyTimes.push(t);
      const ch = tagline[i];
      let dt = 0.052 + hash(i, 91) * 0.034;
      if (ch === ' ') dt += 0.03;
      if (',.'.includes(ch)) dt += 0.08;
      t += dt;
    }
  }
  const typeEnd = keyTimes[keyTimes.length - 1];

  // ---------- derived animation state ----------
  const tracking = cfg.tracking;
  const tightE = (t) => E.inOutQuint(inv(T.tight0, T.tight0 + T.tightDur, t));
  function wordGeom(t) {
    const k = tightE(t);
    const tw = TOTAL + tracking * k * (N - 1);
    const mv = E.inOutCubic(inv(T.move0, T.move0 + T.moveDur, t));
    const sc = lerp(1, 0.8, mv);
    const cy = WORD_CY - 92 * mv;
    return { k, tw, sc, cy, mv };
  }
  // font units -> logical px within word space (before camera)
  function place(t) {
    const w = wordGeom(t);
    const s = S * w.sc;
    const ox = W / 2 - (w.tw * s) / 2;
    const by = w.cy + (CAP * s) / 2;
    return { s, ox, by, w };
  }
  const glyphX = (i, k) => G[i].x0 + tracking * k * i;

  // ---------- text measuring ----------
  const mctx = document.createElement('canvas').getContext('2d');
  mctx.font = '400 40px GeistUI';
  const TAG_W = mctx.measureText(tagline).width;
  const tagPrefixW = (n) => mctx.measureText(tagline.slice(0, n)).width;

  // ---------- sound cue list ----------
  const events = [];
  const cue = (t, type, x = W / 2, extra = {}) => events.push({ t: +t.toFixed(4), type, pan: +((x / W) * 2 - 1).toFixed(3), ...extra });
  function scrambleCues(t0, dur, x, count, seed, gain = 0.5) {
    for (let i = 0; i < count; i++) cue(t0 + dur * (i / count) * 0.85 + hash(seed, i) * 0.02, 'tick', x, { gain, v: hash(seed, i + 50) });
  }
  {
    const p0 = place(0);
    // HUD in
    scrambleCues(T.hudIn, 0.42, 160, 7, 1, 0.45);
    scrambleCues(T.hudIn + 0.04, 0.42, W - 160, 7, 2, 0.45);
    // guides draw in from the left, land on the right
    GUIDES.forEach((g, i) => {
      const t = T.guide0 + i * T.guideStep;
      cue(t, 'click', MARGIN, { gain: 0.8, v: i / 3 });
      cue(t + T.guideDur * 0.92, 'tick', W - MARGIN, { gain: 0.35, v: 0.2 + i * 0.2 });
    });
    // cell dividers
    for (let i = 0; i <= N; i++) {
      const x = p0.ox + (i < N ? G[i].x0 : TOTAL) * p0.s;
      cue(T.cell0 + i * T.cellStep, 'tick', x, { gain: 0.42, v: 0.6 + (i / N) * 0.4 });
    }
    // node pops during outline trace
    G.forEach((gl, gi) => {
      const t0 = T.trace0 + gi * T.traceStep;
      cue(t0, 'click', p0.ox + gl.x0 * p0.s, { gain: 0.55, v: 0.1 });
      for (const c of gl.contours) {
        for (const nd of c.nodes) {
          if (!nd.on) continue;
          const t = t0 + traceTimeAt(nd.pass) * T.traceDur;
          cue(t, 'node', p0.ox + (gl.x0 + nd.x) * p0.s, { gain: 0.5, v: hash(gi * 97 + Math.round(nd.x), Math.round(nd.y)) });
        }
      }
    });
    // scan: glyph entry hits + scanner stream
    for (let gi = 0; gi < N; gi++) {
      const x = G[gi].x0;
      const t = scanTimeFor(x);
      cue(t, 'thock', p0.ox + x * p0.s, { gain: 0.7, v: gi / (N - 1) });
    }
    for (let t = T.scan0; t < T.scan0 + T.scanDur; t += 1 / 45) cue(t, 'scan', p0.ox + scanX(t) * p0.s, { gain: 0.16, v: hash(Math.round(t * 1000), 3) });
    cue(T.scan0 + T.scanDur + 0.02, 'ping', W / 2, { gain: 0.6, f: 880 });
    // boxes
    cue(T.box0, 'click', W / 2, { gain: 0.5, v: 0.5 });
    // tighten ratchet
    for (let i = 0; i < 14; i++) {
      const u = i / 13;
      cue(T.tight0 + T.tightDur * (0.08 + 0.84 * E.inOutCubic(u)), 'tick', lerp(W * 0.3, W * 0.7, u), { gain: 0.5, v: 1 - u });
    }
    cue(T.tight0 + T.tightDur, 'thock', W / 2, { gain: 0.45, v: 0.9 });
    cue(T.retract0, 'whoosh', W / 2, { gain: 0.2, dur: T.retractDur + 0.1, dir: 1 });
    cue(T.move0, 'whoosh', W / 2, { gain: 0.24, dur: T.moveDur + 0.15, dir: -1 });
    // typing
    const tx0 = W / 2 - TAG_W / 2;
    keyTimes.forEach((t, i) => {
      const x = tx0 + tagPrefixW(i + 1);
      cue(t, tagline[i] === ' ' ? 'space' : 'key', x, { gain: 0.6, v: hash(i, 17) });
    });
    cue(T.move0 + 0.3, 'pad', W / 2, { gain: 0.3, dur: typeEnd - T.move0 + 1.4 });
    cue(typeEnd + 0.16, 'ping', W / 2, { gain: 0.45, f: 1174.66 });
    // section label scrambles
    SECTION_TIMES.slice(1).forEach((t, i) => scrambleCues(t, 0.36, 140, 5, 30 + i, 0.32));
    scrambleCues(T.outro, 0.42, 140, 6, 60, 0.35);
    cue(T.outro + 0.1, 'sub', W / 2, { gain: 0.5, dur: DUR - T.outro });
  }
  events.sort((a, b) => a.t - b.t);

  // Pen progress along a contour: fraction of the trace window at which the
  // pen reaches arc-length fraction u (inverse of the easing used below).
  function traceTimeAt(u) {
    // trace uses inOutSine over time -> invert numerically
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (E.inOutSine(m) < u) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }
  function scanX(t) {
    const e = E.inOutCubic(inv(T.scan0, T.scan0 + T.scanDur, t));
    return lerp(-60, TOTAL + 60, e);
  }
  function scanTimeFor(x) {
    let lo = T.scan0, hi = T.scan0 + T.scanDur;
    for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (scanX(m) < x) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  // ---------- canvas ----------
  const canvas = document.getElementById('c');
  canvas.width = Math.round(W * SCALE);
  canvas.height = Math.round(H * SCALE);
  const ctx = canvas.getContext('2d');

  const SCR = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>';
  function scramble(from, to, t, t0, dur, seed) {
    if (t < t0) return from;
    if (t >= t0 + dur) return to;
    const len = Math.max(from.length, to.length);
    const tick = Math.floor(t * 40);
    let out = '';
    for (let i = 0; i < len; i++) {
      const r = hash(seed, i);
      const st = t0 + dur * 0.3 * (i / len);
      const settle = t0 + dur * Math.min(1, 0.35 + 0.55 * (i / len) + 0.1 * r);
      const target = to[i] ?? '';
      if (t < st) out += from[i] ?? '';
      else if (t >= settle) out += target;
      else if (target === ' ' || (from[i] === ' ' && target === '')) out += ' ';
      else out += SCR[Math.floor(hash(seed * 31 + i, tick) * SCR.length)];
    }
    return out.replace(/\s+$/, '');
  }
  function rollNumber(value, t, t0, dur, seed) {
    const s = String(value);
    if (t < t0) return '';
    if (t >= t0 + dur) return s;
    const tick = Math.floor(t * 40);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const settle = t0 + dur * (0.45 + 0.55 * ((i + 1) / s.length));
      out += t >= settle || !/\d/.test(s[i]) ? s[i] : String(Math.floor(hash(seed + i, tick) * 10));
    }
    return out;
  }

  function lineP(x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  function inkA(a) { return `rgba(11,11,12,${a})`; }

  // ---------- frame ----------
  function renderAt(t) {
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // slow camera push-in
    const cam = 1 + 0.045 * E.inOutSine(clamp(t / DUR));
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(cam, cam);
    ctx.translate(-W / 2, -H / 2);

    const P = place(t);
    const { s, ox, by } = P;
    const k = P.w.k;
    const X = (u) => ox + u * s;
    const Y = (u) => by - u * s;

    // ---- guides ----
    const retract = E.inOutCubic(inv(T.retract0, T.retract0 + T.retractDur, t));
    ctx.lineWidth = 1;
    GUIDES.forEach((g, i) => {
      const t0 = T.guide0 + i * T.guideStep;
      const d = E.inOutExpo(inv(t0, t0 + T.guideDur, t));
      if (d <= 0) return;
      const xa = lerp(MARGIN, W - MARGIN, retract), xb = lerp(MARGIN, W - MARGIN, d);
      if (xb - xa < 0.5) return;
      const y = Math.round(Y(g.y)) + 0.5;
      ctx.strokeStyle = inkA(0.55);
      lineP(xa, y, xb, y);
      const la = inv(t0 + 0.1, t0 + 0.3, t) * (1 - retract);
      if (la > 0) {
        ctx.fillStyle = inkA(0.7 * la);
        ctx.font = '500 13px GeistMonoUI';
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(scramble('', g.num, t, t0 + 0.08, 0.3, 11 + i), MARGIN, y - 7);
        ctx.font = '500 13px GeistUI';
        ctx.textAlign = 'right';
        ctx.fillText(scramble('', g.name, t, t0 + T.guideDur * 0.7, 0.34, 21 + i), W - MARGIN, y - 7);
      }
    });

    // ---- cells ----
    const boxE = E.inOutCubic(inv(T.box0, T.box0 + T.boxDur, t));
    const cellTop = CAP + 110, cellBot = -110;
    for (let i = 0; i <= N; i++) {
      const t0 = T.cell0 + i * T.cellStep;
      const d = E.outCubic(inv(t0, t0 + T.cellDur, t));
      if (d <= 0) continue;
      const u = i < N ? glyphX(i, k) : glyphX(N - 1, k) + G[N - 1].cellW;
      const x = Math.round(X(u)) + 0.5;
      const yt = Y(cellTop), yb = Y(cellBot);
      const mid = (yt + yb) / 2;
      const half = ((yb - yt) / 2) * d * (1 - retract);
      if (half < 0.5) continue;
      ctx.strokeStyle = inkA(0.38);
      lineP(x, mid - half, x, mid + half);
    }
    // top/bottom edges -> full boxes
    if (boxE > 0 && retract < 1) {
      const x0 = X(glyphX(0, k)), x1 = X(glyphX(N - 1, k) + G[N - 1].cellW);
      const cx = (x0 + x1) / 2, hw = ((x1 - x0) / 2) * boxE * (1 - retract);
      ctx.strokeStyle = inkA(0.38);
      for (const u of [cellTop, cellBot]) { const y = Math.round(Y(u)) + 0.5; lineP(cx - hw, y, cx + hw, y); }
    }
    // advance numbers
    for (let i = 0; i < N; i++) {
      const t0 = T.num0 + i * T.numStep;
      if (t < t0 || retract >= 1) continue;
      const w = G[i].cellW + (i < N - 1 ? tracking * k : 0);
      const tightRolling = t >= T.tight0 && t < T.tight0 + T.tightDur;
      let str = rollNumber(G[i].cellW, t, t0, T.numDur, 200 + i * 7);
      if (t >= T.tight0) str = tightRolling ? String(Math.round(w)) : String(Math.round(w));
      const cx = X(glyphX(i, k) + w / 2);
      ctx.fillStyle = inkA(0.72 * (1 - retract));
      ctx.font = '500 13px GeistMonoUI';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(str, cx, Y(cellTop) - 10);
    }

    // ---- glyph outlines / nodes / fills ----
    const sx = t >= T.scan0 ? scanX(t) : -1e9; // scan position in word units (tight k is 0 here)
    for (let gi = 0; gi < N; gi++) {
      const gl = G[gi];
      const gx = glyphX(gi, k);
      const t0 = T.trace0 + gi * T.traceStep;
      const prog = E.inOutSine(inv(t0, t0 + T.traceDur, t));
      if (prog <= 0) continue;
      const clipX = X(gx + (sx - gx)); // screen x of the scan line
      const scanning = t >= T.scan0;

      // fill (left of scan line)
      if (scanning) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(-10, -10, Math.max(-10, X(sx) + 10), H + 20);
        ctx.clip();
        ctx.fillStyle = INK;
        ctx.beginPath();
        for (const c of gl.contours) {
          c.poly.forEach((p, j) => (j ? ctx.lineTo(X(gx + p.x), Y(p.y)) : ctx.moveTo(X(gx + p.x), Y(p.y))));
          ctx.closePath();
        }
        ctx.fill('nonzero');
        ctx.restore();
      }

      // construction layer (right of scan line)
      ctx.save();
      if (scanning) { ctx.beginPath(); ctx.rect(X(sx), -10, W * 2, H + 20); ctx.clip(); }
      for (const c of gl.contours) {
        const L = c.len * prog;
        // handles (control polygon)
        ctx.lineWidth = 0.8;
        for (const h of c.handles) {
          const a = inv(t0 + traceTimeAt(h.pass) * T.traceDur, t0 + traceTimeAt(h.pass) * T.traceDur + 0.14, t);
          if (a <= 0) continue;
          ctx.strokeStyle = inkA(0.4 * a);
          lineP(X(gx + h.a.x), Y(h.a.y), X(gx + h.b.x), Y(h.b.y));
        }
        // outline trace
        ctx.lineWidth = 1.35;
        ctx.strokeStyle = INK;
        ctx.beginPath();
        let hx = 0, hy = 0;
        for (let j = 0; j < c.poly.length; j++) {
          const p = c.poly[j];
          if (c.cum[j] <= L) {
            j ? ctx.lineTo(X(gx + p.x), Y(p.y)) : ctx.moveTo(X(gx + p.x), Y(p.y));
            hx = p.x; hy = p.y;
          } else {
            const q = c.poly[j - 1];
            const f = (L - c.cum[j - 1]) / (c.cum[j] - c.cum[j - 1]);
            hx = lerp(q.x, p.x, f); hy = lerp(q.y, p.y, f);
            ctx.lineTo(X(gx + hx), Y(hy));
            break;
          }
        }
        if (prog >= 1) ctx.closePath();
        ctx.stroke();
        // pen head
        if (prog > 0 && prog < 1) {
          ctx.fillStyle = INK;
          ctx.beginPath(); ctx.arc(X(gx + hx), Y(hy), 4.2, 0, Math.PI * 2); ctx.fill();
        }
        // nodes
        for (const nd of c.nodes) {
          const tn = t0 + traceTimeAt(nd.pass) * T.traceDur;
          const a = inv(tn, tn + 0.22, t);
          if (a <= 0) continue;
          const px = X(gx + nd.x), py = Y(nd.y);
          if (nd.on) {
            const r = 5.6 * E.outBack(a);
            ctx.fillStyle = BG; ctx.strokeStyle = INK; ctx.lineWidth = 1.2;
            ctx.beginPath();
            if (nd.smooth) ctx.arc(px, py, r, 0, Math.PI * 2);
            else ctx.rect(px - r * 0.9, py - r * 0.9, r * 1.8, r * 1.8);
            ctx.fill(); ctx.stroke();
          } else {
            ctx.fillStyle = inkA(0.75);
            ctx.beginPath(); ctx.arc(px, py, 2.5 * E.outBack(a), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      ctx.restore();
      void clipX;
    }

    // ---- scan bar ----
    if (t >= T.scan0 && t <= T.scan0 + T.scanDur + 0.18) {
      const fade = 1 - inv(T.scan0 + T.scanDur, T.scan0 + T.scanDur + 0.18, t);
      const x = Math.round(X(sx)) + 0.5;
      ctx.strokeStyle = inkA(0.9 * fade);
      ctx.lineWidth = 1;
      lineP(x, Y(cellTop + 40), x, Y(cellBot - 40));
      ctx.fillStyle = inkA(fade);
      for (const u of [CAP, 0]) { const y = Y(u); ctx.fillRect(x - 3.5, y - 3.5, 7, 7); }
      ctx.font = '500 13px GeistMonoUI';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`x ${Math.max(0, Math.min(TOTAL, Math.round(sx))).toString().padStart(4, '0')}`, x + 8, Y(cellTop + 40) + 14);
    }

    // ---- tagline ----
    if (t >= T.type0 - 0.3) {
      const shown = keyTimes.filter((kt) => kt <= t).length;
      ctx.font = '400 40px GeistUI';
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      const x0 = W / 2 - TAG_W / 2;
      const yb = P.by + 128;
      ctx.fillStyle = INK;
      const str = tagline.slice(0, shown);
      ctx.fillText(str, x0, yb);
      // caret: solid while typing, blinks when idle
      const cw = tagPrefixW(shown);
      const lastKey = shown ? keyTimes[shown - 1] : T.type0;
      const idle = t - lastKey;
      const blinkOn = t < T.type0 ? Math.floor((t - (T.type0 - 0.3)) * 4) % 2 === 0 : idle < 0.12 || Math.floor((idle - 0.12) / 0.42) % 2 === 1;
      const caretFade = 1 - inv(T.outro + 0.2, T.outro + 0.5, t);
      if (blinkOn && caretFade > 0) {
        ctx.fillStyle = inkA(caretFade);
        ctx.fillRect(x0 + cw + 4, yb - 34, 2.5, 44);
      }
    }
    ctx.restore(); // camera

    drawHud(t);
    const fadeOut = inv(DUR - 0.35, DUR, t);
    if (fadeOut > 0) { ctx.fillStyle = BG; ctx.globalAlpha = E.inCubic(fadeOut); ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
  }

  function drawHud(t) {
    const hudIn = T.hudIn;
    const m = MARGIN - 8;
    ctx.textBaseline = 'top';
    // top-left
    ctx.textAlign = 'left';
    ctx.font = '500 15px GeistUI';
    ctx.fillStyle = INK;
    ctx.fillText(scramble('', cfg.hud.title[0], t, hudIn, 0.42, 1), m, m - 6);
    ctx.fillStyle = inkA(0.55);
    ctx.fillText(scramble('', cfg.hud.title[1], t, hudIn + 0.06, 0.5, 2), m, m + 14);
    // top-right: timecode
    ctx.textAlign = 'right';
    const f = Math.floor(t * FPS + 1e-6);
    const tc = `00:00:${String(Math.floor(f / FPS)).padStart(2, '0')}:${String(f % FPS).padStart(2, '0')}`;
    ctx.font = '500 15px GeistMonoUI';
    ctx.fillStyle = INK;
    ctx.fillText(scramble('', tc, t, hudIn + 0.04, 0.38, 3), W - m, m - 6);
    ctx.font = '500 15px GeistUI';
    ctx.fillStyle = inkA(0.55);
    ctx.fillText(scramble('', `${W} × ${H} · ${FPS}p`, t, hudIn + 0.1, 0.46, 4), W - m, m + 14);
    // bottom-left: section
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    let sec = '';
    const secs = cfg.sections;
    let cur = '';
    for (let i = 0; i < SECTION_TIMES.length; i++) {
      if (t >= SECTION_TIMES[i]) { sec = scramble(cur, secs[i], t, SECTION_TIMES[i], 0.36, 40 + i); cur = secs[i]; }
    }
    if (t >= T.outro) sec = scramble(secs[secs.length - 1], cfg.outro, t, T.outro, 0.42, 70);
    ctx.font = '500 15px GeistUI';
    ctx.fillStyle = INK;
    ctx.fillText(sec, m, H - m + 6);
    // bottom-right: credit
    ctx.textAlign = 'right';
    ctx.fillStyle = INK;
    ctx.fillText(scramble('', cfg.hud.credit[0], t, hudIn + 0.08, 0.44, 5), W - m, H - m - 14);
    ctx.fillStyle = inkA(0.55);
    ctx.fillText(scramble('', cfg.hud.credit[1], t, hudIn + 0.12, 0.5, 6), W - m, H - m + 6);
  }

  window.SCENE = { W, H, FPS, DUR, SCALE, events, renderAt, ready: true };
  renderAt(0);

  // ---------- live preview ----------
  if (MODE !== 'render') {
    const audio = document.getElementById('a');
    const bar = document.getElementById('bar');
    const time = document.getElementById('time');
    let playing = false, t0 = 0, offset = 0;
    const now = () => (playing ? (audio && !audio.paused && audio.readyState >= 2 ? audio.currentTime : offset + (performance.now() - t0) / 1000) : offset);
    function loop() {
      let t = now();
      if (t >= DUR) { playing = false; offset = 0; t = 0; audio && audio.pause(); }
      renderAt(t);
      bar.value = String(t / DUR);
      time.textContent = t.toFixed(2) + 's';
      requestAnimationFrame(loop);
    }
    function toggle() {
      if (playing) { offset = now(); playing = false; audio && audio.pause(); }
      else { playing = true; t0 = performance.now(); if (audio) { audio.currentTime = offset; audio.play().catch(() => {}); } }
    }
    document.getElementById('play').onclick = toggle;
    canvas.onclick = toggle;
    bar.oninput = () => { offset = parseFloat(bar.value) * DUR; t0 = performance.now(); if (audio) audio.currentTime = offset; };
    window.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); toggle(); } });
    loop();
  }
})();
