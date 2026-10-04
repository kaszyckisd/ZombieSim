// Generates the written after-action report from simulation output.
import * as A from './analytics.js';
import { fmtNum } from './chart.js';

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function makeLocator(bundle) {
  const n = bundle.n, R = bundle.radiusKm * 1000, L = bundle.cellM;
  const rank = { neighbourhood: 0, quarter: 0, suburb: 1, borough: 2, village: 1, town: 2, city: 3 };
  const places = (bundle.places || []).filter((p) => p.name);
  const center = (i) => [-R + ((i % n) + 0.5) * L, R - (Math.floor(i / n) + 0.5) * L];
  return function name(i) {
    const [x, y] = center(i);
    let best = null, bd = Infinity;
    for (const p of places) {
      const d = Math.hypot(p.x - x, p.y - y) * (1 + 0.15 * (rank[p.kind] ?? 1));
      if (d < bd) { bd = d; best = p; }
    }
    if (best && bd < 3500) return best.name;
    const dist = Math.hypot(x, y) / 1000;
    if (dist < 0.8) return 'the city centre';
    const ang = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    return `${dist.toFixed(1)} km ${COMPASS[Math.round(ang / 22.5) % 16]} of centre`;
  };
}

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const hrs = (h) => h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
const dayOf = (h) => `day ${(h / 24).toFixed(1)}`;

