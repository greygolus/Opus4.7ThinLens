(function(){
  const svg = document.getElementById('svg');
  const bench = document.getElementById('bench');
  const lensPanel = document.getElementById('lensPanel');
  const aperturePanel = document.getElementById('aperturePanel');
  const mediaPanel = document.getElementById('mediaPanel');
  const metricsEl = document.getElementById('metrics');
  const pupilsEl = document.getElementById('pupilsSection');
  const imageStatus = document.getElementById('imageStatus');
  const stopStatus = document.getElementById('stopStatus');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const MEDIA_PRESETS = {
    air:       { name: 'Air',       n: 1.000 },
    water:     { name: 'Water',     n: 1.333 },
    crown:     { name: 'Crown glass', n: 1.517 },
    flint:     { name: 'Flint glass', n: 1.620 },
    oil:       { name: 'Imm. oil',  n: 1.515 },
    fused:     { name: 'Fused silica', n: 1.458 },
    custom:    { name: 'Custom',    n: null }
  };

  const DEFAULT_STATE = () => ({
    object: { x: -7, h: 2, mode: 'finite', angle: 5 }, // angle in degrees when at infinity
    lenses: [
      { id: 1, x: 0, f: 5, color: '#378ADD', diameter: 6 },
      { id: 2, x: 9, f: -4, color: '#D85A30', diameter: 5 }
    ],
    apertures: [
      { id: 10, x: 4, diameter: 2.4, color: '#BA7517' }
    ],
    // media segments: indexed by position in sorted element list.
    // segments[0] is the medium to the LEFT of the first element (object side).
    // segments[i] for i>=1 is the medium between element i-1 and element i.
    // segments[N] is the medium to the RIGHT of the last element (image side).
    // We store them keyed by a structural key so they persist across reorderings.
    segments: { object: 1.0, image: 1.0, between: {} },  // between: { 'id1-id2': n }
    nextId: 100
  });

  const state = {
    W: 0, H: 0, axisY: 0, scale: 45,
    ...DEFAULT_STATE(),
    showMarginal: true, showChief: true, showParallel: true, showRimRays: true,
    showVirtual: true, showPupils: true, showGrid: true, showFocals: true,
    shiftHeld: false
  };

  const COLORS = ['#378ADD', '#D85A30', '#1D9E75', '#D4537E', '#BA7517', '#534AB7', '#888780', '#E24B4A', '#0F6E56', '#993C1D'];

  function resize() {
    const rect = bench.getBoundingClientRect();
    state.W = rect.width; state.H = rect.height;
    state.axisY = state.H / 2;
    svg.setAttribute('viewBox', `0 0 ${state.W} ${state.H}`);
    renderSvg();
  }
  function worldToScreen(x, y) {
    return { sx: state.W / 2 + x * state.scale, sy: state.axisY - y * state.scale };
  }
  function screenToWorldX(sx) { return (sx - state.W / 2) / state.scale; }
  function screenToWorldY(sy) { return (state.axisY - sy) / state.scale; }
  function makeEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // ============== Core paraxial model ==============
  // All elements (lenses and apertures) sorted by x.
  // Each lens has power P = 1/f (where f is given assuming air).
  // In a medium, thin lens equation: n_out/v - n_in/u = P
  // where u is signed object-to-lens distance (u = x_obj - x_lens, negative if obj left of lens).
  // v is signed image distance from lens.
  // Reduced slope notation: u_reduced = n * angle. Ray transfer in a medium of index n:
  //   translation by distance t: new_y = y + t*angle_absolute = y + (t/n)*u_reduced
  // But for simplicity we keep: y transforms by translate, angle transforms by refract.
  // At lens: y' = y, n_out*angle_out = n_in*angle_in - y*P

  function getSortedElements() {
    const elems = [
      ...state.lenses.map(l => ({ ...l, kind: 'lens' })),
      ...state.apertures.map(a => ({ ...a, kind: 'aperture' }))
    ];
    elems.sort((a, b) => a.x - b.x);
    return elems;
  }

  function segmentKey(a, b) { return a.id + '-' + b.id; }

  // Get the index of refraction in the segment immediately to the LEFT of element at index i (in sorted list).
  function mediumLeftOf(i, sorted) {
    if (i === 0) return state.segments.object ?? 1.0;
    const prev = sorted[i-1], cur = sorted[i];
    const k = segmentKey(prev, cur);
    return state.segments.between[k] ?? 1.0;
  }
  function mediumRightOf(i, sorted) {
    if (i === sorted.length - 1) return state.segments.image ?? 1.0;
    const cur = sorted[i], next = sorted[i+1];
    const k = segmentKey(cur, next);
    return state.segments.between[k] ?? 1.0;
  }

  // ============== Ray tracing ==============
  // Ray defined by (y, u) where u = n * angle (reduced slope).
  // In a segment of index n, actual geometric slope = u/n.
  // Translation through distance t changes y by t*(u/n), u unchanged.
  // At a thin lens with power P: y unchanged, u' = u - y*P.
  // At an aperture: y unchanged, u unchanged. (Aperture only clips; doesn't refract.)

  function traceRay(x0, y0, slopeGeom, n0) {
    // slopeGeom is the geometric slope in the first segment.
    // We convert to reduced slope u = n0 * slopeGeom for the trace.
    const sorted = getSortedElements();
    const pts = [{ x: x0, y: y0, ...worldToScreen(x0, y0) }];
    let x = x0, y = y0;
    let u = n0 * slopeGeom; // reduced slope
    let n = n0;
    // step into any elements to the right of x0
    const firstIdx = sorted.findIndex(e => e.x > x0 + 1e-9);
    if (firstIdx === -1) {
      // propagate to right edge
      const rightEdge = screenToWorldX(state.W + 80);
      const yEnd = y + (u/n) * (rightEdge - x);
      pts.push({ x: rightEdge, y: yEnd, ...worldToScreen(rightEdge, yEnd) });
      return { pts, finalX: x, finalY: y, finalSlope: u/n };
    }
    for (let i = firstIdx; i < sorted.length; i++) {
      const el = sorted[i];
      // geometric slope in current segment is u/n
      const yAtEl = y + (u/n) * (el.x - x);
      pts.push({ x: el.x, y: yAtEl, ...worldToScreen(el.x, yAtEl) });
      y = yAtEl; x = el.x;
      if (el.kind === 'lens') {
        const nLeft = mediumLeftOf(i, sorted);
        const nRight = mediumRightOf(i, sorted);
        // u_in = n_left * angle_in. After lens: n_right * angle_out = n_left * angle_in - y * P
        // but we track reduced slope u relative to CURRENT medium.
        // Incoming: u_in = n_left * angle_in (so angle_in = u_in/n_left, we have u = n*angle where n was the last medium).
        // Actually since we've been tracking u with the medium we're currently in, at the lens boundary:
        //   angle_in_absolute = u / n (where n is the segment index before the lens; this equals nLeft)
        //   angle_out_absolute = (n_left*angle_in - y*P) / n_right = (u - y*P) / n_right
        // New reduced slope (in medium nRight): u_new = n_right * angle_out_absolute = u - y*P
        const P = 1 / el.f;
        u = u - y * P;
        n = nRight;
      } else if (el.kind === 'aperture') {
        // Index stays the same across an aperture; medium is defined on either side.
        // If the segment index before and after differ... our model says apertures don't change medium.
        // To keep it simple: apertures are placed in existing segments. Medium is continuous through them.
        const nLeft = mediumLeftOf(i, sorted);
        const nRight = mediumRightOf(i, sorted);
        // If the two sides disagree, we average or use left -> right as a soft transition.
        // We handle it as: pretend the medium changes at the aperture, reduced slope re-scaled.
        if (Math.abs(nLeft - nRight) > 1e-9) {
          // u currently is n_left * angle; new u = n_right * (u / n_left)
          u = u * (nRight / nLeft);
          n = nRight;
        }
      }
    }
    const rightEdge = screenToWorldX(state.W + 80);
    const yEnd = y + (u/n) * (rightEdge - x);
    pts.push({ x: rightEdge, y: yEnd, ...worldToScreen(rightEdge, yEnd) });
    return { pts, finalX: x, finalY: y, finalSlope: u/n };
  }

  // ============== Imaging through sequence ==============
  // Image an object point (xo, ho) forward through lenses only (apertures skip).
  // Returns array of intermediate {x, h, m} after each lens, in sorted order.
  function imageCascade(xo, ho, stopAtElIdx = -1) {
    const sorted = getSortedElements();
    let curX = xo, curH = ho;
    const cascade = [];
    let n_cur = state.segments.object ?? 1.0;
    for (let i = 0; i < sorted.length; i++) {
      if (stopAtElIdx >= 0 && i > stopAtElIdx) break;
      const el = sorted[i];
      if (el.kind !== 'lens') {
        cascade.push({ elIdx: i, type: 'aperture', x: curX, h: curH, m: 1 });
        continue;
      }
      const nLeft = mediumLeftOf(i, sorted);
      const nRight = mediumRightOf(i, sorted);
      // n_right / v - n_left / u = P ; with u = curX - el.x (signed)
      const u = curX - el.x;
      if (Math.abs(u) < 1e-9) {
        cascade.push({ elIdx: i, type: 'lens', atInfinity: false, x: el.x, h: curH, m: 1 });
        curX = el.x; n_cur = nRight;
        continue;
      }
      const P = 1 / el.f;
      const invV_coeff = P + nLeft / u; // = n_right / v
      if (Math.abs(invV_coeff) < 1e-9) {
        cascade.push({ elIdx: i, type: 'lens', atInfinity: true, x: el.x + 1e6, h: 1e6, m: 1e6 });
        break;
      }
      const v = nRight / invV_coeff;
      // lateral magnification for thin lens in media: m = (n_left * v) / (n_right * u)
      const m = (nLeft * v) / (nRight * u);
      const newX = el.x + v;
      const newH = curH * m;
      cascade.push({ elIdx: i, type: 'lens', atInfinity: false, x: newX, h: newH, m });
      curX = newX; curH = newH; n_cur = nRight;
    }
    return { sorted, cascade };
  }

  // Image an object point (xo, ho) BACKWARD through all lenses to the left of a given element index (exclusive),
  // starting from just to the left of element at idxStart, going leftward.
  // Used for imaging an aperture into object space.
  // We simulate by reversing the system: the aperture at x=el.x with some "object" lives in that space.
  // To image an aperture BACKWARD through lens k, we treat the aperture as an object for lens k (from its image side),
  // and find where its "object" would be. That's just swap u <-> v with sign adjustments.
  // Cleaner: reverse ray direction. In reverse, each lens still has the same power but signs flip for u,v.
  // Implementation: we image (x,h) one lens at a time leftward, treating the aperture as a virtual object on the image side.
  function imageBackwardToObjectSpace(apIdx) {
    const sorted = getSortedElements();
    const ap = sorted[apIdx];
    let curX = ap.x, curH = ap.diameter / 2; // image the radius
    // The image-side medium at the aperture is mediumRightOf(apIdx-1) = mediumLeftOf(apIdx).
    // Wait — aperture lives "in" a segment; left medium and right medium might differ only if there's an explicit rule.
    // For imaging through lenses to the left, we just walk backward.
    for (let i = apIdx - 1; i >= 0; i--) {
      const el = sorted[i];
      if (el.kind !== 'lens') continue;
      const nLeft = mediumLeftOf(i, sorted);
      const nRight = mediumRightOf(i, sorted);
      // Current position (curX, curH) is on the RIGHT side of lens i (image side).
      // Use n_right/v - n_left/u = P with v = curX - el.x (signed distance from lens to image point).
      // Solve for u: n_left/u = n_right/v - P  =>  u = n_left / (n_right/v - P)
      const v = curX - el.x;
      if (Math.abs(v) < 1e-9) { curX = el.x; continue; }
      const P = 1/el.f;
      const invU = (nRight / v) - P;
      if (Math.abs(invU) < 1e-9) {
        // object at infinity on the left
        return { x: -Infinity, h: curH, atInfinity: true };
      }
      const u = nLeft / invU;
      // magnification forward m = (n_left*v)/(n_right*u); inverse (backward): h_back = h_forward / m
      const m = (nLeft * v) / (nRight * u);
      curH = curH / m;
      curX = el.x + u;
    }
    return { x: curX, h: curH, atInfinity: false };
  }

  // Image aperture FORWARD to image space (through all lenses to its right).
  function imageForwardToImageSpace(apIdx) {
    const sorted = getSortedElements();
    const ap = sorted[apIdx];
    let curX = ap.x, curH = ap.diameter / 2;
    for (let i = apIdx + 1; i < sorted.length; i++) {
      const el = sorted[i];
      if (el.kind !== 'lens') continue;
      const nLeft = mediumLeftOf(i, sorted);
      const nRight = mediumRightOf(i, sorted);
      const u = curX - el.x;
      if (Math.abs(u) < 1e-9) { curX = el.x; continue; }
      const P = 1/el.f;
      const invV = (nLeft / u) + P;
      if (Math.abs(invV) < 1e-9) {
        return { x: Infinity, h: curH, atInfinity: true };
      }
      const v = nRight / invV;
      const m = (nLeft * v) / (nRight * u);
      curH = curH * m;
      curX = el.x + v;
    }
    return { x: curX, h: curH, atInfinity: false };
  }

  // ============== Stop and pupil analysis ==============
  function analyzeStop() {
    const sorted = getSortedElements();
    const apertures = sorted.map((el, i) => ({ el, i }))
                            .filter(e => e.el.kind === 'aperture' || e.el.kind === 'lens');
    // Every aperture is a candidate stop. Lenses also have diameters and could be the stop,
    // but for clarity we'll only treat explicit apertures as stop candidates. Lens apertures could be added later.
    const candidates = sorted.map((el, i) => ({ el, i }))
                             .filter(c => c.el.kind === 'aperture');
    if (candidates.length === 0) return { stop: null, entrance: null, exit: null, stopIdx: -1 };

    // Image each candidate back to object space, compute tan(half-angle) from object point to that image's edge.
    const objX = state.object.mode === 'infinity' ? -Infinity : state.object.x;
    let bestIdx = -1, bestMetric = Infinity;
    const pupilImages = candidates.map(c => {
      const objSide = imageBackwardToObjectSpace(c.i);
      return { c, objSide };
    });
    pupilImages.forEach(p => {
      if (state.object.mode === 'infinity') {
        // pick smallest pupil radius in object space
        if (p.objSide.atInfinity) return;
        const r = Math.abs(p.objSide.h);
        if (r < bestMetric) { bestMetric = r; bestIdx = p.c.i; }
      } else {
        // finite object: tan(u_max) = radius / distance
        if (p.objSide.atInfinity) return;
        const dist = p.objSide.x - objX;
        if (Math.abs(dist) < 1e-9) return;
        const tanU = Math.abs(p.objSide.h / dist);
        if (tanU < bestMetric) { bestMetric = tanU; bestIdx = p.c.i; }
      }
    });
    if (bestIdx < 0) return { stop: null, entrance: null, exit: null, stopIdx: -1 };
    const stop = sorted[bestIdx];
    const entrance = imageBackwardToObjectSpace(bestIdx);
    const exit = imageForwardToImageSpace(bestIdx);
    return { stop, entrance, exit, stopIdx: bestIdx, pupilImages };
  }

  // ============== Rendering ==============
  function renderGrid(g) {
    if (!state.showGrid) return;
    const startX = screenToWorldX(0), endX = screenToWorldX(state.W);
    const startY = screenToWorldY(state.H), endY = screenToWorldY(0);
    for (let i = Math.ceil(startX); i <= Math.floor(endX); i++) {
      if (i === 0) continue;
      const { sx } = worldToScreen(i, 0);
      g.appendChild(makeEl('line', {
        x1: sx, x2: sx, y1: 0, y2: state.H,
        stroke: 'var(--border)',
        'stroke-width': i % 5 === 0 ? 0.8 : 0.4,
        opacity: i % 5 === 0 ? 0.55 : 0.3
      }));
    }
    for (let j = Math.ceil(startY); j <= Math.floor(endY); j++) {
      if (j === 0) continue;
      const { sy } = worldToScreen(0, j);
      g.appendChild(makeEl('line', {
        x1: 0, x2: state.W, y1: sy, y2: sy,
        stroke: 'var(--border)',
        'stroke-width': j % 5 === 0 ? 0.8 : 0.4,
        opacity: j % 5 === 0 ? 0.55 : 0.3
      }));
    }
  }

  function renderMediaBackgrounds(g) {
    // Shade each segment according to its medium if n != 1.
    const sorted = getSortedElements();
    const edges = [-50, ...sorted.map(e => e.x), 50];
    // Draw from segment 0 to segment N
    // Segment 0: left of first element (object side)
    // Segment k (k=1..N-1): between element k-1 and k
    // Segment N: right of last element (image side)
    const segments = [];
    if (sorted.length === 0) {
      segments.push({ x0: -50, x1: 50, n: state.segments.object ?? 1 });
    } else {
      segments.push({ x0: -50, x1: sorted[0].x, n: state.segments.object ?? 1 });
      for (let i = 1; i < sorted.length; i++) {
        const k = segmentKey(sorted[i-1], sorted[i]);
        segments.push({ x0: sorted[i-1].x, x1: sorted[i].x, n: state.segments.between[k] ?? 1 });
      }
      segments.push({ x0: sorted[sorted.length-1].x, x1: 50, n: state.segments.image ?? 1 });
    }
    segments.forEach(s => {
      if (Math.abs(s.n - 1) < 1e-6) return;
      const { sx: sx0 } = worldToScreen(s.x0, 0);
      const { sx: sx1 } = worldToScreen(s.x1, 0);
      // color tint based on n: higher n -> more blue
      const tint = Math.min((s.n - 1) / 0.8, 1);
      const opacity = 0.08 + 0.12 * tint;
      g.appendChild(makeEl('rect', {
        x: Math.min(sx0, sx1), y: 0,
        width: Math.abs(sx1 - sx0), height: state.H,
        fill: '#378ADD', opacity
      }));
      // label with n value near top
      const cx = (sx0 + sx1) / 2;
      const bg = makeEl('rect', {
        x: cx - 32, y: 6, width: 64, height: 18,
        rx: 9, fill: 'var(--bg-surface)', opacity: 0.85,
        stroke: 'var(--border)', 'stroke-width': 0.5
      });
      g.appendChild(bg);
      const t = makeEl('text', {
        x: cx, y: 18, 'text-anchor': 'middle',
        'font-size': 11, fill: 'var(--text-secondary)',
        'font-family': 'ui-monospace, monospace'
      });
      t.textContent = 'n = ' + s.n.toFixed(3);
      g.appendChild(t);
    });
  }

  function renderAxis(g) {
    g.appendChild(makeEl('line', {
      x1: 6, y1: state.axisY, x2: state.W - 6, y2: state.axisY,
      stroke: 'var(--border-strong)', 'stroke-width': 1, 'stroke-dasharray': '5 4'
    }));
    const startX = screenToWorldX(10), endX = screenToWorldX(state.W - 10);
    for (let i = Math.ceil(startX); i <= Math.floor(endX); i++) {
      if (i === 0) continue;
      const { sx } = worldToScreen(i, 0);
      const big = i % 5 === 0;
      g.appendChild(makeEl('line', {
        x1: sx, x2: sx,
        y1: state.axisY - (big ? 5 : 3), y2: state.axisY + (big ? 5 : 3),
        stroke: 'var(--border-strong)', 'stroke-width': 1
      }));
      if (big) {
        const txt = makeEl('text', {
          x: sx, y: state.axisY + 16,
          'text-anchor': 'middle', 'font-size': 10,
          fill: 'var(--text-tertiary)'
        });
        txt.textContent = i; g.appendChild(txt);
      }
    }
    const { sx: zx } = worldToScreen(0, 0);
    g.appendChild(makeEl('line', {
      x1: zx, x2: zx, y1: state.axisY - 7, y2: state.axisY + 7,
      stroke: 'var(--text-tertiary)', 'stroke-width': 1.2
    }));
  }

  function renderLens(g, lens, sortedLenses, displayIdx) {
    const { sx } = worldToScreen(lens.x, 0);
    const topY = 25, botY = state.H - 25;
    g.appendChild(makeEl('line', {
      x1: sx, x2: sx, y1: topY, y2: botY,
      stroke: lens.color, 'stroke-width': 1.5, opacity: 0.3
    }));
    // draw glyph sized by lens.diameter
    const midY = state.axisY;
    const halfH = lens.diameter * state.scale / 2;
    const topCy = midY - halfH;
    const botCy = midY + halfH;
    const converging = lens.f > 0;
    const size = 8;
    function arrow(cy, isTop) {
      let d;
      if (converging) {
        d = isTop
          ? `M ${sx - size} ${cy + size} L ${sx} ${cy} L ${sx + size} ${cy + size}`
          : `M ${sx - size} ${cy - size} L ${sx} ${cy} L ${sx + size} ${cy - size}`;
      } else {
        d = isTop
          ? `M ${sx - size} ${cy - size} L ${sx} ${cy} L ${sx + size} ${cy - size}`
          : `M ${sx - size} ${cy + size} L ${sx} ${cy} L ${sx + size} ${cy + size}`;
      }
      return makeEl('path', {
        d, stroke: lens.color, 'stroke-width': 2.2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none'
      });
    }
    g.appendChild(arrow(topCy, true));
    g.appendChild(arrow(botCy, false));
    g.appendChild(makeEl('line', {
      x1: sx, x2: sx, y1: topCy, y2: botCy,
      stroke: lens.color, 'stroke-width': 2, opacity: 0.85
    }));
    const hit = makeEl('rect', {
      x: sx - 12, width: 24, y: topY, height: botY - topY,
      fill: 'transparent', class: 'handle'
    });
    hit.dataset.kind = 'lens'; hit.dataset.id = lens.id;
    g.appendChild(hit);
    const label = makeEl('text', {
      x: sx, y: topY - 8, 'text-anchor': 'middle',
      'font-size': 12, 'font-weight': 500, fill: lens.color
    });
    label.textContent = `L${displayIdx + 1}  f = ${lens.f.toFixed(2)}`;
    g.appendChild(label);
    if (state.showFocals) {
      [lens.f, -lens.f].forEach((off) => {
        const { sx: fx } = worldToScreen(lens.x + off, 0);
        g.appendChild(makeEl('circle', {
          cx: fx, cy: state.axisY, r: 3.5,
          fill: lens.color, opacity: 0.6
        }));
        const ft = makeEl('text', {
          x: fx, y: state.axisY - 8, 'text-anchor': 'middle',
          'font-size': 9, fill: 'var(--text-tertiary)'
        });
        ft.textContent = off > 0 ? "F\u2032" : 'F';
        g.appendChild(ft);
      });
    }
  }

  function renderAperture(g, ap, isStop, displayIdx) {
    const { sx } = worldToScreen(ap.x, 0);
    const color = isStop ? 'var(--accent-stop)' : 'var(--text-tertiary)';
    const halfDia = ap.diameter * state.scale / 2;
    const topY = 25, botY = state.H - 25;
    const gapTop = state.axisY - halfDia;
    const gapBot = state.axisY + halfDia;
    // blade above the aperture
    g.appendChild(makeEl('rect', {
      x: sx - 3, y: topY, width: 6, height: gapTop - topY,
      fill: color, opacity: isStop ? 0.9 : 0.55, rx: 1
    }));
    // blade below
    g.appendChild(makeEl('rect', {
      x: sx - 3, y: gapBot, width: 6, height: botY - gapBot,
      fill: color, opacity: isStop ? 0.9 : 0.55, rx: 1
    }));
    // little tick marks at aperture edges
    [gapTop, gapBot].forEach(ey => {
      g.appendChild(makeEl('line', {
        x1: sx - 8, x2: sx + 8, y1: ey, y2: ey,
        stroke: color, 'stroke-width': isStop ? 2 : 1.2
      }));
    });
    // draggable body: axial slide
    const bodyHit = makeEl('rect', {
      x: sx - 8, width: 16, y: topY, height: botY - topY,
      fill: 'transparent', class: 'handle'
    });
    bodyHit.dataset.kind = 'aperture'; bodyHit.dataset.id = ap.id;
    g.appendChild(bodyHit);
    // edge hits for diameter drag
    [ { ey: gapTop, sign: 1 }, { ey: gapBot, sign: -1 } ].forEach(e => {
      const h = makeEl('rect', {
        x: sx - 14, width: 28, y: e.ey - 6, height: 12,
        fill: 'transparent', class: 'aperture-edge'
      });
      h.dataset.kind = 'aperture-edge'; h.dataset.id = ap.id; h.dataset.sign = e.sign;
      g.appendChild(h);
    });
    // label
    const label = makeEl('text', {
      x: sx, y: topY - 8, 'text-anchor': 'middle',
      'font-size': 12, 'font-weight': 500, fill: color
    });
    label.textContent = `A${displayIdx + 1}${isStop ? '  (stop)' : ''}  \u2300 ${ap.diameter.toFixed(2)}`;
    g.appendChild(label);
  }

  function renderPupil(g, pupil, type) {
    if (!state.showPupils) return;
    if (!pupil || pupil.atInfinity || !isFinite(pupil.x)) return;
    const color = type === 'entrance' ? 'var(--accent-entrance)' : 'var(--accent-exit)';
    const { sx } = worldToScreen(pupil.x, 0);
    const halfDia = Math.abs(pupil.h) * state.scale;
    if (halfDia > state.H) return; // offscreen
    const topY = state.axisY - halfDia;
    const botY = state.axisY + halfDia;
    // dashed diamond/ring
    [topY, botY].forEach(ey => {
      g.appendChild(makeEl('line', {
        x1: sx - 10, x2: sx + 10, y1: ey, y2: ey,
        stroke: color, 'stroke-width': 1.4, 'stroke-dasharray': '3 2'
      }));
    });
    g.appendChild(makeEl('line', {
      x1: sx, x2: sx, y1: topY, y2: botY,
      stroke: color, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.6
    }));
    const label = makeEl('text', {
      x: sx, y: type === 'entrance' ? botY + 14 : topY - 6,
      'text-anchor': 'middle', 'font-size': 10,
      'font-weight': 500, fill: color
    });
    label.textContent = type === 'entrance' ? 'EP' : 'XP';
    g.appendChild(label);
  }

  function renderObject(g) {
    if (state.object.mode === 'infinity') {
      // draw indicator: set of parallel rays far to the left with angle θ
      const angleRad = state.object.angle * Math.PI / 180;
      // indicator box at left edge
      const ix = screenToWorldX(30);
      const txt = makeEl('text', {
        x: 60, y: 24, 'font-size': 11, 'font-weight': 500,
        fill: 'var(--accent-object)'
      });
      txt.textContent = `Object at \u221e, \u03b8 = ${state.object.angle.toFixed(2)}\u00b0`;
      g.appendChild(txt);
      // angle arrow
      const { sx: ax, sy: ay } = worldToScreen(ix, 0);
      const len = 24;
      const dy = -Math.sin(angleRad) * len;
      const dx = Math.cos(angleRad) * len;
      g.appendChild(makeEl('path', {
        d: `M ${ax} ${ay} L ${ax + dx} ${ay + dy}`,
        stroke: 'var(--accent-object)', 'stroke-width': 2,
        'marker-end': 'url(#arrow-head)'
      }));
      return;
    }
    const { sx, sy } = worldToScreen(state.object.x, 0);
    const { sy: tipY } = worldToScreen(state.object.x, state.object.h);
    g.appendChild(makeEl('line', {
      x1: sx, x2: sx, y1: sy, y2: tipY,
      stroke: 'var(--accent-object)', 'stroke-width': 2.5
    }));
    const dir = state.object.h >= 0 ? -1 : 1;
    const hs = 7;
    g.appendChild(makeEl('path', {
      d: `M ${sx - hs} ${tipY - dir*hs} L ${sx} ${tipY} L ${sx + hs} ${tipY - dir*hs}`,
      stroke: 'var(--accent-object)', 'stroke-width': 2.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none'
    }));
    const hitTop = Math.min(sy, tipY) - 4;
    const hitH = Math.abs(sy - tipY) + 8;
    const hit = makeEl('rect', {
      x: sx - 12, width: 24, y: hitTop, height: hitH,
      fill: 'transparent', class: 'handle'
    });
    hit.dataset.kind = 'object';
    g.appendChild(hit);
    const vhit = makeEl('circle', {
      cx: sx, cy: tipY, r: 11,
      fill: 'transparent', class: 'arrow-head'
    });
    vhit.dataset.kind = 'object-tip';
    g.appendChild(vhit);
    const label = makeEl('text', {
      x: sx, y: state.object.h >= 0 ? sy + 16 : sy - 8,
      'text-anchor': 'middle', 'font-size': 11,
      'font-weight': 500, fill: 'var(--accent-object)'
    });
    label.textContent = `Object  h = ${state.object.h.toFixed(2)}`;
    g.appendChild(label);
  }

  function drawRay(g, pts, color, opacity, dashed) {
    if (pts.length < 2) return;
    const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + p.sx + ' ' + p.sy).join(' ');
    const el = makeEl('path', {
      d, stroke: color, 'stroke-width': 1.6, fill: 'none',
      opacity: opacity ?? 0.9
    });
    if (dashed) el.setAttribute('stroke-dasharray', '4 3');
    g.appendChild(el);
  }

  function drawVirtualExtension(g, pts, imageX, color) {
    if (!state.showVirtual || pts.length < 2) return;
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const dx = last.x - prev.x;
    if (Math.abs(dx) < 1e-9) return;
    const m = (last.y - prev.y) / dx;
    if (imageX >= prev.x) return;
    const yAtImage = prev.y + m * (imageX - prev.x);
    const p1 = worldToScreen(imageX, yAtImage);
    const p2 = worldToScreen(prev.x, prev.y);
    g.appendChild(makeEl('path', {
      d: `M ${p1.sx} ${p1.sy} L ${p2.sx} ${p2.sy}`,
      stroke: color, 'stroke-width': 1.2, fill: 'none',
      opacity: 0.55, 'stroke-dasharray': '4 3'
    }));
  }

  function renderRays(g, finalImage, stopInfo) {
    const sortedLenses = getSortedElements().filter(e => e.kind === 'lens');
    if (sortedLenses.length === 0) return;
    const firstLens = sortedLenses[0];
    const n0 = state.segments.object ?? 1.0;

    let objX, objH;
    if (state.object.mode === 'infinity') {
      // Parallel rays from angle θ (downward if θ > 0).
      // We'll originate rays at a plane far to the left.
      const farX = screenToWorldX(-20);
      objX = farX;
      const angleRad = state.object.angle * Math.PI / 180;
      // Principal rays for object at infinity:
      // 1) Parallel ray along axis at some height (defines marginal). We use the edge of entrance pupil.
      // 2) Chief ray from off-axis angle θ through center of entrance pupil.
      // 3) Parallel ray at axis height (just the axial ray).
      // Simpler pedagogical set: use three rays all at angle θ, at heights { +h, 0, -h } where h is a visual height.
      // Better: ONE chief ray aimed through center of entrance pupil, at angle θ. TWO marginal rays through edge of EP at angle θ.
      const ep = stopInfo ? stopInfo.entrance : null;
      const epX = (ep && !ep.atInfinity && isFinite(ep.x)) ? ep.x : firstLens.x;
      const epR = (ep && !ep.atInfinity && isFinite(ep.h)) ? Math.abs(ep.h) : firstLens.diameter/2;

      const rays = [];
      if (state.showChief) {
        // chief: passes through EP center at angle θ
        // at farX, y = 0 - (epX - farX)*tan(θ)  (ray goes from farX to (epX, 0))
        const slope = -Math.tan(angleRad);
        const y0 = 0 - slope * (epX - farX);
        rays.push({ x0: farX, y0, slope, color: '#D85A30' });
      }
      if (state.showMarginal || state.showRimRays) {
        // marginal through top edge of EP at angle θ
        const slope = -Math.tan(angleRad);
        const y0top = epR - slope * (epX - farX);
        rays.push({ x0: farX, y0: y0top, slope, color: state.showMarginal ? '#534AB7' : '#0F6E56' });
        const y0bot = -epR - slope * (epX - farX);
        rays.push({ x0: farX, y0: y0bot, slope, color: state.showMarginal ? '#534AB7' : '#0F6E56' });
      }
      if (state.showParallel) {
        // axial parallel ray at y=0
        const slope = -Math.tan(angleRad);
        const y0 = 0 - slope * (epX - farX);
        // skip if duplicate of chief
        if (!state.showChief) rays.push({ x0: farX, y0, slope, color: '#378ADD' });
      }
      for (const r of rays) {
        const trace = traceRay(r.x0, r.y0, r.slope, n0);
        drawRay(g, trace.pts, r.color);
      }
      return;
    }

    // Finite object:
    objX = state.object.x; objH = state.object.h;
    if (objX >= firstLens.x) return;
    const ep = stopInfo ? stopInfo.entrance : null;
    const epValid = ep && !ep.atInfinity && isFinite(ep.x) && isFinite(ep.h);

    const rays = [];
    // Parallel ray: from (objX, objH) parallel to axis (slope 0 in object medium)
    if (state.showParallel) rays.push({ slope: 0, color: '#378ADD' });
    // Chief ray: from (objX, objH) through center of entrance pupil (axis at epX)
    if (state.showChief) {
      const targetX = epValid ? ep.x : firstLens.x;
      const slope = (0 - objH) / (targetX - objX);
      rays.push({ slope, color: '#D85A30' });
    }
    // Marginal ray: from (objX, objH) through front focal point of first lens (classic principal ray 3)
    if (state.showMarginal) {
      const nLeft = mediumLeftOf(0, getSortedElements());
      const fFront = firstLens.x - (firstLens.f * nLeft);
      if (Math.abs(fFront - objX) > 1e-6) {
        const slope = (0 - objH) / (fFront - objX);
        rays.push({ slope, color: '#534AB7' });
      }
    }
    // Rim rays: from (objX, objH) through top and bottom of entrance pupil
    if (state.showRimRays && epValid) {
      const slopeTop = (ep.h - objH) / (ep.x - objX);
      const slopeBot = (-ep.h - objH) / (ep.x - objX);
      rays.push({ slope: slopeTop, color: '#0F6E56' });
      rays.push({ slope: slopeBot, color: '#0F6E56' });
      // also from axial object point (y=0) through EP edges — these are the true marginal rays
      rays.push({ slope: ep.h / (ep.x - objX), color: '#0F6E56', y0: 0 });
      rays.push({ slope: -ep.h / (ep.x - objX), color: '#0F6E56', y0: 0 });
    }

    for (const r of rays) {
      const y0 = (r.y0 !== undefined) ? r.y0 : objH;
      const trace = traceRay(objX, y0, r.slope, n0);
      drawRay(g, trace.pts, r.color);
      if (finalImage && !finalImage.atInfinity && r.y0 === undefined) {
        const sortedLensList = getSortedElements().filter(e => e.kind === 'lens');
        const lastLens = sortedLensList[sortedLensList.length - 1];
        if (lastLens && finalImage.x < lastLens.x) {
          drawVirtualExtension(g, trace.pts, finalImage.x, r.color);
        }
      }
    }
  }

  function renderImages(g, imgs, sortedElements) {
    const lensIndices = [];
    sortedElements.forEach((el, i) => { if (el.kind === 'lens') lensIndices.push(i); });
    if (imgs.length === 0) return;
    // imgs corresponds to elements in sorted order; we only render for lens-type entries
    imgs.forEach((img, i) => {
      if (!img || img.type !== 'lens' || img.atInfinity) return;
      const el = sortedElements[i];
      const isFinalLens = (i === lensIndices[lensIndices.length - 1]);
      // determine if this image is the final one (last lens of system)
      const isFinal = isFinalLens;
      const virtual = img.x < el.x;
      const color = isFinal
        ? (virtual ? 'var(--accent-image-virtual)' : 'var(--accent-image-real)')
        : 'var(--text-tertiary)';
      const opacity = isFinal ? 1 : 0.35;
      const dash = virtual ? '5 3' : '';
      const sw = isFinal ? 2.5 : 1.5;
      if (Math.abs(img.x) > 200 || Math.abs(img.h) > 30) return;
      const { sx, sy: baseY } = worldToScreen(img.x, 0);
      const { sy: tipY } = worldToScreen(img.x, img.h);
      const body = makeEl('line', {
        x1: sx, x2: sx, y1: baseY, y2: tipY,
        stroke: color, 'stroke-width': sw, opacity
      });
      if (dash) body.setAttribute('stroke-dasharray', dash);
      g.appendChild(body);
      const dir = img.h >= 0 ? -1 : 1;
      const hs = 6;
      const head = makeEl('path', {
        d: `M ${sx - hs} ${tipY - dir*hs} L ${sx} ${tipY} L ${sx + hs} ${tipY - dir*hs}`,
        stroke: color, 'stroke-width': sw,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none',
        opacity
      });
      if (dash) head.setAttribute('stroke-dasharray', dash);
      g.appendChild(head);
      if (isFinal) {
        const label = makeEl('text', {
          x: sx, y: img.h >= 0 ? tipY - 10 : tipY + 16,
          'text-anchor': 'middle', 'font-size': 11,
          'font-weight': 500, fill: color
        });
        label.textContent = virtual ? "Image (virtual)" : 'Image';
        g.appendChild(label);
      }
    });
  }

  function computeSystemMatrix(sortedLenses) {
    let A = 1, B = 0, C = 0, D = 1;
    for (let i = 0; i < sortedLenses.length; i++) {
      const f = sortedLenses[i].f;
      const nA = A, nB = B, nC = -A/f + C, nD = -B/f + D;
      A = nA; B = nB; C = nC; D = nD;
      if (i < sortedLenses.length - 1) {
        const t = sortedLenses[i+1].x - sortedLenses[i].x;
        const tA = A + t*C, tB = B + t*D;
        A = tA; B = tB;
      }
    }
    return { A, B, C, D };
  }

  function formatNum(v, digits) {
    if (!isFinite(v)) return '\u221e';
    if (Math.abs(v) > 1e4) return v.toExponential(2);
    return v.toFixed(digits ?? 2);
  }

  function renderMetrics(imgs, sortedElements, stopInfo) {
    const lensImgs = imgs.filter(i => i && i.type === 'lens');
    const finalLensImg = lensImgs.length ? lensImgs[lensImgs.length - 1] : null;
    const sortedLenses = sortedElements.filter(e => e.kind === 'lens');

    // status pills
    if (!finalLensImg || finalLensImg.atInfinity) {
      imageStatus.className = 'pill none';
      imageStatus.textContent = finalLensImg ? 'image at \u221e' : 'no image';
    } else {
      const lastLens = sortedLenses[sortedLenses.length - 1];
      const virtual = finalLensImg.x < lastLens.x;
      const totalM = lensImgs.reduce((a, im) => a * (im.m || 1), 1);
      const upright = totalM > 0;
      imageStatus.className = 'pill ' + (virtual ? 'virtual' : 'real');
      imageStatus.textContent = (virtual ? 'virtual' : 'real') + ' \u00b7 ' + (upright ? 'upright' : 'inverted');
    }
    if (stopInfo && stopInfo.stop) {
      stopStatus.className = 'pill success';
      const stopDispIdx = state.apertures.findIndex(a => a.id === stopInfo.stop.id);
      stopStatus.textContent = 'stop: A' + (stopDispIdx + 1);
    } else {
      stopStatus.className = 'pill none';
      stopStatus.textContent = 'no stop';
    }

    // metrics
    let metrics;
    if (!finalLensImg) {
      metrics = [{ label: 'System', value: '\u2014', unit: '', sub: 'Add at least one lens' }];
    } else if (finalLensImg.atInfinity) {
      metrics = [
        { label: 'Final image', value: '\u221e', unit: '', sub: 'rays exit parallel' },
        { label: 'Lens count', value: sortedLenses.length, unit: '', sub: '' }
      ];
    } else {
      const totalM = lensImgs.reduce((a, im) => a * (im.m || 1), 1);
      const finalH = (state.object.mode === 'infinity'
        ? null
        : state.object.h * totalM);
      const lastLens = sortedLenses[sortedLenses.length - 1];
      const imgDist = finalLensImg.x - lastLens.x;
      const M = computeSystemMatrix(sortedLenses);
      const fEq = (Math.abs(M.C) > 1e-9) ? (-1/M.C) : Infinity;
      metrics = [
        {
          label: state.object.mode === 'infinity' ? 'Focal image x' : 'Final image x',
          value: formatNum(finalLensImg.x, 3), unit: 'cm',
          sub: `v = ${formatNum(imgDist, 3)} cm from L${sortedLenses.length}`
        },
        state.object.mode === 'infinity'
          ? {
              label: 'Image height h\u2032',
              value: formatNum(fEq * Math.tan(state.object.angle * Math.PI / 180), 3),
              unit: 'cm',
              sub: `f\u2091\u2091 \u00d7 tan(\u03b8)`
            }
          : {
              label: 'Image height h\u2032',
              value: formatNum(finalH, 3), unit: 'cm',
              sub: `object h = ${state.object.h.toFixed(2)} cm`
            },
        state.object.mode === 'infinity'
          ? {
              label: 'Angular m',
              value: formatNum((isFinite(fEq) ? fEq : 1) / 1, 3),
              unit: '',
              sub: 'effective focal / 1cm'
            }
          : {
              label: 'Magnification',
              value: formatNum(totalM, 3), unit: '\u00d7',
              sub: `${totalM > 0 ? 'upright' : 'inverted'}, |m| = ${formatNum(Math.abs(totalM), 3)}`
            },
        {
          label: 'Equivalent f',
          value: isFinite(fEq) ? formatNum(fEq, 3) : '\u221e',
          unit: isFinite(fEq) ? 'cm' : '',
          sub: isFinite(fEq) ? (fEq > 0 ? 'converging' : 'diverging') : 'afocal'
        },
        {
          label: 'Elements',
          value: sortedElements.length, unit: '',
          sub: `${sortedLenses.length} lens, ${state.apertures.length} aperture`
        }
      ];
    }
    metricsEl.innerHTML = metrics.map(m => `
      <div class="metric">
        <div class="label">${m.label}</div>
        <div class="value">${m.value}<span class="unit">${m.unit}</span></div>
        ${m.sub ? `<div class="subvalue">${m.sub}</div>` : ''}
      </div>
    `).join('');

    // pupils section
    if (!stopInfo || !stopInfo.stop) {
      pupilsEl.innerHTML = `<div class="pupil-box" style="border-left-color: var(--border); grid-column: 1 / -1;">
        <div class="pt">Pupil analysis</div>
        <div class="pv" style="color: var(--text-tertiary)">No aperture defined</div>
        <div class="ps">Add an aperture to enable stop and pupil analysis.</div>
      </div>`;
      return;
    }
    const stop = stopInfo.stop;
    const ep = stopInfo.entrance, xp = stopInfo.exit;
    const stopIdxDisp = state.apertures.findIndex(a => a.id === stop.id);
    const fmtPupil = (p, virt) => {
      if (!p) return '\u2014';
      if (p.atInfinity) return '\u221e (at infinity)';
      return `x = ${formatNum(p.x, 3)} cm, \u2300 = ${formatNum(Math.abs(p.h)*2, 3)} cm`;
    };
    pupilsEl.innerHTML = `
      <div class="pupil-box">
        <div class="pt">Aperture stop</div>
        <div class="pv">A${stopIdxDisp + 1} \u00b7 \u2300 ${stop.diameter.toFixed(3)} cm</div>
        <div class="ps">at x = ${stop.x.toFixed(3)} cm</div>
      </div>
      <div class="pupil-box entrance">
        <div class="pt">Entrance pupil (object space)</div>
        <div class="pv">${fmtPupil(ep)}</div>
        <div class="ps">stop imaged through lenses to its left</div>
      </div>
      <div class="pupil-box exit">
        <div class="pt">Exit pupil (image space)</div>
        <div class="pv">${fmtPupil(xp)}</div>
        <div class="ps">stop imaged through lenses to its right</div>
      </div>
    `;
  }

  // ============== Panels ==============
  let lensPanelKey = '';
  let aperturePanelKey = '';
  let mediaPanelKey = '';

  function renderPanels(imgs, sortedElements, stopInfo) {
    const lensKey = state.object.mode + ':' + state.lenses.map(l => l.id).join(',');
    if (lensKey !== lensPanelKey) { buildLensPanel(); lensPanelKey = lensKey; }
    const apKey = state.apertures.map(a => a.id).join(',') + '|' + (stopInfo?.stop?.id ?? '');
    if (apKey !== aperturePanelKey) { buildAperturePanel(stopInfo); aperturePanelKey = apKey; }
    const mediaKey = sortedElements.map(e => e.id).join(',');
    if (mediaKey !== mediaPanelKey) { buildMediaPanel(sortedElements); mediaPanelKey = mediaKey; }
    updatePanelValues(imgs, sortedElements, stopInfo);
  }

  function buildLensPanel() {
    lensPanel.innerHTML = '';
    // object card first
    const objCard = document.createElement('div');
    objCard.className = 'card';
    objCard.dataset.card = 'object';
    if (state.object.mode === 'finite') {
      objCard.innerHTML = `
        <div class="title"><span style="color:var(--accent-object)">Object (finite)</span></div>
        <div class="row">
          <label>x (cm)</label>
          <input type="range" min="-25" max="25" step="0.01" data-obj="x" data-kind="range">
          <input type="number" step="any" data-obj="x" data-kind="number">
        </div>
        <div class="row">
          <label>h (cm)</label>
          <input type="range" min="-5" max="5" step="0.01" data-obj="h" data-kind="range">
          <input type="number" step="any" data-obj="h" data-kind="number">
        </div>
      `;
    } else {
      objCard.innerHTML = `
        <div class="title"><span style="color:var(--accent-object)">Object (at infinity)</span></div>
        <div class="row">
          <label>\u03b8 (\u00b0)</label>
          <input type="range" min="-25" max="25" step="0.01" data-obj="angle" data-kind="range">
          <input type="number" step="any" data-obj="angle" data-kind="number">
        </div>
        <div class="row" style="font-size: 11px; color: var(--text-tertiary); margin-top: 4px;">
          Parallel ray bundle arrives at angle \u03b8 from optical axis.
        </div>
      `;
    }
    lensPanel.appendChild(objCard);
    // lens cards
    const sorted = [...state.lenses].sort((a, b) => a.x - b.x);
    sorted.forEach((lens, i) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.card = 'lens'; card.dataset.id = lens.id;
      card.innerHTML = `
        <div class="title">
          <span style="color:${lens.color}">Lens ${i + 1} <span data-role="kind" style="font-weight: 400; color: var(--text-secondary); font-size: 12px;">(${lens.f > 0 ? 'converging' : 'diverging'})</span></span>
          <button class="del" data-del="${lens.id}" data-dtype="lens">remove</button>
        </div>
        <div class="row">
          <label>x (cm)</label>
          <input type="range" min="-20" max="20" step="0.01" data-prop="x" data-id="${lens.id}" data-kind="range">
          <input type="number" step="any" data-prop="x" data-id="${lens.id}" data-kind="number">
        </div>
        <div class="row">
          <label>f (cm)</label>
          <input type="range" min="-15" max="15" step="0.01" data-prop="f" data-id="${lens.id}" data-kind="range">
          <input type="number" step="any" data-prop="f" data-id="${lens.id}" data-kind="number">
        </div>
        <div class="row">
          <label>\u2300 (cm)</label>
          <input type="range" min="0.5" max="15" step="0.01" data-prop="diameter" data-id="${lens.id}" data-kind="range">
          <input type="number" step="any" data-prop="diameter" data-id="${lens.id}" data-kind="number">
        </div>
        <div class="stats" data-role="stats"></div>
      `;
      lensPanel.appendChild(card);
    });
    lensPanel.addEventListener('input', onPanelInput);
    lensPanel.addEventListener('click', onPanelClick);
  }

  function buildAperturePanel(stopInfo) {
    aperturePanel.innerHTML = '';
    if (state.apertures.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No apertures. Click "+ Aperture" to add one.';
      aperturePanel.appendChild(empty);
      return;
    }
    const sorted = [...state.apertures].sort((a, b) => a.x - b.x);
    sorted.forEach((ap, i) => {
      const isStop = stopInfo?.stop?.id === ap.id;
      const card = document.createElement('div');
      card.className = 'card' + (isStop ? ' is-stop' : '');
      card.dataset.card = 'aperture'; card.dataset.id = ap.id;
      card.innerHTML = `
        <div class="title">
          <span style="color: var(--accent-stop)">Aperture ${i + 1}${isStop ? ' <span style="font-size:11px;color:var(--accent-stop);background:var(--accent-warn-bg);padding:2px 8px;border-radius:8px;margin-left:6px;">stop</span>' : ''}</span>
          <button class="del" data-del="${ap.id}" data-dtype="aperture">remove</button>
        </div>
        <div class="row">
          <label>x (cm)</label>
          <input type="range" min="-20" max="20" step="0.01" data-ap-prop="x" data-id="${ap.id}" data-kind="range">
          <input type="number" step="any" data-ap-prop="x" data-id="${ap.id}" data-kind="number">
        </div>
        <div class="row">
          <label>\u2300 (cm)</label>
          <input type="range" min="0.1" max="10" step="0.01" data-ap-prop="diameter" data-id="${ap.id}" data-kind="range">
          <input type="number" step="any" data-ap-prop="diameter" data-id="${ap.id}" data-kind="number">
        </div>
      `;
      aperturePanel.appendChild(card);
    });
    aperturePanel.addEventListener('input', onPanelInput);
    aperturePanel.addEventListener('click', onPanelClick);
  }

  function buildMediaPanel(sortedElements) {
    mediaPanel.innerHTML = '';
    // Object-side
    mediaPanel.appendChild(buildMediaCard({
      label: 'Object-side (left of first element)',
      kind: 'object',
      key: null
    }));
    // Between each adjacent pair
    for (let i = 1; i < sortedElements.length; i++) {
      const a = sortedElements[i-1], b = sortedElements[i];
      mediaPanel.appendChild(buildMediaCard({
        label: `Between ${elemLabel(a, sortedElements)} and ${elemLabel(b, sortedElements)}`,
        kind: 'between', key: segmentKey(a, b)
      }));
    }
    // Image-side
    mediaPanel.appendChild(buildMediaCard({
      label: 'Image-side (right of last element)',
      kind: 'image', key: null
    }));
    mediaPanel.addEventListener('input', onMediaInput);
    mediaPanel.addEventListener('change', onMediaInput);
  }
  function elemLabel(e, sorted) {
    if (e.kind === 'lens') {
      const lensIdx = state.lenses.slice().sort((a,b) => a.x - b.x).findIndex(l => l.id === e.id);
      return `L${lensIdx + 1}`;
    } else {
      const apIdx = state.apertures.slice().sort((a,b) => a.x - b.x).findIndex(a => a.id === e.id);
      return `A${apIdx + 1}`;
    }
  }
  function buildMediaCard({ label, kind, key }) {
    let n;
    if (kind === 'object') n = state.segments.object ?? 1.0;
    else if (kind === 'image') n = state.segments.image ?? 1.0;
    else n = state.segments.between[key] ?? 1.0;

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.mkind = kind;
    if (key) card.dataset.mkey = key;
    const presetSelect = Object.entries(MEDIA_PRESETS).map(([k, v]) => {
      const val = v.n;
      let selected = '';
      if (val !== null && Math.abs(n - val) < 1e-4) selected = 'selected';
      if (k === 'custom') {
        const isPreset = Object.values(MEDIA_PRESETS).some(m => m.n !== null && Math.abs(n - m.n) < 1e-4);
        if (!isPreset) selected = 'selected';
      }
      return `<option value="${k}" ${selected}>${v.name}${val !== null ? ' (' + val.toFixed(3) + ')' : ''}</option>`;
    }).join('');
    card.innerHTML = `
      <div class="title"><span style="color: var(--text-secondary); font-weight: 400;">${label}</span></div>
      <div class="row">
        <label>preset</label>
        <select data-mrole="preset" style="flex: 1;">${presetSelect}</select>
      </div>
      <div class="row">
        <label>n</label>
        <input type="range" min="1" max="2.5" step="0.001" data-mrole="n-range">
        <input type="number" step="any" data-mrole="n-num">
      </div>
    `;
    const nRange = card.querySelector('[data-mrole=n-range]');
    const nNum = card.querySelector('[data-mrole=n-num]');
    nRange.value = n;
    nNum.value = formatForInput(n);
    return card;
  }

  function onMediaInput(e) {
    const t = e.target;
    const card = t.closest('[data-mkind]');
    if (!card) return;
    const mkind = card.dataset.mkind;
    const mkey = card.dataset.mkey;
    let newN = null;
    if (t.dataset.mrole === 'preset') {
      const preset = MEDIA_PRESETS[t.value];
      if (preset && preset.n !== null) newN = preset.n;
      else return;
    } else if (t.dataset.mrole === 'n-range' || t.dataset.mrole === 'n-num') {
      const raw = t.value;
      if (raw === '' || raw === '-' || raw === '.') return;
      const v = parseFloat(raw);
      if (!isFinite(v) || v < 1) return;
      newN = v;
    }
    if (newN === null) return;
    if (mkind === 'object') state.segments.object = newN;
    else if (mkind === 'image') state.segments.image = newN;
    else state.segments.between[mkey] = newN;
    // update companion inputs in this card without rebuilding
    const nRange = card.querySelector('[data-mrole=n-range]');
    const nNum = card.querySelector('[data-mrole=n-num]');
    const presetSel = card.querySelector('[data-mrole=preset]');
    if (t !== nRange) nRange.value = newN;
    if (t !== nNum) nNum.value = formatForInput(newN);
    // try to sync preset dropdown
    if (t !== presetSel) {
      const match = Object.entries(MEDIA_PRESETS).find(([k, v]) => v.n !== null && Math.abs(v.n - newN) < 1e-4);
      presetSel.value = match ? match[0] : 'custom';
    }
    refreshAll();
  }

  function updatePanelValues(imgs, sortedElements, stopInfo) {
    // object
    const objCard = lensPanel.querySelector('[data-card=object]');
    if (objCard) {
      objCard.querySelectorAll('input[data-obj]').forEach(inp => {
        if (document.activeElement === inp) return;
        const prop = inp.dataset.obj;
        const v = state.object[prop];
        inp.value = inp.dataset.kind === 'number' ? formatForInput(v) : v;
      });
    }
    // lenses
    lensPanel.querySelectorAll('[data-card=lens]').forEach(card => {
      const id = +card.dataset.id;
      const lens = state.lenses.find(l => l.id === id);
      if (!lens) return;
      const kindEl = card.querySelector('[data-role=kind]');
      if (kindEl) kindEl.textContent = `(${lens.f > 0 ? 'converging' : 'diverging'})`;
      card.querySelectorAll('input[data-prop]').forEach(inp => {
        if (document.activeElement === inp) return;
        const prop = inp.dataset.prop;
        const v = lens[prop];
        inp.value = inp.dataset.kind === 'number' ? formatForInput(v) : v;
      });
      // per-lens stats
      const sortedIdx = sortedElements.indexOf(sortedElements.find(e => e.id === lens.id));
      const img = imgs[sortedIdx];
      const statsEl = card.querySelector('[data-role=stats]');
      if (statsEl) {
        let stats = '';
        if (img && img.type === 'lens') {
          if (img.atInfinity) stats = 'image at infinity';
          else {
            const v = img.x - lens.x;
            const virtual = v < 0;
            const upright = img.m > 0;
            stats =
              `image x    = ${img.x.toFixed(3)} cm\n` +
              `v (from L) = ${v.toFixed(3)} cm\n` +
              `h\u2032         = ${img.h.toFixed(3)} cm\n` +
              `m          = ${img.m.toFixed(4)}  (${upright ? 'upright' : 'inverted'}, ${virtual ? 'virtual' : 'real'})`;
          }
        }
        statsEl.textContent = stats;
      }
    });
    // apertures
    aperturePanel.querySelectorAll('[data-card=aperture]').forEach(card => {
      const id = +card.dataset.id;
      const ap = state.apertures.find(a => a.id === id);
      if (!ap) return;
      card.querySelectorAll('input[data-ap-prop]').forEach(inp => {
        if (document.activeElement === inp) return;
        const prop = inp.dataset.apProp;
        const v = ap[prop];
        inp.value = inp.dataset.kind === 'number' ? formatForInput(v) : v;
      });
    });
  }

  function formatForInput(v) {
    if (!isFinite(v)) return '';
    const s = v.toFixed(4);
    return s.replace(/\.?0+$/, '') || '0';
  }

  function onPanelInput(e) {
    const t = e.target;
    if (!t.matches('input')) return;
    const raw = t.value;
    if (raw === '' || raw === '-' || raw === '.' || raw === '-.') return;
    const v = parseFloat(raw);
    if (!isFinite(v)) return;
    if (t.dataset.obj) {
      state.object[t.dataset.obj] = v;
    } else if (t.dataset.prop) {
      const lens = state.lenses.find(l => l.id === +t.dataset.id);
      if (!lens) return;
      let val = v;
      if (t.dataset.prop === 'f' && Math.abs(val) < 0.01) val = val < 0 ? -0.01 : 0.01;
      if (t.dataset.prop === 'diameter' && val < 0.1) val = 0.1;
      lens[t.dataset.prop] = val;
    } else if (t.dataset.apProp) {
      const ap = state.apertures.find(a => a.id === +t.dataset.id);
      if (!ap) return;
      let val = v;
      if (t.dataset.apProp === 'diameter' && val < 0.05) val = 0.05;
      ap[t.dataset.apProp] = val;
    } else return;
    syncCompanionInput(t);
    refreshAll({ skipPanelRebuild: true });
  }

  function syncCompanionInput(src) {
    const row = src.closest('.row');
    if (!row) return;
    const srcProp = src.dataset.obj || src.dataset.prop || src.dataset.apProp;
    row.querySelectorAll('input').forEach(s => {
      if (s === src) return;
      const sProp = s.dataset.obj || s.dataset.prop || s.dataset.apProp;
      if (sProp !== srcProp) return;
      let v;
      if (s.dataset.obj) v = state.object[sProp];
      else if (s.dataset.prop) {
        const lens = state.lenses.find(l => l.id === +s.dataset.id);
        if (!lens) return;
        v = lens[sProp];
      } else if (s.dataset.apProp) {
        const ap = state.apertures.find(a => a.id === +s.dataset.id);
        if (!ap) return;
        v = ap[sProp];
      }
      s.value = s.dataset.kind === 'number' ? formatForInput(v) : v;
    });
  }

  function onPanelClick(e) {
    if (e.target.matches('button[data-del]')) {
      const id = +e.target.dataset.del;
      const dtype = e.target.dataset.dtype;
      if (dtype === 'lens') state.lenses = state.lenses.filter(l => l.id !== id);
      else if (dtype === 'aperture') state.apertures = state.apertures.filter(a => a.id !== id);
      refreshAll();
    }
  }

  function refreshAll(opts) {
    renderSvg();
    const sortedElements = getSortedElements();
    const { cascade } = imageCascade(
      state.object.mode === 'infinity' ? -1e9 : state.object.x,
      state.object.mode === 'infinity' ? 0 : state.object.h
    );
    const stopInfo = analyzeStop();
    renderMetrics(cascade, sortedElements, stopInfo);
    if (!opts?.skipPanelRebuild) {
      renderPanels(cascade, sortedElements, stopInfo);
    } else {
      updatePanelValues(cascade, sortedElements, stopInfo);
    }
  }

  function renderSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    // defs for arrow markers (used for object-at-infinity indicator)
    const defs = makeEl('defs');
    const marker = makeEl('marker', {
      id: 'arrow-head', markerWidth: 8, markerHeight: 8,
      refX: 7, refY: 4, orient: 'auto'
    });
    marker.appendChild(makeEl('path', {
      d: 'M0,0 L7,4 L0,8 Z', fill: 'var(--accent-object)'
    }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    const g = makeEl('g');
    svg.appendChild(g);
    renderMediaBackgrounds(g);
    renderGrid(g);
    renderAxis(g);
    const sortedElements = getSortedElements();
    const { cascade } = imageCascade(
      state.object.mode === 'infinity' ? -1e9 : state.object.x,
      state.object.mode === 'infinity' ? 0 : state.object.h
    );
    const finalImg = (() => {
      const lensImgs = cascade.filter(c => c.type === 'lens');
      return lensImgs.length ? lensImgs[lensImgs.length - 1] : null;
    })();
    const stopInfo = analyzeStop();

    renderRays(g, finalImg, stopInfo);
    renderImages(g, cascade, sortedElements);
    renderPupil(g, stopInfo.entrance, 'entrance');
    renderPupil(g, stopInfo.exit, 'exit');

    const sortedLenses = state.lenses.slice().sort((a,b)=>a.x-b.x);
    const sortedAps = state.apertures.slice().sort((a,b)=>a.x-b.x);
    sortedElements.forEach((el) => {
      if (el.kind === 'lens') {
        const idx = sortedLenses.findIndex(l => l.id === el.id);
        const lens = state.lenses.find(l => l.id === el.id);
        renderLens(g, lens, sortedLenses, idx);
      } else {
        const idx = sortedAps.findIndex(a => a.id === el.id);
        const ap = state.apertures.find(a => a.id === el.id);
        renderAperture(g, ap, stopInfo.stop?.id === ap.id, idx);
      }
    });
    renderObject(g);
  }

  // ============== Dragging ==============
  let drag = null, dragStart = null;
  svg.addEventListener('pointerdown', e => {
    const target = e.target;
    const kind = target.dataset && target.dataset.kind;
    if (!kind) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    drag = {
      kind, id: target.dataset.id ? +target.dataset.id : null,
      sign: target.dataset.sign ? +target.dataset.sign : 0
    };
    dragStart = { sx, sy, wx: screenToWorldX(sx), wy: screenToWorldY(sy) };
    if (kind === 'lens') {
      const lens = state.lenses.find(l => l.id === drag.id);
      if (lens) dragStart.origX = lens.x;
    } else if (kind === 'aperture') {
      const ap = state.apertures.find(a => a.id === drag.id);
      if (ap) dragStart.origX = ap.x;
    } else if (kind === 'aperture-edge') {
      const ap = state.apertures.find(a => a.id === drag.id);
      if (ap) dragStart.origDia = ap.diameter;
    } else if (kind === 'object') {
      dragStart.origX = state.object.x;
    } else if (kind === 'object-tip') {
      dragStart.origH = state.object.h;
    }
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const wx = screenToWorldX(sx), wy = screenToWorldY(sy);
    const factor = state.shiftHeld ? 0.2 : 1.0;
    if (drag.kind === 'lens') {
      const lens = state.lenses.find(l => l.id === drag.id);
      if (lens) { lens.x = Math.max(-20, Math.min(20, dragStart.origX + (wx - dragStart.wx) * factor)); refreshAll(); }
    } else if (drag.kind === 'aperture') {
      const ap = state.apertures.find(a => a.id === drag.id);
      if (ap) { ap.x = Math.max(-20, Math.min(20, dragStart.origX + (wx - dragStart.wx) * factor)); refreshAll(); }
    } else if (drag.kind === 'aperture-edge') {
      const ap = state.apertures.find(a => a.id === drag.id);
      if (ap) {
        // change diameter based on vertical drag. sign=1 means we grabbed top edge.
        const deltaY = (wy - dragStart.wy) * factor;
        const newDia = Math.max(0.05, dragStart.origDia + 2 * deltaY * drag.sign);
        ap.diameter = newDia;
        refreshAll();
      }
    } else if (drag.kind === 'object') {
      state.object.x = Math.max(-25, Math.min(25, dragStart.origX + (wx - dragStart.wx) * factor));
      refreshAll();
    } else if (drag.kind === 'object-tip') {
      state.object.h = Math.max(-5, Math.min(5, dragStart.origH + (wy - dragStart.wy) * factor));
      refreshAll();
    }
  });
  svg.addEventListener('pointerup', () => { drag = null; });
  svg.addEventListener('pointercancel', () => { drag = null; });

  window.addEventListener('keydown', e => { if (e.key === 'Shift') state.shiftHeld = true; });
  window.addEventListener('keyup', e => { if (e.key === 'Shift') state.shiftHeld = false; });

  // ============== Toolbar ==============
  document.getElementById('addPos').addEventListener('click', () => {
    const color = COLORS[state.lenses.length % COLORS.length];
    const lastX = state.lenses.length ? Math.max(...state.lenses.map(l => l.x)) : 0;
    state.lenses.push({ id: state.nextId++, x: lastX + 4, f: 5, color, diameter: 5 });
    refreshAll();
  });
  document.getElementById('addNeg').addEventListener('click', () => {
    const color = COLORS[state.lenses.length % COLORS.length];
    const lastX = state.lenses.length ? Math.max(...state.lenses.map(l => l.x)) : 0;
    state.lenses.push({ id: state.nextId++, x: lastX + 4, f: -4, color, diameter: 4 });
    refreshAll();
  });
  document.getElementById('addAperture').addEventListener('click', () => {
    // insert at center of lens layout, or at x=0 if no lenses
    let x = 0;
    if (state.lenses.length >= 2) {
      const xs = state.lenses.map(l => l.x).sort((a,b) => a - b);
      x = (xs[0] + xs[xs.length - 1]) / 2;
    } else if (state.lenses.length === 1) {
      x = state.lenses[0].x + 2;
    }
    state.apertures.push({ id: state.nextId++, x, diameter: 2.0, color: '#BA7517' });
    refreshAll();
  });
  document.getElementById('reset').addEventListener('click', () => {
    const d = DEFAULT_STATE();
    Object.assign(state, d);
    lensPanelKey = ''; aperturePanelKey = ''; mediaPanelKey = '';
    document.getElementById('objectMode').value = state.object.mode;
    refreshAll();
  });
  document.getElementById('objectMode').addEventListener('change', e => {
    state.object.mode = e.target.value;
    lensPanelKey = '';
    refreshAll();
  });
  document.getElementById('savePreset').addEventListener('click', () => {
    const data = {
      object: state.object,
      lenses: state.lenses.map(l => ({ x: l.x, f: l.f, color: l.color, diameter: l.diameter })),
      apertures: state.apertures.map(a => ({ x: a.x, diameter: a.diameter, color: a.color })),
      segments: state.segments
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'lens_scene.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  document.getElementById('loadPreset').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.object || !Array.isArray(data.lenses)) throw new Error('invalid scene');
          state.object = { mode: 'finite', angle: 5, ...data.object };
          state.lenses = data.lenses.map((l, i) => ({
            id: i + 1, x: l.x, f: l.f, diameter: l.diameter ?? 5,
            color: l.color || COLORS[i % COLORS.length]
          }));
          state.apertures = (data.apertures || []).map((a, i) => ({
            id: 100 + i, x: a.x, diameter: a.diameter, color: a.color || '#BA7517'
          }));
          state.segments = data.segments || { object: 1.0, image: 1.0, between: {} };
          state.nextId = 200;
          lensPanelKey = ''; aperturePanelKey = ''; mediaPanelKey = '';
          document.getElementById('objectMode').value = state.object.mode;
          refreshAll();
        } catch (err) { alert('Could not parse scene file: ' + err.message); }
      };
      reader.readAsText(file);
    };
    input.click();
  });
  ['showMarginal','showChief','showParallel','showRimRays','showVirtual','showPupils','showGrid','showFocals'].forEach(key => {
    document.getElementById(key).addEventListener('change', e => {
      state[key] = e.target.checked;
      renderSvg();
    });
  });
  const zoomInput = document.getElementById('zoom');
  const zoomOut = document.getElementById('zoomOut');
  zoomInput.addEventListener('input', e => {
    state.scale = +e.target.value;
    zoomOut.textContent = e.target.value;
    renderSvg();
  });

  window.addEventListener('resize', resize);
  setTimeout(() => { resize(); refreshAll(); }, 0);
})();