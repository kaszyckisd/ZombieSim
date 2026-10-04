import { PARAMS, PARAM_GROUPS, SCENARIOS, defaultParams, engineRates } from './params.js';
import { MapView, LAYERS } from './map.js';
import { Chart, fmtNum } from './chart.js';
import { buildReport, theory, makeLocator, ensembleSection } from './report.js';
import * as A from './analytics.js';
import { METHODS_HTML } from './methods.js';

const $ = (id) => document.getElementById(id);
const state = {
  params: loadSavedParams(), bundle: null, frame: null, seeds: [], clicks: [], running: false,
  city: null, ensemble: null, dirty: false, finalShown: false,
};

function loadSavedParams() {
  const p = defaultParams();
  try { Object.assign(p, JSON.parse(localStorage.getItem('zs.params') || '{}')); } catch { /* storage unavailable */ }
  return p;
}
function saveParams() { try { localStorage.setItem('zs.params', JSON.stringify(state.params)); } catch { /* ignore */ } }

// ------------------------------------------------------------------ map & chart
const map = new MapView($('map'), $('tooltip'));
const chart = new Chart($('chart'), $('legend'));
const ensChart = new Chart($('ensChart'), $('ensLegend'));
for (const [v, l] of LAYERS) $('layer').add(new Option(l, v));
$('layer').onchange = () => map.setLayer($('layer').value);
$('showRoads').onchange = () => { map.showRoads = $('showRoads').checked; map.dirtyRoads = true; map.draw(); };
$('showLabels').onchange = () => { map.showLabels = $('showLabels').checked; map.draw(); };
$('fit').onclick = () => map.fit();
$('logY').onchange = () => drawChart();
$('methods').innerHTML = METHODS_HTML;

// ------------------------------------------------------------------ parameter panel
const fmtVal = (d, v) => {
  if (d.type === 'bool') return v ? 'on' : 'off';
  if (d.type === 'select') return '';
  const a = Math.abs(v);
  const s = a !== 0 && (a < 0.01) ? v.toExponential(1) : a < 1 ? (+v.toFixed(3)).toString() : a < 100 ? (+v.toFixed(2)).toString() : Math.round(v).toString();
  return `${s}${d.unit ? ' ' + d.unit : ''}`;
};
const sliderToVal = (d, x) => (d.log ? Math.exp(Math.log(d.min) + x * (Math.log(d.max) - Math.log(d.min))) : d.min + x * (d.max - d.min));
const valToSlider = (d, v) => (d.log ? (Math.log(v) - Math.log(d.min)) / (Math.log(d.max) - Math.log(d.min)) : (v - d.min) / (d.max - d.min));
const inputs = {};

function buildPanel() {
  const root = $('paramGroups');
  root.innerHTML = '';
  for (const g of PARAM_GROUPS) {
    const det = document.createElement('details');
    det.className = 'group'; det.open = g.id !== 'sim';
    det.innerHTML = `<summary>${g.label}</summary>`;
    for (const d of PARAMS.filter((p) => p.group === g.id)) {
      const div = document.createElement('div');
      div.className = 'param';
      let ctl;
      if (d.type === 'select') {
        ctl = document.createElement('select');
        for (const [v, l] of d.options) ctl.add(new Option(l, v));
        ctl.value = state.params[d.id];
        ctl.onchange = () => setParam(d.id, ctl.value);
      } else if (d.type === 'bool') {
        ctl = document.createElement('input'); ctl.type = 'checkbox'; ctl.checked = !!state.params[d.id];
        ctl.onchange = () => setParam(d.id, ctl.checked);
      } else {
        ctl = document.createElement('input'); ctl.type = 'range'; ctl.min = 0; ctl.max = 1000; ctl.step = 1;
        ctl.value = Math.round(1000 * valToSlider(d, state.params[d.id]));
        ctl.oninput = () => {
          let v = sliderToVal(d, ctl.value / 1000);
          if (d.step) v = Math.round(v / d.step) * d.step;
          else v = +v.toPrecision(3);
          setParam(d.id, v, true);
        };
        ctl.onchange = () => paramsCommitted();
      }
      div.innerHTML = `<div class="row"><span class="name" title="${d.help.replace(/"/g, '&quot;')}">${d.label}</span><span class="val" id="val-${d.id}">${fmtVal(d, state.params[d.id])}</span></div>`;
      if (d.type === 'bool') { const row = div.querySelector('.row'); row.prepend(ctl); }
      else div.appendChild(ctl);
      const help = document.createElement('div'); help.className = 'help'; help.textContent = d.help;
      const der = document.createElement('div'); der.className = 'derived'; der.id = `der-${d.id}`;
      div.appendChild(der); div.appendChild(help);
      div.querySelector('.name').onclick = () => div.classList.toggle('showhelp');
      det.appendChild(div);
      inputs[d.id] = ctl;
    }
    root.appendChild(det);
  }
  updateDerived();
}

