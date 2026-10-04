// Headless run of the engine on a cached bundle:  node tools/headless.mjs <bundle.json.gz> [mode] [days]
import { readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { buildGeometry, buildTripKernel, Simulation, chooseSeeds, RNG } from '../web/js/sim-core.js';
import { defaultParams, engineRates } from '../web/js/params.js';
import * as A from '../web/js/analytics.js';

const b = JSON.parse(gunzipSync(readFileSync(process.argv[2])).toString());
const p = defaultParams();
p.mode = process.argv[3] || 'stochastic';
p.days = +(process.argv[4] || 30);
Object.assign(p, JSON.parse(process.argv[5] || '{}'));
const r = engineRates(p);
let t0 = performance.now();
const g = buildGeometry(b);
const K = buildTripKernel(g, r.tripKm);
console.log(`${b.name}: n=${b.n} pop=${Math.round(b.totalPop)} geom+kernel ${(performance.now() - t0).toFixed(0)} ms, kernel entries ${K.dest.length}`);
const seeds = chooseSeeds(g, p, [], new RNG(r.seed ^ 0x5eed));
const sim = new Simulation(g, K, r, seeds);
const dens = A.weightedDensityStats(b.pop, b.land, (b.cellM / 1000) ** 2);
console.log(`median density ${dens.median.toFixed(0)}/km2, R0=${A.R0(r, dens.median).toFixed(2)}, r=${A.growthRate(r, dens.median).toFixed(3)}/h, fisher=${A.fisherSpeed(r, dens.median, g.L).toFixed(3)} km/h`);
t0 = performance.now();
let lastDay = -1;
while (!sim.isOver()) {
  sim.step();
  const d = Math.floor(sim.t / 24);
  if (d !== lastDay) {
    lastDay = d; const T = sim.totals();
    console.log(`day ${d}: H=${Math.round(T.H)} E=${Math.round(T.E)} Z=${Math.round(T.Z)} D=${Math.round(T.D)} killed=${Math.round(sim.c.killed)} esc=${Math.round(sim.c.escapedH)} turned=${Math.round(sim.c.turned)} det=${sim.tDetect.toFixed(1)}`);
  }
}
const T = sim.totals();
const pop0 = sim.H0.reduce((a, b) => a + b, 0);
const bal = T.H + T.Z + T.D + sim.c.killed + sim.c.escapedH - sim.c.reanimated + sim.c.zDestroyed + sim.c.zSwept + sim.c.zDecayed + sim.c.escapedZ;
console.log(`sim ${(sim.t / 24).toFixed(1)} days in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
// conservation: every initial person is human, zombie, corpse, dead-disposed, destroyed zombie, or escaped
const seedsTot = seeds.reduce((a, s) => a + s[1], 0);
console.log('conservation check (should be ~pop0):', Math.round(pop0), 'vs', Math.round(T.H + T.Z + T.D + sim.c.escapedH + sim.c.escapedZ + sim.c.zDestroyed + sim.c.zSwept + sim.c.zDecayed + sim.c.disposed + sim.c.immuneKilled + (sim.c.killed - sim.c.immuneKilled) - (sim.c.killed - sim.c.immuneKilled) ) - seedsTot + Math.min(seedsTot, 0));