function quantile(arr, q) {
  const a = arr.slice().sort((x, y) => x - y);
  if (!a.length) return NaN;
  const p = (a.length - 1) * q, i = Math.floor(p), f = p - i;
  return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

// Wilson score interval for a binomial proportion
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

export function theory(bundle, rates, seeds) {
  const km2 = (bundle.cellM / 1000) ** 2;
  const dens = A.weightedDensityStats(bundle.pop, bundle.land, km2);
  const r = rates;
  const rho = dens.median;
  const out = { dens };
  out.R0 = A.R0(r, rho, r.pk0);
  out.R0hi = A.R0(r, dens.p90, r.pk0);
  out.R0lo = A.R0(r, dens.p10, r.pk0);
  out.R0resp = A.R0(r, rho, r.pk1, r.shelter, r.sweep);
  out.growth = A.growthRate(r, rho, r.pk0);
  out.doubling = out.growth > 0 ? Math.LN2 / out.growth : Infinity;
  out.growthLo = A.growthRate(r, dens.p10, r.pk0);
  out.growthHi = A.growthRate(r, dens.p90, r.pk0);
  out.pStar = A.criticalWinProb(r, rho);
  out.pStarResp = A.criticalWinProb(r, rho, r.shelter, r.sweep);
  out.rhoStar = A.criticalDensity(r, r.pk0);
  out.Dz = A.zombieDiffusivity(r, bundle.cellM / 1000);
  out.fisher = A.fisherSpeed(r, rho, bundle.cellM / 1000, r.pk0);
  out.enc = A.encounterRate(r, rho);
  out.reanimP = r.zeta / (r.zeta + r.omega);
  // population above critical density
  let above = 0;
  for (let i = 0; i < bundle.pop.length; i++) {
    const d = bundle.pop[i] / (Math.max(bundle.land[i], 0.02) * km2);
    if (d > out.rhoStar) above += bundle.pop[i];
  }
  out.fracAbove = dens.total ? above / dens.total : 0;
  // extinction probability using the density at each seed cell
  if (seeds && seeds.length) {
    let pe = 1;
    for (const [i, z] of seeds) {
      const d = bundle.pop[i] / (Math.max(bundle.land[i], 0.02) * km2);
      pe *= A.extinctionProb(A.R0(r, d, r.pk0), z);
    }
    out.pExtinct = pe;
  }
  return out;
}

export function buildReport(ctx) {
  const { bundle, params, rates, frame, seeds, ensemble } = ctx;
  if (!frame) return '<p class="muted">Run a simulation to generate a report.</p>';
  const name = makeLocator(bundle);
  const th = theory(bundle, rates, seeds);
  const c = frame.counters, T = frame.totals, series = frame.series;
  const pop0 = th.dens.total;
  const lost = c.killed + c.turned - c.reanimated - seeds.reduce((a, s) => a + s[1], 0);
  const tNow = frame.t;
  const n = bundle.n;

  // ---------------------------------------------------------------- verdict
  const active = T.Z + T.E + T.D;
  let verdict;
  if (active < 1) {
    verdict = frame.tDetect < 0
      ? `The outbreak died out on its own before authorities noticed it, after ${fmtNum(c.turned)} people had turned.`
      : `The outbreak was contained. The last zombie was destroyed by ${dayOf(tNow)}, and ${pct(lost / pop0, 2)} of residents were lost.`;
  } else if (T.H < 0.05 * pop0) {
    verdict = `${bundle.name} has fallen: fewer than 5% of residents are still alive in the city after ${hrs(tNow)}.`;
  } else {
    verdict = `After ${hrs(tNow)} the outbreak is still active. ${fmtNum(T.Z)} zombies are roaming and ${pct(T.H / pop0)} of the original population is still alive in the city.`;
  }

  // ---------------------------------------------------------------- timeline
  const milestones = [];
  const seedNames = [...new Set(seeds.map(([i]) => name(i)))];
  const ms = []; // [time, text]
  ms.push([0, `<b>t = 0</b>: ${seeds.reduce((a, s) => a + s[1], 0)} zombie(s) appear near ${seedNames.join(', ')}.`]);
  if (frame.tDetect >= 0) {
    ms.push([frame.tDetect, `<b>${hrs(frame.tDetect)}</b>: the outbreak is detected (${rates.detectN} people have turned). Shelter-in-place advisories cut contacts by ${pct(rates.shelter, 0)}.`]);
    const tr = frame.tDetect + rates.respDelay;
    if (tr <= tNow) ms.push([tr, `<b>${hrs(tr)}</b>: an organised armed response begins${rates.cordon ? ' and the city is sealed' : ''}. It reaches full strength (human win probability ${pct(rates.pk1, 0)}) at ${hrs(tr + rates.rampH)}.`]);
  } else ms.push([tNow, 'Authorities never detected the outbreak.']);
  const thr = [0.001, 0.01, 0.1, 0.5];
  for (const f of thr) {
    const hit = series.find((s) => s.lost >= f * pop0);
    if (hit) ms.push([hit.t, `<b>${hrs(hit.t)}</b>: ${pct(f, f < 0.01 ? 1 : 0)} of the population has been killed or turned.`]);
  }
  if (frame.peakZ > 0) ms.push([frame.tPeakZ, `<b>${hrs(frame.tPeakZ)}</b>: zombies peak at <b>${fmtNum(frame.peakZ)}</b> active.`]);
  ms.sort((a, b) => a[0] - b[0]);
  for (const [, m] of ms) milestones.push(m);

  // ---------------------------------------------------------------- geography
  const arrival = frame.arrival, H0 = frame.H0;
  const seedSet = new Set(seeds.map((s) => s[0]));
  const placeStats = new Map();
  if (arrival) {
    for (let i = 0; i < arrival.length; i++) {
      if (bundle.pop[i] < 20) continue;
      const nm = name(i);
      if (/km .* of centre/.test(nm)) continue;
      let ps = placeStats.get(nm);
      if (!ps) { ps = { name: nm, first: Infinity, pop0: 0, h: 0, cells: 0 }; placeStats.set(nm, ps); }
      if (arrival[i] >= 0 && !seedSet.has(i)) ps.first = Math.min(ps.first, arrival[i]);
      ps.pop0 += bundle.pop[i]; ps.h += frame.H[i]; ps.cells++;
    }
  }
  const pl = [...placeStats.values()].filter((p) => p.pop0 > 500);
  const firstHit = pl.filter((p) => isFinite(p.first)).sort((a, b) => a.first - b.first).slice(0, 6);
  const holdouts = pl.filter((p) => isFinite(p.first)).sort((a, b) => b.h / b.pop0 - a.h / a.pop0).slice(0, 5);
  const worst = pl.slice().sort((a, b) => a.h / a.pop0 - b.h / b.pop0).slice(0, 5);
  const untouched = pl.filter((p) => !isFinite(p.first)).length;

  // front speed: OLS of distance-from-nearest-seed on arrival time
  let front = null;
  if (arrival) {
    const R = bundle.radiusKm * 1000, L = bundle.cellM;
    const cxy = (i) => [-R + ((i % n) + 0.5) * L, R - (Math.floor(i / n) + 0.5) * L];
    const sp = seeds.map(([i]) => cxy(i));
    const xs = [], ys = [];
    const tCut = frame.tDetect >= 0 ? frame.tDetect + rates.respDelay : Infinity; // pre-response invasion phase
    for (let i = 0; i < arrival.length; i++) {
      if (arrival[i] <= 0 || arrival[i] > tCut || bundle.pop[i] < 20) continue;
      const [x, y] = cxy(i);
      let d = Infinity;
      for (const [sx, sy] of sp) d = Math.min(d, Math.hypot(x - sx, y - sy));
      xs.push(arrival[i]); ys.push(d / 1000);
    }
    if (xs.length > 10) {
      const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
      const slope = sxy / sxx;
      front = { v: slope, r2: (sxy * sxy) / (sxx * syy), n: xs.length, maxD: Math.max(...ys), tCut };
    }
  }

  // ---------------------------------------------------------------- compose
  const src = bundle.sources;
  const areaKm2 = (bundle.n * bundle.cellM / 1000) ** 2;
  let h = `<p class="verdict">${verdict}</p>`;
  h += `<h3>Setting</h3><p>${bundle.name}: a ${(2 * bundle.radiusKm).toFixed(0)} × ${(2 * bundle.radiusKm).toFixed(0)} km study area (${fmtNum(areaKm2)} km²) with ${fmtNum(pop0)} residents on a ${n} × ${n} grid of ${bundle.cellM} m cells. Half of residents live at densities above <b>${fmtNum(th.dens.median)}/km²</b> (10th–90th percentile: ${fmtNum(th.dens.p10)}–${fmtNum(th.dens.p90)}/km²; peak cell ${fmtNum(th.dens.max)}/km²). Population comes from ${src.population}. Roads and place names come from ${src.roads}.</p>`;

  h += `<h3>What the mathematics predicts</h3><p>At the median density a zombie meets c = ${th.enc.toFixed(2)} people per hour (Holling type II, capped at 1/τ = ${(1 / rates.tau).toFixed(1)}). Each encounter creates a new zombie with probability ${A.newZombieProb(rates, rates.pk0).toFixed(3)} (a killed victim reanimates with probability ${th.reanimP.toFixed(2)}). So the basic reproduction number is <b>R₀ = ${th.R0.toFixed(2)}</b> (${th.R0lo.toFixed(2)} at the 10th-percentile density, ${th.R0hi.toFixed(2)} at the 90th).`;
  if (Math.abs(th.R0hi - th.R0lo) < 0.05 * th.R0) h += ` R₀ barely depends on density: both infection and zombie destruction happen through encounters, so R₀ → q/p<sub>k</sub> once γ ≪ c·p<sub>k</sub>. Density sets the <i>speed</i> of the outbreak instead: the growth rate r ranges from ${th.growthLo.toFixed(3)} /h at the 10th-percentile density to ${th.growthHi.toFixed(3)} /h at the 90th.`;
  if (th.R0 > 1) {
    h += ` The early outbreak grows at r = ${th.growth.toFixed(3)} /h, doubling every <b>${hrs(th.doubling)}</b>. From zombie movement alone, the Fisher–KPP front would advance at 2√(rD) = <b>${(th.fisher * 24).toFixed(2)} km/day</b> (D = ${th.Dz.toFixed(3)} km²/h).`;
    if (th.pExtinct !== undefined) h += ` Branching-process theory gives a <b>${pct(th.pExtinct)}</b> chance that the initial zombies die out by chance before the outbreak takes off.`;
  } else h += ' Because R₀ < 1, the outbreak should die out on its own.';
  h += ` To stop transmission at the median density, humans must win at least <b>${pct(th.pStar)}</b> of encounters untrained (untrained win probability: ${pct(rates.pk0, 0)}), or ${pct(th.pStarResp)} with shelter-in-place and sweeps in force (armed win probability: ${pct(rates.pk1, 0)}). Once the response is at full strength, R₀ falls to <b>${th.R0resp.toFixed(2)}</b>`;
  h += th.R0resp < 1 ? `, so once fully mobilised the city should gradually win${th.R0resp > 0.85 ? ' (slowly, because R₀ is close to 1)' : ''}.</p>` : ', which is still above 1: even the full response cannot stop the spread on its own.</p>';

  h += `<h3>Timeline</h3><ul>${milestones.map((m) => `<li>${m}</li>`).join('')}</ul>`;

  h += `<h3>Tally at ${hrs(tNow)}</h3><table class="tally">
    <tr><td>Humans alive in the city</td><td>${fmtNum(T.H)}</td><td>${pct(T.H / pop0)}</td></tr>
    <tr><td>&nbsp;· of whom immune</td><td>${fmtNum(T.M)}</td><td></td></tr>
    <tr><td>&nbsp;· of whom bitten &amp; incubating</td><td>${fmtNum(T.E)}</td><td></td></tr>
    <tr><td>Evacuated off-map</td><td>${fmtNum(c.escapedH)}</td><td>${pct(c.escapedH / pop0)}</td></tr>
    <tr><td>&nbsp;· carrying the infection out</td><td>${fmtNum(c.escapedE)}</td><td></td></tr>
    <tr><td>Killed by zombies</td><td>${fmtNum(c.killed)}</td><td>${pct(c.killed / pop0)}</td></tr>
    <tr><td>Turned into zombies (total)</td><td>${fmtNum(c.turned)}</td><td>${pct(c.turned / pop0)}</td></tr>
    <tr><td>&nbsp;· via reanimated corpses</td><td>${fmtNum(c.reanimated)}</td><td></td></tr>
    <tr><td>Zombies still active</td><td>${fmtNum(T.Z)}</td><td></td></tr>
    <tr><td>Zombies destroyed in encounters / sweeps / decay</td><td>${fmtNum(c.zDestroyed)} / ${fmtNum(c.zSwept)} / ${fmtNum(c.zDecayed)}</td><td></td></tr>
    <tr><td>Corpses disposed of / awaiting</td><td>${fmtNum(c.disposed)} / ${fmtNum(T.D)}</td><td></td></tr>
    <tr><td>Vehicle trips taken</td><td>${fmtNum(c.trips)}</td><td></td></tr>
  </table>`;

  h += '<h3>Geography of the outbreak</h3><p>';
  if (firstHit.length) h += `Zombies spread first to ${firstHit.map((p) => `${p.name} (${hrs(p.first)})`).join(', ')}. `;
  if (front && front.v > 0) {
    h += `A least-squares fit of arrival time against distance from the outbreak site (${front.n} cells) gives an average front speed during the pre-response invasion phase${isFinite(front.tCut) ? ` (t ≤ ${hrs(front.tCut)})` : ''} of <b>${(front.v * 24).toFixed(2)} km/day</b> (R² = ${front.r2.toFixed(2)}). `;
    if (th.fisher > 0) {
      const ratio = front.v / th.fisher;
      h += ratio > 1.5 ? `That is ${ratio.toFixed(1)}× the Fisher–KPP speed from zombie movement alone: vehicle trips of incubating people spread the outbreak by long jumps (a low R² points the same way). `
        : ratio < 0.67 ? `That is slower than the Fisher–KPP prediction (${(th.fisher * 24).toFixed(2)} km/day), because water, low-density areas and the human response slow the front. `
        : `That is consistent with the Fisher–KPP prediction of ${(th.fisher * 24).toFixed(2)} km/day. `;
    }
  }
  if (worst.length && worst[0].h / worst[0].pop0 < 0.9) h += `Hardest hit: ${worst.map((p) => `${p.name} (${pct(p.h / p.pop0, 0)} remaining)`).join(', ')}. `;
  const share = (p) => p.h / p.pop0 > 1.02 ? `${pct(p.h / p.pop0 - 1, 0)} more people than before, sheltering refugees` : `${pct(p.h / p.pop0, 0)} remaining`;
  if (holdouts.length) h += `Strongest holdouts among areas zombies reached: ${holdouts.map((p) => `${p.name} (${share(p)})`).join(', ')}. `;
  if (untouched) h += `${untouched} named areas never saw a zombie.`;
  h += '</p>';

  if (ensemble && ensemble.length) h += ensembleSection(ensemble, th, pop0);

  h += `<h3>Caveats</h3><p class="muted">These are model results, not forecasts. Population is residential (night-time), so daytime commuter concentrations are not represented. Normal mobility preserves the residential distribution by construction. Water barriers are resolved only at the ${bundle.cellM} m cell scale, and only roads mapped in OpenStreetMap (${bundle.roadDetail === 'all' ? 'all classes' : 'major roads only'}) count as bridges. ${rates.deterministic ? 'This run was deterministic, so it cannot show chance fade-out.' : 'This run was stochastic, so rerun with a different seed or use the ensemble to see the spread of outcomes.'}</p>`;
  return h;
}

export function ensembleSection(E, th, pop0) {
  const N = E.length;
  const q = (f, fn) => quantile(E.map(fn), f);
  const row = (label, fn, fmt) => `<tr><td>${label}</td><td>${fmt(q(0.5, fn))}</td><td>${fmt(q(0.05, fn))} – ${fmt(q(0.95, fn))}</td></tr>`;
  const fade = E.filter((e) => e.fadeOut).length;
  const cont = E.filter((e) => e.contained).length;
  const [lo, hi] = wilson(fade, N);
  let h = `<h3>Monte-Carlo ensemble (${N} runs)</h3><table class="tally"><tr><th></th><th>median</th><th>90% interval</th></tr>`;
  h += row('Survivors in city', (e) => e.survivors / e.pop, (v) => pct(v));
  h += row('Evacuated', (e) => e.escaped / e.pop, (v) => pct(v));
  h += row('Killed', (e) => e.killed / e.pop, (v) => pct(v, 2));
  h += row('Turned', (e) => e.turned, (v) => fmtNum(v));
  h += row('Peak zombies', (e) => e.peakZ, (v) => fmtNum(v));
  h += row('Time of peak', (e) => e.tPeakZ, (v) => hrs(v));
  h += row('Detection time', (e) => (e.tDetect < 0 ? Infinity : e.tDetect), (v) => (isFinite(v) ? hrs(v) : 'never'));
  h += '</table>';
  h += `<p>Outbreak contained by the end of the run in ${cont}/${N} runs (${pct(cont / N, 0)}). It faded out before detection in ${fade}/${N} runs (${pct(fade / N, 0)}; 95% Wilson interval ${pct(lo, 0)}–${pct(hi, 0)}).`;
  if (th.pExtinct !== undefined) {
    const ok = th.pExtinct >= lo && th.pExtinct <= hi;
    h += ` The branching-process prediction for early extinction is ${pct(th.pExtinct)}, which ${ok ? 'falls inside' : 'falls outside'} that interval${ok ? '' : '. Differences are expected when patient zero is placed at random, because seed density varies from run to run, and because the branching approximation ignores movement and the human response'}.`;
  }
  return h + '</p>';
}
