// Minimal dependency-free time-series chart for canvas.

export class Chart {
  constructor(canvas, legendEl) {
    this.cv = canvas; this.legendEl = legendEl;
    this.series = []; this.opts = {};
    this.hidden = new Set();
    new ResizeObserver(() => this.draw()).observe(canvas.parentElement);
    canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); this.hoverX = e.clientX - r.left; this.draw(); });
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; this.draw(); });
  }

  set(series, opts = {}) { this.series = series; this.opts = opts; this.renderLegend(); this.draw(); }

  renderLegend() {
    if (!this.legendEl) return;
    this.legendEl.innerHTML = '';
    for (const s of this.series) {
      if (s.noLegend) continue;
      const b = document.createElement('button');
      b.className = 'lg' + (this.hidden.has(s.name) ? ' off' : '');
      b.innerHTML = `<i style="background:${s.color}"></i>${s.name}`;
      b.onclick = () => { this.hidden.has(s.name) ? this.hidden.delete(s.name) : this.hidden.add(s.name); this.renderLegend(); this.draw(); };
      this.legendEl.appendChild(b);
    }
  }

  draw() {
    const cv = this.cv, par = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = par.width, H = par.height;
    if (W < 10 || H < 10) return;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue('--muted').trim() || '#999';
    const grid = css.getPropertyValue('--grid').trim() || 'rgba(255,255,255,0.08)';
    const vis = this.series.filter((s) => !this.hidden.has(s.name) && s.points && s.points.length);
    const m = { l: 56, r: 12, t: 10, b: 26 };
    let xmax = this.opts.xmax || 1, ymax = 1, ymin = this.opts.logY ? 1 : 0;
    for (const s of vis) for (const p of s.points) { if (p[0] > xmax) xmax = p[0]; if (p[1] > ymax) ymax = p[1]; }
    for (const s of vis) if (s.band) for (const p of s.band) if (p[2] > ymax) ymax = p[2];
    const logY = !!this.opts.logY;
    const ly = (v) => logY ? Math.log10(Math.max(1, v)) : v;
    const y0 = ly(ymin), y1 = ly(ymax) * (logY ? 1.02 : 1.05) || 1;
    const X = (x) => m.l + (x / xmax) * (W - m.l - m.r);
    const Y = (v) => H - m.b - ((ly(v) - y0) / (y1 - y0)) * (H - m.t - m.b);
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = ink; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    // y grid
    const ticks = [];
    if (logY) { for (let e = 0; e <= Math.ceil(y1); e++) ticks.push(Math.pow(10, e)); }
    else { const st = niceStep(ymax / 4); for (let v = 0; v <= ymax * 1.05; v += st) ticks.push(v); }
    ctx.textAlign = 'right';
    for (const v of ticks) {
      const y = Y(v); if (y < m.t - 1) continue;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(W - m.r, y); ctx.stroke();
      ctx.fillText(fmtNum(v), m.l - 6, y + 4);
    }
    // x grid (days)
    ctx.textAlign = 'center';
    const days = xmax / 24, dstep = niceStep(days / 6) || 1;
    for (let d = 0; d <= days + 1e-9; d += dstep) {
      const x = X(d * 24);
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, H - m.b); ctx.stroke();
      ctx.fillText(`${+d.toFixed(2)}d`, x, H - m.b + 15);
    }
    // vertical markers
    for (const v of this.opts.vlines || []) {
      if (v.x == null || v.x < 0) continue;
      const x = X(v.x);
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = v.color; ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, H - m.b); ctx.stroke(); ctx.restore();
      ctx.fillStyle = v.color; ctx.textAlign = 'left'; ctx.fillText(v.label, x + 3, m.t + 10); ctx.fillStyle = ink;
    }
    // bands then lines
    for (const s of vis) {
      if (!s.band) continue;
      ctx.fillStyle = s.color; ctx.globalAlpha = 0.18; ctx.beginPath();
      s.band.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[2])) : ctx.moveTo(X(p[0]), Y(p[2]))));
      for (let i = s.band.length - 1; i >= 0; i--) ctx.lineTo(X(s.band[i][0]), Y(s.band[i][1]));
      ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
    }
    for (const s of vis) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.8; ctx.globalAlpha = s.alpha || 1;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
      ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // hover readout
    if (this.hoverX != null && vis.length) {
      const hx = this.hoverX; if (hx < m.l || hx > W - m.r) return;
      const t = ((hx - m.l) / (W - m.l - m.r)) * xmax;
      ctx.strokeStyle = ink; ctx.beginPath(); ctx.moveTo(hx, m.t); ctx.lineTo(hx, H - m.b); ctx.stroke();
      const lines = [`t = ${(t / 24).toFixed(2)} d`];
      for (const s of vis) {
        if (s.noLegend) continue;
        let best = s.points[0];
        for (const p of s.points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
        lines.push([s.color, `${s.name}: ${fmtNum(best[1])}`]);
      }
      const bw = 170, bh = 14 * lines.length + 8;
      const bx = hx + bw + 12 > W ? hx - bw - 8 : hx + 8;
      ctx.fillStyle = 'rgba(10,12,16,0.88)'; ctx.fillRect(bx, m.t, bw, bh);
      ctx.textAlign = 'left';
      lines.forEach((l, i) => {
        if (typeof l === 'string') { ctx.fillStyle = '#eee'; ctx.fillText(l, bx + 6, m.t + 14 + i * 14); }
        else { ctx.fillStyle = l[0]; ctx.fillRect(bx + 6, m.t + 6 + i * 14, 8, 8); ctx.fillStyle = '#ddd'; ctx.fillText(l[1], bx + 18, m.t + 14 + i * 14); }
      });
    }
  }
}

export function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

export function fmtNum(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 10 || v === 0) return Math.round(v).toString();
  return v.toFixed(1);
}