function setParam(id, v, live = false) {
  state.params[id] = v;
  const d = PARAMS.find((p) => p.id === id);
  const el = $(`val-${id}`); if (el) el.textContent = fmtVal(d, v);
  updateDerived();
  if (!live) paramsCommitted();
}

function paramsCommitted() {
  saveParams();
  $('scenario').value = '';
  renderTheory();
  if (!state.bundle) return;
  const t = state.frame ? state.frame.t : 0;
  if (!state.running && t === 0) resetSim();
  else { state.dirty = true; setStatus('Parameters changed: press ↺ Reset to apply them.'); }
}

function applyParams(obj) {
  Object.assign(state.params, obj);
  for (const d of PARAMS) {
    const c = inputs[d.id]; if (!c) continue;
    if (d.type === 'select') c.value = state.params[d.id];
    else if (d.type === 'bool') c.checked = !!state.params[d.id];
    else c.value = Math.round(1000 * valToSlider(d, state.params[d.id]));
    $(`val-${d.id}`).textContent = fmtVal(d, state.params[d.id]);
  }
  updateDerived();
}

function updateDerived() {
  const r = engineRates(state.params);
  const rho = state.bundle ? A.weightedDensityStats(state.bundle.pop, state.bundle.land, (state.bundle.cellM / 1000) ** 2).median : 5000;
  const set = (id, s) => { const e = $(`der-${id}`); if (e) e.textContent = s; };
  set('beta', `→ ${A.encounterRate(r, rho).toFixed(2)} encounters/zombie/h at ${fmtNum(rho)}/km²`);
  set('pk0', `→ R₀ = ${A.R0(r, rho, r.pk0).toFixed(2)} (humans need ≥ ${(100 * A.criticalWinProb(r, rho)).toFixed(0)}%)`);
  set('pk1', `→ R₀ = ${A.R0(r, rho, r.pk1, r.shelter, r.sweep).toFixed(2)} with full response`);
  set('dispose', `→ P(corpse rises) = ${(r.zeta / (r.zeta + r.omega)).toFixed(2)}`);
  const g = A.growthRate(r, rho, r.pk0);
  set('incub', g > 0 ? `→ doubling time ${(Math.LN2 / g).toFixed(1)} h` : '→ outbreak declines');
  if (state.bundle) set('zSpeed', `→ D = ${A.zombieDiffusivity(r, state.bundle.cellM / 1000).toFixed(3)} km²/h, Fisher front ${(24 * A.fisherSpeed(r, rho, state.bundle.cellM / 1000)).toFixed(2)} km/day`);
}

for (const name of Object.keys(SCENARIOS)) $('scenario').add(new Option(name, name));
$('scenario').add(new Option('(custom)', ''));
$('scenario').value = '';
$('scenario').onchange = () => {
  const s = $('scenario').value; if (!s) return;
  const base = defaultParams();
  for (const d of PARAMS) if (d.group === 'outbreak' || d.group === 'sim') base[d.id] = state.params[d.id];
  applyParams({ ...base, ...SCENARIOS[s] });
  saveParams(); renderTheory();
  $('scenario').value = s;
  if (state.bundle) resetSim();
};
$('resetParams').onclick = () => { applyParams(defaultParams()); paramsCommitted(); };
buildPanel();

// ------------------------------------------------------------------ city selection
function setStatus(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); s.title = msg; }

function autoCell(radius) {
  const opts = [250, 300, 400, 500, 600, 750, 1000];
  return opts.find((c) => (2000 * radius) / c <= 84) || 1000;
}

