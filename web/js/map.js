// Canvas map: population/epidemic raster + OSM roads + place labels, with pan/zoom.

const ROAD_STYLE = [
  { w: 3.2, a: 0.95 }, { w: 2.6, a: 0.9 }, { w: 1.9, a: 0.8 }, { w: 1.4, a: 0.7 }, { w: 1.0, a: 0.6 }, { w: 0.5, a: 0.35 },
];

export const LAYERS = [
  ['composite', 'Epidemic (humans + zombies)'],
  ['zombies', 'Zombie density'],
  ['humans', 'Surviving human density'],
  ['dead', 'Cumulative deaths'],
  ['arrival', 'Zombie arrival time'],
  ['survival', 'Share of residents remaining'],
  ['population', 'Initial population density'],
  ['land', 'Land / water mask'],
];

function lerp(a, b, t) { return a + (b - a) * t; }
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}
const VIRIDIS = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
const MAGMA = [[0, 0, 4], [81, 18, 124], [183, 55, 121], [252, 137, 97], [252, 253, 191]];
const HUMAN = [[14, 22, 30], [20, 70, 90], [40, 140, 150], [150, 225, 215]];
const ZOMB = [[40, 10, 10], [140, 20, 20], [220, 40, 30], [255, 170, 90]];
const TURBO_R = [[250, 250, 110], [250, 170, 50], [220, 80, 40], [150, 30, 80], [60, 20, 90]];

export class MapView {
  constructor(canvas, tooltip) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.tooltip = tooltip;
    this.cell = document.createElement('canvas');
    this.roadsCv = document.createElement('canvas');
    this.layer = 'composite';
    this.bundle = null; this.frame = null; this.seeds = []; this.clicks = [];
    this.showRoads = true; this.showLabels = true;
    this.onCellClick = null;
    this.view = { cx: 0, cy: 0, s: 0.02 }; // world metres -> css px scale
    this.dirtyRoads = true;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  setBundle(b) {
    this.bundle = b;
    this.frame = null;
    const n = b.n;
    this.cell.width = n; this.cell.height = n;
    this.img = this.cell.getContext('2d').createImageData(n, n);
    this.cellKm2 = (b.cellM / 1000) ** 2;
    this.popDens = new Float32Array(n * n);
    let maxD = 1;
    for (let i = 0; i < n * n; i++) {
      this.popDens[i] = b.pop[i] / (Math.max(b.land[i], 0.02) * this.cellKm2);
      if (this.popDens[i] > maxD) maxD = this.popDens[i];
    }
    this.maxDens = maxD;
    this.roadPaths = [0, 1, 2, 3, 4, 5].map(() => new Path2D());
    for (const w of b.roads) {
      const p = this.roadPaths[w[0]];
      p.moveTo(w[2], -w[3]);
      for (let k = 4; k < w.length; k += 2) p.lineTo(w[k], -w[k + 1]);
    }
    this.fit();
    this.render();
  }

