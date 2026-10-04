// Web Worker hosting the simulation so the UI stays responsive.
import { buildGeometry, buildTripKernel, Simulation, chooseSeeds, RNG } from './sim-core.js';
import { engineRates } from './params.js';

let geom = null, kernel = null, kernelKm = null;
let sim = null, running = false, hoursPerSec = 24, params = null, clicks = [];
let ensembleAbort = false;

function ensureKernel(rates) {
  if (!kernel || kernelKm !== rates.tripKm) {
    kernel = buildTripKernel(geom, rates.tripKm);
    kernelKm = rates.tripKm;
  }
}

function newSim(p, seedOverride) {
  const rates = engineRates(p);
  if (seedOverride !== undefined) rates.seed = seedOverride;
  ensureKernel(rates);
  const rng = new RNG(rates.seed ^ 0x5eed);
  const seeds = chooseSeeds(geom, p, clicks, rng);
  return { s: new Simulation(geom, kernel, rates, seeds), seeds };
}

function frame(final = false) {
  const snap = sim.snapshot();
  const T = sim.last || sim.totals();
  const msg = {
    type: 'frame', t: sim.t, tDetect: sim.tDetect, pol: sim.pol || sim.policy(), totals: T, counters: { ...sim.c },
    peakZ: sim.peakZ, tPeakZ: sim.tPeakZ, series: sim.series, H: snap.H, Z: snap.Z, D: snap.D, final,
    arrival: sim.arrival.slice(),
  };
  if (final) { msg.fallen = sim.fallen; msg.H0 = sim.H0; msg.cellTurned = sim.cellTurned; }
  postMessage(msg, [snap.H.buffer, snap.Z.buffer, snap.D.buffer]);
}

let lastTick = 0;
function loop() {
  if (!running || !sim) return;
  const now = performance.now();
  const wallDt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  const target = hoursPerSec === Infinity ? Infinity : sim.t + hoursPerSec * wallDt;
  const t0 = performance.now();
  while (sim.t < target && performance.now() - t0 < 40) {
    sim.step();
    if (sim.isOver()) break;
  }
  if (sim.isOver()) {
    running = false;
    sim.record();
    frame(true);
    postMessage({ type: 'done', t: sim.t });
    return;
  }
  frame(false);
  setTimeout(loop, 16);
}

async function ensemble(p, seedsList) {
  const N = seedsList.length;
  ensembleAbort = false;
  const results = [];
  const t0 = performance.now();
  for (let r = 0; r < N; r++) {
    if (ensembleAbort) break;
    const { s } = newSim({ ...p, mode: 'stochastic' }, seedsList[r]);
    while (!s.isOver()) s.step();
    s.record();
    const T = s.totals();
    const pop = s.H0.reduce((a, b) => a + b, 0);
    results.push({
      seed: seedsList[r],
      survivors: T.H, zombies: T.Z, killed: s.c.killed, escaped: s.c.escapedH, turned: s.c.turned,
      peakZ: s.peakZ, tPeakZ: s.tPeakZ, tDetect: s.tDetect, tEnd: s.t, pop,
      contained: T.Z + T.E + T.D < 1, fadeOut: T.Z + T.E + T.D < 1 && s.tDetect < 0,
      series: s.series.filter((_, i) => i % 6 === 0).map((x) => [x.t, x.H, x.Z]),
    });
    postMessage({ type: 'ensembleProgress', done: r + 1, N, elapsed: (performance.now() - t0) / 1000 });
    await new Promise((res) => setTimeout(res, 0)); // let abort messages in
  }
  postMessage({ type: 'ensembleResult', results });
}

onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'city':
      geom = buildGeometry(m.bundle);
      kernel = null; sim = null; running = false; clicks = [];
      postMessage({ type: 'cityReady', roadCells: geom.roadCell.reduce((a, c) => a + (c !== 255 ? 1 : 0), 0) });
      break;
    case 'clicks': clicks = m.clicks; break;
    case 'reset': {
      params = m.params; running = false;
      const t0 = performance.now();
      const { s, seeds } = newSim(params);
      sim = s;
      postMessage({ type: 'seeds', seeds, buildMs: performance.now() - t0 });
      frame(false);
      break;
    }
    case 'run':
      if (!sim) break;
      if (sim.isOver()) { frame(true); postMessage({ type: 'done', t: sim.t }); break; }
      running = true; lastTick = performance.now(); loop();
      break;
    case 'pause': running = false; break;
    case 'speed': hoursPerSec = m.hoursPerSec; break;
    case 'step':
      if (!sim) break;
      for (let i = 0; i < m.n && !sim.isOver(); i++) sim.step();
      frame(sim.isOver());
      break;
    case 'report':
      if (sim) frame(true);
      break;
    case 'ensemble': running = false; ensemble(m.params, m.seeds); break;
    case 'abortEnsemble': ensembleAbort = true; break;
  }
};