async function initPresets() {
  const res = await fetch('api/presets').then((r) => r.json());
  const sel = $('preset');
  sel.innerHTML = '<option value="">Preset cities…</option>';
  const cachedCoords = new Set(Object.values(res.cached).map((c) => `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`));
  for (const p of res.presets) {
    const o = new Option(`${cachedCoords.has(`${p.lat.toFixed(3)},${p.lon.toFixed(3)}`) ? '● ' : ''}${p.name}`, JSON.stringify(p));
    sel.add(o);
  }
  const extra = Object.values(res.cached).filter((c) => !res.presets.some((p) => Math.abs(p.lat - c.lat) < 1e-3 && Math.abs(p.lon - c.lon) < 1e-3));
  if (extra.length) {
    const og = document.createElement('optgroup'); og.label = 'Other cached';
    const seen = new Set();
    for (const c of extra) {
      const k = `${c.lat},${c.lon}`; if (seen.has(k)) continue; seen.add(k);
      og.appendChild(new Option(`● ${c.name}`, JSON.stringify({ name: c.name, country: c.country, lat: c.lat, lon: c.lon, radius: c.radius })));
    }
    sel.appendChild(og);
  }
  state.cacheIndex = res.cached;
}
$('preset').onchange = () => {
  if (!$('preset').value) return;
  const p = JSON.parse($('preset').value);
  chooseCity(p);
};
function chooseCity(p) {
  state.city = p;
  $('radius').value = p.radius;
  // prefer a cell size that already has a cached bundle for this city
  const cached = Object.values(state.cacheIndex || {}).find((c) => Math.abs(c.lat - p.lat) < 1e-3 && Math.abs(c.lon - p.lon) < 1e-3 && c.radius == p.radius);
  $('cell').value = String(cached ? cached.cell : autoCell(p.radius));
  if (cached) $('roads').value = cached.roads;
  $('q').value = '';
  setStatus(`${p.name} selected${cached ? ' (cached)' : ''}. Press Load city.`);
}
$('radius').onchange = () => { $('cell').value = String(autoCell(+$('radius').value)); };

let searchTimer = null;
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('q').value.trim();
  if (q.length < 3) { $('results').hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await fetch('api/geocode?q=' + encodeURIComponent(q)).then((r) => r.json());
      const box = $('results');
      box.innerHTML = '';
      if (!res.length) box.innerHTML = '<div class="muted">No matches</div>';
      for (const r of res) {
        const d = document.createElement('div');
        d.innerHTML = `${r.name}<small>${r.display}</small>`;
        d.onclick = () => { box.hidden = true; chooseCity({ name: r.name, country: r.country, lat: r.lat, lon: r.lon, radius: r.suggestedRadiusKm }); };
        box.appendChild(d);
      }
      box.hidden = false;
    } catch (e) { setStatus('Search failed: ' + e.message, true); }
  }, 450);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('results').hidden = true; });

$('load').onclick = async () => {
  const c = state.city;
  if (!c) { setStatus('Choose a preset or search for a city first.', true); return; }
  const qs = new URLSearchParams({ lat: c.lat, lon: c.lon, radius: $('radius').value, cell: $('cell').value, roads: $('roads').value, country: c.country, name: c.name });
  $('load').disabled = true;
  try {
    let res = await fetch('api/city?' + qs).then((r) => r.json());
    if (res.status === 'running') {
      const t0 = Date.now();
      while (true) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await fetch('api/job/' + res.job).then((r) => r.json());
        if (j.status === 'error') throw new Error(j.error);
        setStatus(`Downloading ${c.name}: ${j.progress} (${Math.round((Date.now() - t0) / 1000)} s)`);
        if (j.status === 'done') { res = j; break; }
      }
    }
    if (res.status === 'error') throw new Error(res.error);
    setStatus(`Loading ${c.name} from local cache…`);
    const bundle = await fetch('api/bundle/' + res.key).then((r) => r.json());
    await setBundle(bundle);
    initPresets();
  } catch (e) {
    setStatus('Failed: ' + e.message, true);
  } finally { $('load').disabled = false; }
};

