// Closed-form / semi-analytic results for the local (single-cell) model,
// linearised around the zombie-free state. Used for live readouts and the
// written report. See MODEL.md for derivations.

// Holling type-II per-zombie encounter rate at human density rho (/km^2).
export function encounterRate(r, rho, shelter = 0) {
  const b = r.beta * (1 - shelter);
  return (b * rho) / (1 + b * r.tau * rho);
}

// Probability that one bite-encounter with a susceptible-or-immune human
// ultimately produces a new zombie (bitten non-immune survivor always turns;
// a killed non-immune victim reanimates with prob zeta/(zeta+omega)).
export function newZombieProb(r, pk) {
  const reanimP = r.zeta / (r.zeta + r.omega);
  return (1 - pk) * (1 - r.iota) * ((1 - r.f) + r.f * reanimP);
}

// Basic reproduction number at density rho: expected new zombies produced by
// one zombie over its lifetime in a fully susceptible population.
//   R0 = c q / (gamma + sweep + c pk)
export function R0(r, rho, pk = r.pk0, shelter = 0, sweep = 0) {
  const c = encounterRate(r, rho, shelter);
  const q = newZombieProb(r, pk);
  return (c * q) / (r.gamma + sweep + c * pk);
}

// Win probability humans need for R0 < 1 at density rho:
//   (1-p) Q = p + (gamma+sweep)/c  ->  p* = (Q - (gamma+sweep)/c) / (1 + Q)
export function criticalWinProb(r, rho, shelter = 0, sweep = 0) {
  const c = encounterRate(r, rho, shelter);
  const Q = newZombieProb(r, 0);
  return Math.max(0, (Q - (r.gamma + sweep) / c) / (1 + Q));
}

// Critical density rho* with R0(rho*) = 1, or Infinity if never reached.
export function criticalDensity(r, pk = r.pk0, shelter = 0, sweep = 0) {
  const q = newZombieProb(r, pk);
  if (q <= pk) return Infinity;
  const cStar = (r.gamma + sweep) / (q - pk);
  const b = r.beta * (1 - shelter);
  if (b * r.tau * cStar >= 1) return Infinity; // saturation cap 1/tau below c*
  return cStar / (b * (1 - r.tau * cStar));
}

// Malthusian growth rate r of the linearised system {E_1..E_k, Z, D}:
// the unique real root of the Euler-Lotka equation
//   1 = c(1-pk)(1-iota) [ (1-f) (k s/(k s + r))^k + f zeta/(zeta+omega+r) ] / (gamma + sweep + c pk + r)
export function growthRate(r, rho, pk = r.pk0, shelter = 0, sweep = 0) {
  const c = encounterRate(r, rho, shelter);
  const ks = r.k * r.sigma;
  const A = c * (1 - pk) * (1 - r.iota);
  const mu = r.gamma + sweep + c * pk;
  const F = (x) => (A * ((1 - r.f) * Math.pow(ks / (ks + x), r.k) + r.f * r.zeta / (r.zeta + r.omega + x))) / (mu + x) - 1;
  let lo = -Math.min(ks, r.zeta + r.omega, mu) + 1e-9;
  let hi = 1;
  while (F(hi) > 0 && hi < 1e6) hi *= 2;
  if (F(lo) < 0) return lo; // strongly subcritical
  for (let i = 0; i < 200; i++) {
    const m = 0.5 * (lo + hi);
    if (F(m) > 0) lo = m; else hi = m;
  }
  return 0.5 * (lo + hi);
}

// Macroscopic diffusivity of an unbiased zombie random walk on the 8-neighbour
// lattice with cell size L (km): D = (1/4) sum_j q_j d_j^2, q_j = a v / (8 d_j)
//   => D = a v L (1 + sqrt 2) / 8          [km^2/h]
export function zombieDiffusivity(r, L) {
  return (r.aZ * r.vZ * L * (1 + Math.SQRT2)) / 8;
}

// Fisher-KPP linear spreading speed c = 2 sqrt(r D) (km/h); a lower bound
// because long-range vehicle trips of incubating people are ignored.
export function fisherSpeed(r, rho, L, pk = r.pk0) {
  const g = growthRate(r, rho, pk);
  if (g <= 0) return 0;
  return 2 * Math.sqrt(g * zombieDiffusivity(r, L));
}

// Branching-process extinction probability for z0 initial zombies.
// Each zombie's offspring count is geometric (competing exponential clocks),
// thinning keeps it geometric, so P(extinct | one zombie) = min(1, 1/R0).
export function extinctionProb(R, z0) {
  if (!(R > 1)) return 1;
  return Math.pow(1 / R, z0);
}

// Population-weighted quantiles of density across cells.
export function weightedDensityStats(pop, land, cellKm2) {
  const items = [];
  let tot = 0;
  for (let i = 0; i < pop.length; i++) {
    if (pop[i] <= 0) continue;
    const a = Math.max(land[i], 0.02) * cellKm2;
    items.push([pop[i] / a, pop[i]]);
    tot += pop[i];
  }
  items.sort((a, b) => a[0] - b[0]);
  const q = (f) => {
    let acc = 0;
    for (const [d, w] of items) { acc += w; if (acc >= f * tot) return d; }
    return items.length ? items[items.length - 1][0] : 0;
  };
  return { median: q(0.5), p10: q(0.1), p90: q(0.9), max: items.length ? items[items.length - 1][0] : 0, total: tot };
}