  fit() {
    if (!this.bundle) return;
    const r = this.cv.getBoundingClientRect();
    const span = this.bundle.n * this.bundle.cellM;
    this.view.s = Math.min(r.width, r.height) / span * 0.98;
    this.view.cx = -this.bundle.radiusKm * 1000 + span / 2;
    this.view.cy = this.bundle.radiusKm * 1000 - span / 2;
    this.dirtyRoads = true;
    this.draw();
  }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = Math.max(1, Math.round(r.width * dpr));
    this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px';
    this.dpr = dpr;
    this.roadsCv.width = this.cv.width; this.roadsCv.height = this.cv.height;
    this.dirtyRoads = true;
    if (this.bundle && !this._fitted) { this._fitted = true; this.fit(); }
    this.draw();
  }

  // world (x east, y north, metres) -> css px
  toScreen(x, y) {
    const W = this.cv.width / this.dpr, H = this.cv.height / this.dpr;
    return [W / 2 + (x - this.view.cx) * this.view.s, H / 2 - (y - this.view.cy) * this.view.s];
  }
  toWorld(px, py) {
    const W = this.cv.width / this.dpr, H = this.cv.height / this.dpr;
    return [this.view.cx + (px - W / 2) / this.view.s, this.view.cy - (py - H / 2) / this.view.s];
  }
  cellAt(px, py) {
    const b = this.bundle; if (!b) return -1;
    const [x, y] = this.toWorld(px, py);
    const R = b.radiusKm * 1000;
    const c = Math.floor((x + R) / b.cellM), r = Math.floor((R - y) / b.cellM);
    if (c < 0 || r < 0 || c >= b.n || r >= b.n) return -1;
    return r * b.n + c;
  }
  cellCenter(i) {
    const b = this.bundle, R = b.radiusKm * 1000;
    const r = Math.floor(i / b.n), c = i % b.n;
    return [-R + (c + 0.5) * b.cellM, R - (r + 0.5) * b.cellM];
  }

  _bind() {
    let drag = null, moved = false;
    this.cv.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY, this.view.cx, this.view.cy]; moved = false; this.cv.setPointerCapture(e.pointerId); });
    this.cv.addEventListener('pointermove', (e) => {
      const rect = this.cv.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag[0], dy = e.clientY - drag[1];
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        this.view.cx = drag[2] - dx / this.view.s; this.view.cy = drag[3] + dy / this.view.s;
        this.dirtyRoads = true; this.draw();
      }
      this.hover(e.clientX - rect.left, e.clientY - rect.top);
    });
    this.cv.addEventListener('pointerup', (e) => {
      const rect = this.cv.getBoundingClientRect();
      if (drag && !moved && this.onCellClick) {
        const i = this.cellAt(e.clientX - rect.left, e.clientY - rect.top);
        if (i >= 0) this.onCellClick(i);
      }
      drag = null;
    });
    this.cv.addEventListener('pointerleave', () => { this.tooltip.hidden = true; });
    this.cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.cv.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const [wx, wy] = this.toWorld(px, py);
      const f = Math.exp(-e.deltaY * 0.0015);
      this.view.s = Math.min(2, Math.max(0.002, this.view.s * f));
      const [nx, ny] = this.toWorld(px, py);
      this.view.cx += wx - nx; this.view.cy += wy - ny;
      this.dirtyRoads = true; this.draw();
    }, { passive: false });
  }

  hover(px, py) {
    const i = this.cellAt(px, py);
    if (i < 0 || !this.bundle) { this.tooltip.hidden = true; return; }
    const b = this.bundle, f = this.frame;
    const fmt = (v) => v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v < 10 ? 1 : 0);
    let html = `<b>${this.placeName ? this.placeName(i) : 'Cell ' + i}</b><br>Residents: ${fmt(b.pop[i])} · ${fmt(this.popDens[i])}/km²<br>Land: ${(b.land[i] * 100).toFixed(0)}%`;
    if (f) {
      html += `<br>Humans: ${fmt(f.H[i])} · Zombies: <span class="zc">${fmt(f.Z[i])}</span><br>Killed here: ${fmt(f.D[i])}`;
      if (f.arrival && f.arrival[i] >= 0) html += `<br>Zombies arrived: ${(f.arrival[i] / 24).toFixed(2)} d`;
    }
    this.tooltip.innerHTML = html;
    this.tooltip.hidden = false;
    const W = this.cv.width / this.dpr;
    this.tooltip.style.left = Math.min(px + 14, W - 230) + 'px';
    this.tooltip.style.top = py + 14 + 'px';
  }

  setFrame(f) { this.frame = f; this.render(); }
  setLayer(l) { this.layer = l; this.render(); }

  // rasterise the chosen layer into the n x n cell image
  render() {
    const b = this.bundle; if (!b) return;
    const n = b.n, N = n * n, d = this.img.data, f = this.frame;
    const lmax = Math.log10(1 + this.maxDens);
    const km2 = this.cellKm2;
    let maxArr = 1;
    if (this.layer === 'arrival' && f && f.arrival) for (let i = 0; i < N; i++) if (f.arrival[i] > maxArr) maxArr = f.arrival[i];
    let maxDead = 1;
    if (this.layer === 'dead' && f) for (let i = 0; i < N; i++) if (f.D[i] > maxDead) maxDead = f.D[i];
    for (let i = 0; i < N; i++) {
      const a = Math.max(b.land[i], 0.02) * km2;
      let rgb, alpha = 255;
      const water = b.land[i] < 0.3 && b.pop[i] < 1;
      switch (this.layer) {
        case 'population': rgb = b.pop[i] > 0 ? ramp(VIRIDIS, Math.log10(1 + this.popDens[i]) / lmax) : (water ? [12, 24, 40] : [18, 18, 22]); break;
        case 'land': rgb = ramp([[10, 30, 60], [60, 60, 50], [120, 115, 90]], b.land[i]); break;
        case 'humans': {
          const h = f ? f.H[i] : b.pop[i];
          rgb = h > 0.5 ? ramp(HUMAN, Math.log10(1 + h / a) / lmax) : (water ? [12, 24, 40] : [14, 14, 18]);
          break;
        }
        case 'zombies': {
          const z = f ? f.Z[i] : 0;
          rgb = z >= 0.5 ? ramp(ZOMB, 0.15 + 0.85 * Math.log10(1 + z / a) / Math.max(1, lmax - 0.5)) : (water ? [12, 24, 40] : [16, 16, 18]);
          break;
        }
        case 'dead': {
          const v = f ? f.D[i] : 0;
          rgb = v > 0.5 ? ramp(MAGMA, 0.1 + 0.9 * Math.log10(1 + v) / Math.log10(1 + maxDead)) : (water ? [12, 24, 40] : [16, 16, 18]);
          break;
        }
        case 'arrival': {
          const t = f && f.arrival ? f.arrival[i] : -1;
          rgb = t >= 0 ? ramp(TURBO_R, t / maxArr) : (water ? [12, 24, 40] : (b.pop[i] > 0 ? [40, 44, 52] : [18, 18, 22]));
          break;
        }
        case 'survival': {
          if (b.pop[i] < 5) { rgb = water ? [12, 24, 40] : [18, 18, 22]; break; }
          const s = f ? Math.min(1, f.H[i] / Math.max(1, b.pop[i])) : 1;
          rgb = ramp([[120, 10, 20], [200, 120, 40], [230, 220, 120], [60, 170, 120]], s);
          break;
        }
        default: { // composite
          const h = f ? f.H[i] : b.pop[i];
          const z = f ? f.Z[i] : 0;
          if (water && z < 0.5) { rgb = [10, 22, 38]; break; }
          const hv = h > 0.5 ? Math.log10(1 + h / a) / lmax : 0;
          const base = h > 0.5 ? ramp(HUMAN, hv) : [14, 14, 18];
          if (z >= 0.5) {
            const zv = Math.min(1, 0.35 + 0.65 * Math.log10(1 + z / a) / Math.max(1, lmax - 0.5));
            const zc = ramp(ZOMB, zv);
            const share = Math.min(1, 0.45 + 0.55 * z / (z + h + 1e-9));
            rgb = [lerp(base[0], zc[0], share), lerp(base[1], zc[1], share), lerp(base[2], zc[2], share)];
          } else if (f && b.pop[i] > 20 && h < 0.1 * b.pop[i]) {
            rgb = [30, 12, 14]; // fallen neighbourhood
          } else rgb = base;
        }
      }
      d[4 * i] = rgb[0]; d[4 * i + 1] = rgb[1]; d[4 * i + 2] = rgb[2]; d[4 * i + 3] = alpha;
    }
    this.cell.getContext('2d').putImageData(this.img, 0, 0);
    this.draw();
  }

  drawRoads() {
    const ctx = this.roadsCv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.roadsCv.width, this.roadsCv.height);
    if (!this.bundle || !this.showRoads) return;
    const dpr = this.dpr, s = this.view.s;
    const W = this.cv.width / dpr, H = this.cv.height / dpr;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, (W / 2 - this.view.cx * s) * dpr, (H / 2 + this.view.cy * s) * dpr);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const zoomBoost = Math.min(2.2, Math.max(0.6, Math.sqrt(s / 0.02)));
    for (let c = 5; c >= 0; c--) {
      const st = ROAD_STYLE[c];
      ctx.strokeStyle = `rgba(235, 225, 200, ${st.a * 0.55})`;
      ctx.lineWidth = (st.w * zoomBoost) / s;
      ctx.stroke(this.roadPaths[c]);
    }
    this.dirtyRoads = false;
  }

  draw() {
    const ctx = this.ctx, b = this.bundle;
    const dpr = this.dpr || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    if (!b) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = b.radiusKm * 1000, span = b.n * b.cellM;
    const [x0, y0] = this.toScreen(-R, R);
    const px = span * this.view.s;
    ctx.imageSmoothingEnabled = px / b.n < 6;
    ctx.drawImage(this.cell, x0, y0, px, px);
    if (this.dirtyRoads) this.drawRoads();
    if (this.showRoads) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(this.roadsCv, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    // boundary
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, px, px);
    // labels
    if (this.showLabels && b.places) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const s = this.view.s;
      const occupied = [];
      const kinds = s > 0.05 ? ['city', 'town', 'borough', 'suburb', 'quarter', 'neighbourhood', 'village'] : s > 0.025 ? ['city', 'town', 'borough', 'suburb'] : ['city', 'borough', 'town'];
      for (const kind of kinds) for (const p of b.places) {
        if (p.kind !== kind) continue;
        const [sx, sy] = this.toScreen(p.x, p.y);
        const w = ctx.measureText(p.name).width + 6;
        if (sx < -50 || sy < -20 || sx > this.cv.width / dpr + 50 || sy > this.cv.height / dpr + 20) continue;
        if (occupied.some(([ax, ay, aw]) => Math.abs(ax - sx) < (aw + w) / 2 && Math.abs(ay - sy) < 13)) continue;
        occupied.push([sx, sy, w]);
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillText(p.name, sx + 1, sy + 1);
        ctx.fillStyle = kind === 'city' || kind === 'borough' ? '#fff' : 'rgba(240,240,230,0.85)';
        ctx.fillText(p.name, sx, sy);
      }
    }
    // outbreak markers
    const mark = (i, col) => {
      const [cx, cy] = this.cellCenter(i);
      const [sx, sy] = this.toScreen(cx, cy);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - 13, sy); ctx.lineTo(sx - 5, sy); ctx.moveTo(sx + 5, sy); ctx.lineTo(sx + 13, sy);
      ctx.moveTo(sx, sy - 13); ctx.lineTo(sx, sy - 5); ctx.moveTo(sx, sy + 5); ctx.lineTo(sx, sy + 13); ctx.stroke();
    };
    for (const i of this.clicks) mark(i, '#ffd166');
    for (const [i] of this.seeds) mark(i, '#ff4d4d');
    // scale bar
    const W = this.cv.width / dpr, H = this.cv.height / dpr;
    const target = 120 / this.view.s;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const nice = [1, 2, 5, 10].map((m) => m * pow).filter((v) => v <= target).pop() || pow;
    const len = nice * this.view.s;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(12, H - 30, len + 16, 20);
    ctx.fillStyle = '#ddd'; ctx.fillRect(20, H - 16, len, 2);
    ctx.font = '11px system-ui'; ctx.textAlign = 'left';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, 20, H - 20);
    ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(220,220,220,0.6)';
    ctx.fillText('© OpenStreetMap contributors', W - 8, H - 8);
  }
}