// ------------------------------------------------------------------ worker
let worker = null;
function makeWorker() {
  const w = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module' });
  w.onerror = (e) => setStatus('Simulation error: ' + (e.message || e), true);
  return w;
}

async function setBundle(b) {
  state.bundle = b; state.clicks = []; state.frame = null; state.ensemble = null;
  map.setBundle(b);
  map.placeName = makeLocator(b);
  map.clicks = [];
  $('hint').hidden = true;
  if (worker) worker.terminate();
  worker = makeWorker();
  worker.onmessage = onWorker;
  worker.postMessage({ type: 'city', bundle: b });
  renderDataInfo(); renderTheory(); updateDerived();
  $('ensTable').innerHTML = ''; ensChart.set([]);
  for (const id of ['run', 'step', 'reset', 'runEnsemble']) $(id).disabled = false;
  setStatus(`${b.name}: ${fmtNum(b.totalPop)} residents, ${b.n}×${b.n} cells of ${b.cellM} m.`);
  resetSim();
}

function resetSim() {
  if (!worker) return;
  state.running = false; state.dirty = false; state.finalShown = false;
  $('run').textContent = '▶ Run';
  worker.postMessage({ type: 'clicks', clicks: state.clicks });
  worker.postMessage({ type: 'reset', params: { ...state.params } });
}

map.onCellClick = (i) => {
  if (!state.bundle) return;
  if (state.params.seedMode !== 'click') {
    setStatus('Tip: set "Patient zero location" to "Click on map" to place outbreak sites.');
    return;
  }
  const k = state.clicks.indexOf(i);
  if (k >= 0) state.clicks.splice(k, 1); else state.clicks.push(i);
  map.clicks = state.clicks;
  resetSim();
};

function onWorker(e) {
  const m = e.data;
  if (m.type === 'seeds') { state.seeds = m.seeds; map.seeds = m.seeds; renderTheory(); }
  else if (m.type === 'frame') {
    state.frame = m;
    map.setFrame(m);
    drawChart(); renderKpis();
    if (m.final && !state.finalShown) { state.finalShown = true; renderReport(); }
  } else if (m.type === 'done') {
    state.running = false; $('run').textContent = '▶ Run';
    setStatus(`Run finished at ${(m.t / 24).toFixed(1)} days. The report has been updated.`);
  }
}

$('run').onclick = () => {
  if (!worker) return;
  if (state.running) { worker.postMessage({ type: 'pause' }); state.running = false; $('run').textContent = '▶ Run'; return; }
  if (state.dirty) resetSim();
  worker.postMessage({ type: 'speed', hoursPerSec: +$('speed').value });
  worker.postMessage({ type: 'run' });
  state.running = true; $('run').textContent = '⏸ Pause';
};
$('speed').onchange = () => worker && worker.postMessage({ type: 'speed', hoursPerSec: +$('speed').value });
$('step').onclick = () => worker && worker.postMessage({ type: 'step', n: Math.round(60 / state.params.dtMin) });
$('reset').onclick = () => resetSim();

// ------------------------------------------------------------------ readouts
function drawChart() {
  const f = state.frame; if (!f) return;
  const s = f.series;
  const pts = (key) => s.map((x) => [x.t, x[key]]);
  const tr = f.tDetect >= 0 ? f.tDetect + state.params.respDelay : null;
  chart.set([
    { name: 'Humans alive', color: '#3fb9a5', points: pts('H'), width: 2.2 },
    { name: 'Zombies', color: '#e5484d', points: pts('Z'), width: 2.2 },
    { name: 'Incubating', color: '#ffb454', points: pts('E') },
    { name: 'Corpses', color: '#8f7cf0', points: pts('D') },
    { name: 'Killed (cum.)', color: '#c7c9cc', points: pts('killed'), dash: [5, 3] },
    { name: 'Turned (cum.)', color: '#ff8fa3', points: pts('turned'), dash: [2, 3] },
    { name: 'Evacuated (cum.)', color: '#6ea8fe', points: pts('escapedH'), dash: [6, 2] },
  ], {
    logY: $('logY').checked, xmax: Math.max(24, state.params.days * 24),
    vlines: [{ x: f.tDetect, color: '#ffd166', label: 'detected' }, { x: tr, color: '#ff9f43', label: 'response' }],
  });
}

