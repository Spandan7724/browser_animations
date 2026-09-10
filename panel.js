/* Shared engine for the panel pieces.
 *
 * Each piece supplies a field: a function returning a value in 0..1 for a cell
 * at a given time. The engine owns everything else: the cell grid, the atlas,
 * the frame loop, and the pointer.
 *
 * Loaded as a classic script so the pieces work straight off the filesystem.
 */
(() => {
  'use strict';

  const DEFAULTS = {
    rows: 20,
    pitchX: 13, pitchY: 11,     // cell box plus its gutter
    cellW: 10, cellH: 8, radius: 2,
    maxWidth: 720, minCols: 12,
    loop: 24,                   // seconds; fields are written to repeat on it
    levels: 96,
    // Value drives the slab's size and its alpha at once. That pairing is what
    // gives a panel its texture; alpha alone stays flat.
    scaleMin: 0.24, scaleExp: 0.65,
    alphaMin: 0.09, alphaExp: 1,
    tint: 230, tintHot: 255,
    wakeInterval: 0.09,         // seconds between impulses while dragging
    wakeStrength: 0.34,
    pressStrength: 1,
    impulseLife: 5,             // seconds before an impulse is forgotten
  };

  const clamp01 = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
  const smoothstep = (e0, e1, x) => {
    const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
    return t * t * (3 - 2 * t);
  };

  function create(spec) {
    const s = Object.assign({}, DEFAULTS, spec);
    const canvas = typeof s.canvas === 'string'
      ? document.getElementById(s.canvas)
      : (s.canvas || document.querySelector('canvas'));
    const ctx = canvas.getContext('2d', { alpha: false });

    let ratio = 1, cols = 0, pxX = 0, pxY = 0, atlas = null;

    // The field's view of the world. Pieces hang their own state off this.
    const g = {
      cols: 0, rows: s.rows, loop: s.loop,
      pitchX: s.pitchX, pitchY: s.pitchY,
      now: 0,
      pointer: { active: false, x: 0, y: 0 },
      impulses: [],
      smoothstep, clamp01,
    };

    function buildAtlas() {
      const a = document.createElement('canvas');
      a.width = s.levels * pxX;
      a.height = pxY;
      const q = a.getContext('2d');
      const rounded = typeof q.roundRect === 'function';

      for (let i = 0; i < s.levels; i += 1) {
        const u = i / (s.levels - 1);
        const scale = s.scaleMin + (1 - s.scaleMin) * Math.pow(u, s.scaleExp);
        const w = s.cellW * ratio * scale;
        const h = s.cellH * ratio * scale;
        const x = i * pxX + (pxX - w) / 2;
        const y = (pxY - h) / 2;
        // The top of the range runs to pure white so the brightest cells
        // separate from the merely bright ones under them.
        const tint = Math.round(s.tint + (s.tintHot - s.tint) * smoothstep(0.88, 1, u));
        q.fillStyle = `rgba(${tint},${tint},${tint},${(s.alphaMin + (1 - s.alphaMin) * Math.pow(u, s.alphaExp)).toFixed(3)})`;
        if (rounded) {
          q.beginPath();
          q.roundRect(x, y, w, h, s.radius * ratio * Math.min(1, scale * 1.4));
          q.fill();
        } else {
          q.fillRect(x, y, w, h);
        }
      }
      return a;
    }

    function layout() {
      ratio = Math.min(2, window.devicePixelRatio || 1);
      const avail = Math.min(s.maxWidth, Math.max(160, window.innerWidth - 48));
      cols = Math.max(s.minCols, Math.floor((avail + (s.pitchX - s.cellW)) / s.pitchX));

      const cssW = cols * s.pitchX - (s.pitchX - s.cellW);
      const cssH = s.rows * s.pitchY - (s.pitchY - s.cellH);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * ratio);
      canvas.height = Math.round(cssH * ratio);

      pxX = Math.round(s.pitchX * ratio);
      pxY = Math.round(s.pitchY * ratio);
      atlas = buildAtlas();
      ctx.imageSmoothingEnabled = false;

      g.cols = cols;
      if (s.init) s.init(g);
    }

    // ---- pointer -----------------------------------------------------
    function at(e) {
      const box = canvas.getBoundingClientRect();
      return { x: (e.clientX - box.left) / s.pitchX, y: (e.clientY - box.top) / s.pitchY };
    }
    let lastWake = 0;

    canvas.addEventListener('pointermove', (e) => {
      const p = at(e);
      g.pointer.active = true;
      g.pointer.x = p.x;
      g.pointer.y = p.y;
      const now = performance.now() / 1000;
      if (now - lastWake < s.wakeInterval) return;
      lastWake = now;
      g.impulses.push({ x: p.x, y: p.y, t0: now, strength: s.wakeStrength });
    }, { passive: true });

    canvas.addEventListener('pointerdown', (e) => {
      const p = at(e);
      g.impulses.push({ x: p.x, y: p.y, t0: performance.now() / 1000, strength: s.pressStrength });
    }, { passive: true });

    const drop = () => { g.pointer.active = false; };
    canvas.addEventListener('pointerleave', drop, { passive: true });
    canvas.addEventListener('pointercancel', drop, { passive: true });

    // ---- frame -------------------------------------------------------
    function render(nowMs) {
      const now = nowMs / 1000;
      const t = now % s.loop;
      g.now = now;

      for (let i = g.impulses.length - 1; i >= 0; i -= 1) {
        if (now - g.impulses[i].t0 > s.impulseLife) g.impulses.splice(i, 1);
      }
      if (s.frame) s.frame(g, t);

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const value = s.value;
      for (let r = 0; r < s.rows; r += 1) {
        const y = r * pxY;
        if (s.row) s.row(g, r, t);
        for (let c = 0; c < cols; c += 1) {
          const u = clamp01(value(g, c, r, t));
          const lvl = u >= 1 ? s.levels - 1 : (u * (s.levels - 1)) | 0;
          ctx.drawImage(atlas, lvl * pxX, 0, pxX, pxY, c * pxX, y, pxX, pxY);
        }
      }
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, onScreen = true;

    const tick = (now) => { render(now); frame = requestAnimationFrame(tick); };
    const sync = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (reduced.matches) { render(0); return; }
      if (onScreen && !document.hidden) frame = requestAnimationFrame(tick);
    };

    layout();
    new IntersectionObserver((es) => {
      onScreen = es.some((e) => e.isIntersecting);
      sync();
    }).observe(canvas);
    document.addEventListener('visibilitychange', sync);
    reduced.addEventListener('change', sync);
    window.addEventListener('resize', () => {
      layout();
      if (reduced.matches || document.hidden || !onScreen) render(0);
    });
    sync();

    return g;
  }

  window.Panel = { create, smoothstep, clamp01 };
})();