function renderKpis() {
  const f = state.frame; if (!f) return;
  const T = f.totals, c = f.counters, pop = state.bundle.totalPop;
  const pol = f.pol || {};
  const phase = f.tDetect < 0 ? 'undetected' : pol.resp >= 1 ? 'full response' : pol.resp > 0 ? `response ${(100 * pol.resp).toFixed(0)}%` : 'detected';
  $('kpis').innerHTML = `
    <div class="kpi h"><b>${fmtNum(T.H)}</b><span>humans alive (${(100 * T.H / pop).toFixed(1)}%)</span></div>
    <div class="kpi z"><b>${fmtNum(T.Z)}</b><span>zombies</span></div>
    <div class="kpi"><b>${fmtNum(T.E)}</b><span>bitten</span></div>
    <div class="kpi d"><b>${fmtNum(c.killed)}</b><span>killed</span></div>
    <div class="kpi"><b>${fmtNum(c.escapedH)}</b><span>evacuated</span></div>
    <div class="kpi"><b>${phase}</b><span>pk = ${(pol.pk ?? state.params.pk0).toFixed(2)}${pol.exitsOpen === false ? ' · cordon' : ''}</span></div>`;
  const d = Math.floor(f.t / 24), h = f.t - 24 * d;
  $('clock').textContent = `Day ${d}, ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}  ·  ${state.params.mode}`;
}

function renderReport() {
  if (!state.bundle || !state.frame) return;
  $('report').innerHTML = buildReport({
    bundle: state.bundle, params: state.params, rates: engineRates(state.params), frame: state.frame,
    seeds: state.seeds, ensemble: state.ensemble,
  });
}
$('refreshReport').onclick = () => { if (worker) { state.finalShown = false; worker.postMessage({ type: 'report' }); } };
$('copyReport').onclick = async () => {
  const txt = $('report').innerText;
  try { await navigator.clipboard.writeText(txt); setStatus('Report copied to the clipboard.'); } catch { setStatus('Clipboard unavailable.', true); }
};

function renderTheory() {
  const el = $('theory');
  if (!state.bundle) return;
  const r = engineRates(state.params);
  const th = theory(state.bundle, r, state.seeds);
  const inf = (v, f) => (isFinite(v) ? f(v) : '∞');
  const rows = [
    ['Population-weighted median density', `${fmtNum(th.dens.median)} /km²`],
    ['10th / 90th percentile density', `${fmtNum(th.dens.p10)} / ${fmtNum(th.dens.p90)} /km²`],
    ['Encounter rate c(ρ̃) per zombie', `${th.enc.toFixed(3)} /h`],
    ['P(encounter → new zombie), untrained', A.newZombieProb(r, r.pk0).toFixed(3)],
    ['P(corpse reanimates) = ζ/(ζ+ω)', th.reanimP.toFixed(3)],
    ['R₀ at median density (untrained)', th.R0.toFixed(3)],
    ['R₀ at 10th / 90th percentile', `${th.R0lo.toFixed(3)} / ${th.R0hi.toFixed(3)}`],
    ['R₀ with full response', th.R0resp.toFixed(3)],
    ['Critical human win probability p*', `${(100 * th.pStar).toFixed(1)}%`],
    ['p* with shelter-in-place and sweeps', `${(100 * th.pStarResp).toFixed(1)}%`],
    ['Critical density ρ* (untrained)', inf(th.rhoStar, (v) => `${fmtNum(v)} /km²`)],
    ['Residents living above ρ*', `${(100 * th.fracAbove).toFixed(1)}%`],
    ['Malthusian growth rate r', `${th.growth.toFixed(4)} /h`],
    ['Doubling time ln2 / r', inf(th.doubling, (v) => `${v.toFixed(2)} h`)],
    ['Zombie diffusivity D', `${th.Dz.toFixed(4)} km²/h`],
    ['Fisher–KPP front speed 2√(rD)', `${(24 * th.fisher).toFixed(2)} km/day`],
    ['P(early extinction), current seeds', th.pExtinct !== undefined ? `${(100 * th.pExtinct).toFixed(2)}%` : '—'],
  ];
  el.innerHTML = `<p class="muted small">Closed-form results for the local model linearised around the zombie-free state. They update live as you move the sliders. Derivations are in the Model tab.</p><div class="stat">${rows.map(([a, b]) => `<div>${a}</div><div>${b}</div>`).join('')}</div>` + r0Curve(r, th);
}

// small inline SVG: R0 as a function of density
function r0Curve(r, th) {
  const W = 380, H = 150, m = 34;
  const xs = [], lo = 1, hi = 1e5;
  let ymax = 1.5;
  for (let k = 0; k <= 80; k++) {
    const rho = lo * Math.pow(hi / lo, k / 80);
    const v = A.R0(r, rho, r.pk0), w = A.R0(r, rho, r.pk1, r.shelter, r.sweep);
    xs.push([rho, v, w]); ymax = Math.max(ymax, v, w);
  }
  const X = (rho) => m + (Math.log10(rho) / 5) * (W - m - 8);
  const Y = (v) => H - 20 - (v / (ymax * 1.05)) * (H - 30);
  const path = (i) => xs.map((p, k) => `${k ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[i]).toFixed(1)}`).join('');
  const dm = th.dens.median;
  return `<h3 style="margin-top:14px">R₀ versus local density</h3>
  <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="R0 versus density">
    <line x1="${m}" x2="${W - 8}" y1="${Y(1)}" y2="${Y(1)}" stroke="var(--muted)" stroke-dasharray="3 3"/>
    <text x="${W - 10}" y="${Y(1) - 3}" fill="var(--muted)" font-size="10" text-anchor="end">R₀ = 1</text>
    <path d="${path(1)}" fill="none" stroke="#e5484d" stroke-width="2"/>
    <path d="${path(2)}" fill="none" stroke="#3fb9a5" stroke-width="2"/>
    <line x1="${X(dm)}" x2="${X(dm)}" y1="10" y2="${H - 20}" stroke="#ffd166" stroke-dasharray="2 3"/>
    ${[1, 10, 100, 1e3, 1e4, 1e5].map((v) => `<text x="${X(v)}" y="${H - 6}" fill="var(--muted)" font-size="10" text-anchor="middle">${fmtNum(v)}</text>`).join('')}
    <text x="${m}" y="10" fill="#e5484d" font-size="10">untrained</text><text x="${m + 60}" y="10" fill="#3fb9a5" font-size="10">full response</text>
    <text x="${X(dm) + 3}" y="20" fill="#ffd166" font-size="10">median</text>
    <text x="4" y="${Y(ymax) + 4}" fill="var(--muted)" font-size="10">${ymax.toFixed(1)}</text><text x="4" y="${Y(0)}" fill="var(--muted)" font-size="10">0</text>
  </svg><p class="muted small">Horizontal axis: residents per km² (log scale).</p>`;
}

function renderDataInfo() {
  const b = state.bundle, s = b.sources;
  let water = 0, roadsN = b.roads.length;
  for (let i = 0; i < b.land.length; i++) if (b.land[i] < 0.5) water++;
  $('dataInfo').innerHTML = `<div class="stat">
    <div>City</div><div>${b.name}</div>
    <div>Centre</div><div>${b.lat0.toFixed(4)}, ${b.lon0.toFixed(4)}</div>
    <div>Study area</div><div>${2 * b.radiusKm} × ${2 * b.radiusKm} km</div>
    <div>Grid</div><div>${b.n} × ${b.n} cells of ${b.cellM} m</div>
    <div>Residents</div><div>${fmtNum(b.totalPop)}</div>
    <div>Mostly-water cells</div><div>${water}</div>
    <div>Road ways</div><div>${roadsN.toLocaleString()}</div>
    <div>Named places</div><div>${b.places.length}</div>
    <div>Bundle built</div><div>${b.builtAt}</div></div>
    <h3>Sources</h3><p><b>Population:</b> ${s.population}. Native resolution: ${s.populationResolution}.</p>
    <p><b>Roads:</b> ${s.roads}.</p><p><b>Places:</b> ${s.places}.</p>
    <p class="muted small">Every download is cached under <code>cache/</code> in the project folder: raw source data, OSM extracts and the processed bundle. Loading the same city, radius and cell size again reads from disk only. A different cell size reuses the cached raw data.</p>`;
}

// ------------------------------------------------------------------ ensemble (parallel workers)
let ensWorkers = [];
$('runEnsemble').onclick = () => {
  if (!state.bundle) return;
  const N = state.params.ensembleN;
  const P = Math.max(1, Math.min(N, (navigator.hardwareConcurrency || 4) - 1, 12));
  const seeds = Array.from({ length: N }, (_, r) => (state.params.seed | 0) + 7919 * (r + 1));
  const results = [];
  const doneBy = new Array(P).fill(0);
  const t0 = performance.now();
  ensWorkers.forEach((w) => w.terminate());
  ensWorkers = [];
  $('runEnsemble').disabled = true; $('stopEnsemble').disabled = false;
  for (let k = 0; k < P; k++) {
    const mine = seeds.filter((_, i) => i % P === k);
    const w = makeWorker();
    ensWorkers.push(w);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ensembleProgress') {
        doneBy[k] = m.done;
        const done = doneBy.reduce((a, b) => a + b, 0);
        const el = (performance.now() - t0) / 1000;
        $('ensStatus').textContent = `${done}/${N} runs on ${P} cores · ${el.toFixed(0)} s elapsed · ~${Math.max(0, el / done * (N - done)).toFixed(0)} s left`;
      } else if (m.type === 'ensembleResult') {
        results.push(...m.results);
        w.terminate();
        w._done = true;
        if (ensWorkers.every((x) => x._done)) finishEnsemble(results, t0);
      }
    };
    w.postMessage({ type: 'city', bundle: state.bundle });
    w.postMessage({ type: 'clicks', clicks: state.clicks });
    w.postMessage({ type: 'ensemble', params: { ...state.params }, seeds: mine });
  }
};
$('stopEnsemble').onclick = () => { ensWorkers.forEach((w) => w.postMessage({ type: 'abortEnsemble' })); };

function finishEnsemble(results, t0) {
  $('runEnsemble').disabled = false; $('stopEnsemble').disabled = true;
  $('ensStatus').textContent = `${results.length} runs in ${((performance.now() - t0) / 1000).toFixed(0)} s`;
  state.ensemble = results;
  // quantile bands on a common hourly grid (series sampled every 6 h)
  const tmax = Math.max(...results.map((r) => r.series[r.series.length - 1][0]));
  const grid = [];
  for (let t = 0; t <= tmax; t += 6) grid.push(t);
  const at = (ser, t, idx) => { let v = ser[0][idx]; for (const p of ser) { if (p[0] <= t) v = p[idx]; else break; } return v; };
  const band = (idx) => grid.map((t) => {
    const v = results.map((r) => at(r.series, t, idx)).sort((a, b) => a - b);
    const q = (f) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
    return [t, q(0.05), q(0.95), q(0.5)];
  });
  const bh = band(1), bz = band(2);
  const spaghetti = results.slice(0, 40).map((r) => ({ name: 'run', color: '#e5484d', points: r.series.map((p) => [p[0], p[2]]), width: 0.7, alpha: 0.25, noLegend: true }));
  ensChart.set([
    ...spaghetti,
    { name: 'Humans (median, 90% band)', color: '#3fb9a5', points: bh.map((p) => [p[0], p[3]]), band: bh.map((p) => [p[0], p[1], p[2]]), width: 2.2 },
    { name: 'Zombies (median, 90% band)', color: '#e5484d', points: bz.map((p) => [p[0], p[3]]), band: bz.map((p) => [p[0], p[1], p[2]]), width: 2.2 },
  ], { logY: true, xmax: state.params.days * 24 });
  const th = theory(state.bundle, engineRates(state.params), state.seeds);
  $('ensTable').innerHTML = ensembleSection(results, th, th.dens.total);
  renderReport();
}

// ------------------------------------------------------------------ tabs
for (const b of $('tabs').querySelectorAll('button')) {
  b.onclick = () => {
    for (const x of $('tabs').querySelectorAll('button')) x.classList.toggle('on', x === b);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab);
    if (b.dataset.tab === 'ensemble') ensChart.draw();
  };
}

initPresets().catch((e) => setStatus('Cannot reach the local server: ' + e.message, true));
