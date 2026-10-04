// ZombieSim engine: a stochastic (chain-binomial / tau-leap) or deterministic
// (mean-field) metapopulation model on a lattice of city cells coupled by
// walking and by vehicle trips over the OpenStreetMap road graph.
//
// Compartments per cell i:
//   S  susceptible humans          M  naturally immune humans
//   E1..Ek  bitten, incubating (Erlang-k)   Z  active zombies
//   D  corpses that may reanimate
// Absorbing tallies: killed humans, destroyed/decayed zombies, disposed
// corpses, evacuees. Units: hours, km. See MODEL.md for the full specification.

// ------------------------------------------------------------------ RNG

export class RNG {
  // xoshiro128** seeded through splitmix32
  constructor(seed) {
    let s = seed >>> 0;
    const sm = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    this.spare = null;
  }
  u32() {
    const r = Math.imul(this.rotl(Math.imul(this.b, 5), 7), 9) >>> 0;
    const t = this.b << 9;
    this.c ^= this.a; this.d ^= this.b; this.b ^= this.c; this.a ^= this.d;
    this.c ^= t; this.d = this.rotl(this.d, 11);
    return r;
  }
  rotl(x, k) { return ((x << k) | (x >>> (32 - k))) >>> 0; }
  // uniform in (0,1)
  next() { return (this.u32() + 0.5) / 4294967296; }
  gauss() {
    if (this.spare !== null) { const s = this.spare; this.spare = null; return s; }
    let u, v, q;
    do { u = 2 * this.next() - 1; v = 2 * this.next() - 1; q = u * u + v * v; } while (q >= 1 || q === 0);
    const m = Math.sqrt(-2 * Math.log(q) / q);
    this.spare = v * m;
    return u * m;
  }
  // Binomial(n, p). Exact inversion when the mean is small, otherwise a
  // continuity-corrected normal approximation (error O(1/sqrt(npq))).
  binom(n, p) {
    if (n <= 0 || p <= 0) return 0;
    if (p >= 1) return n;
    if (p > 0.5) return n - this.binom(n, 1 - p);
    if (n <= 10) { // direct Bernoulli trials: cheaper than inversion here
      let x = 0;
      for (let i = 0; i < n; i++) if (this.next() < p) x++;
      return x;
    }
    const mean = n * p;
    if (mean < 12) {
      const q = 1 - p, s = p / q, a = (n + 1) * s;
      let r = Math.exp(n * Math.log1p(-p)), u = this.next(), x = 0;
      while (u > r) {
        u -= r; x++;
        if (x > n) return n;
        r *= a / x - s;
        if (r <= 0) break;
      }
      return x;
    }
    const x = Math.round(mean + Math.sqrt(mean * (1 - p)) * this.gauss());
    return x < 0 ? 0 : x > n ? n : x;
  }
}

// 8-neighbourhood: E W S N SE NW NE SW  (opposite direction = d ^ 1)
export const DC = [1, -1, 0, 0, 1, -1, 1, -1];
export const DR = [0, 0, 1, -1, 1, -1, -1, 1];
const NONE = 255;
const CLASS_W = [6, 5, 4, 3, 2, 1];
const ATTO = 1e-3;  // deterministic-mode extinction threshold per cell
const HYBRID = 100; // see Simulation.B
const SLOW = 6; // multi-rate factor for normal-life movement away from the epidemic // road-choice weights for trip walks (motorway .. residential)

// ------------------------------------------------------------------ geometry

// Build lattice geometry from a city bundle (done once per city).
export function buildGeometry(b) {
  const n = b.n, N = n * n, Lm = b.cellM, L = Lm / 1000, R = b.radiusKm * 1000;
  const land = Float32Array.from(b.land);
  const pop = Float64Array.from(b.pop);
  const roadEdge = new Uint8Array(N * 8).fill(NONE); // best road class on edge i->dir
  const roadCell = new Uint8Array(N).fill(NONE);
  const nb = new Int32Array(N * 8).fill(-1);       // neighbour index, -1 = off-map
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c;
    for (let d = 0; d < 8; d++) {
      const rr = r + DR[d], cc = c + DC[d];
      if (rr >= 0 && rr < n && cc >= 0 && cc < n) nb[i * 8 + d] = rr * n + cc;
    }
  }
  const dirOf = (dc, dr) => { for (let d = 0; d < 8; d++) if (DC[d] === dc && DR[d] === dr) return d; return -1; };
  const inside = (c, r) => c >= 0 && c < n && r >= 0 && r < n;
  const step = Lm / 5;
  for (const w of b.roads) {
    const cls = w[0];
    const np = (w.length - 2) >> 1;
    let pc = null, pr = null;
    for (let p = 0; p < np; p++) {
      const x0 = w[2 + 2 * p], y0 = w[3 + 2 * p];
      const x1 = p + 1 < np ? w[4 + 2 * p] : x0, y1 = p + 1 < np ? w[5 + 2 * p] : y0;
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ns = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s < ns; s++) {
        const t = s / ns;
        const x = x0 + t * (x1 - x0), y = y0 + t * (y1 - y0);
        const c = Math.floor((x + R) / Lm), r = Math.floor((R - y) / Lm);
        if (inside(c, r)) { const i = r * n + c; if (cls < roadCell[i]) roadCell[i] = cls; }
        if (pc !== null && (c !== pc || r !== pr)) {
          const dc = c - pc, dr = r - pr;
          if (Math.abs(dc) <= 1 && Math.abs(dr) <= 1) {
            const d = dirOf(dc, dr);
            if (inside(pc, pr)) { const i = pr * n + pc; if (cls < roadEdge[i * 8 + d]) roadEdge[i * 8 + d] = cls; }
            if (inside(c, r)) { const j = r * n + c; if (cls < roadEdge[j * 8 + (d ^ 1)]) roadEdge[j * 8 + (d ^ 1)] = cls; }
          }
        }
        pc = c; pr = r;
      }
    }
  }
  // passability of each directed edge in [0,1]: land continuity or a road (bridge)
  const pass = new Float32Array(N * 8);
  const isExit = new Uint8Array(N * 8);
  for (let i = 0; i < N; i++) for (let d = 0; d < 8; d++) {
    const j = nb[i * 8 + d];
    const road = roadEdge[i * 8 + d] !== NONE ? 1 : 0;
    if (j >= 0) pass[i * 8 + d] = Math.max(Math.min(land[i], land[j]), road);
    else { pass[i * 8 + d] = Math.max(land[i], road); isExit[i * 8 + d] = 1; }
  }
  const dlen = new Float64Array(8);
  for (let d = 0; d < 8; d++) dlen[d] = (d < 4 ? 1 : Math.SQRT2) * L;
  const area = new Float64Array(N);
  for (let i = 0; i < N; i++) area[i] = Math.max(land[i], 0.02) * L * L;
  return { n, N, L, Lm, R, land, pop, roadEdge, roadCell, nb, pass, isExit, dlen, area };
}

// Monte-Carlo estimate of the vehicle-trip destination kernel of each road
// cell: W random walks on the road graph (class-weighted, no immediate
// U-turns) with exponentially distributed length. Destination -1 = left map.
export function buildTripKernel(g, tripKm, W = 16, seed = 99991) {
  const rng = new RNG(seed);
  const { N, nb, roadEdge, roadCell, dlen } = g;
  const start = new Int32Array(N + 1);
  const dest = [], prob = [];
  const tmp = new Map();
  for (let i = 0; i < N; i++) {
    start[i] = dest.length;
    if (roadCell[i] === NONE) continue;
    tmp.clear();
    for (let w = 0; w < W; w++) {
      let dist = -Math.log(rng.next()) * tripKm;
      let cur = i, prevD = -1, out = i;
      for (let hop = 0; hop < 600 && dist > 0; hop++) {
        let tot = 0;
        for (let d = 0; d < 8; d++) {
          const cl = roadEdge[cur * 8 + d];
          if (cl === NONE || (prevD >= 0 && d === (prevD ^ 1))) continue;
          tot += CLASS_W[cl];
        }
        if (tot === 0) { // dead end: allow U-turn
          if (prevD >= 0 && roadEdge[cur * 8 + (prevD ^ 1)] !== NONE) { prevD = prevD ^ 1; const nx = nb[cur * 8 + prevD]; if (nx < 0) { cur = -1; break; } cur = nx; dist -= dlen[prevD]; continue; }
          break;
        }
        let u = rng.next() * tot, pick = -1;
        for (let d = 0; d < 8; d++) {
          const cl = roadEdge[cur * 8 + d];
          if (cl === NONE || (prevD >= 0 && d === (prevD ^ 1))) continue;
          u -= CLASS_W[cl];
          if (u <= 0) { pick = d; break; }
        }
        if (pick < 0) break;
        const nx = nb[cur * 8 + pick];
        if (nx < 0) { cur = -1; break; }
        cur = nx; prevD = pick; dist -= dlen[pick];
      }
      out = cur;
      if (out !== i) tmp.set(out, (tmp.get(out) || 0) + 1 / W);
    }
    for (const [k, v] of tmp) { dest.push(k); prob.push(v); }
  }
  start[N] = dest.length;
  return { start, dest: Int32Array.from(dest), prob: Float32Array.from(prob) };
}

// ------------------------------------------------------------------ simulation

export class Simulation {
  constructor(geom, kernel, rates, seeds) {
    this.g = geom; this.K = kernel; this.r = rates;
    this.rng = new RNG(rates.seed);
    this.det = rates.deterministic;
    const N = geom.N, k = rates.k;
    this.k = k;
    this.S = new Float64Array(N); this.M = new Float64Array(N);
    this.E = new Float64Array(N * k); this.Z = new Float64Array(N); this.D = new Float64Array(N);
    this.H0 = new Float64Array(N);
    this.cellDead = new Float32Array(N);    // humans killed in cell (cumulative)
    this.cellTurned = new Float32Array(N);  // zombies created in cell (cumulative)
    this.arrival = new Float32Array(N).fill(-1);
    this.fallen = new Float32Array(N).fill(-1);
    // scratch
    this.dS = new Float64Array(N); this.dM = new Float64Array(N);
    this.dE = new Float64Array(N * k); this.dZ = new Float64Array(N);
    this.phi = new Float64Array(N); this.psi = new Float64Array(N);
    this.Htot = new Float64Array(N);
    this.q = new Float64Array(8);
    this.dest8 = new Int32Array(8);
    this.active = new Uint8Array(N);
    this.ePhi = new Float64Array(N); this.ePsi = new Float64Array(N);
    this.stepCount = 0;
    this.tripW = new Float64Array(64);
    this.t = 0;
    this.tDetect = -1;
    this.c = { turned: 0, bitten: 0, killed: 0, zDestroyed: 0, zSwept: 0, zDecayed: 0, disposed: 0,
               reanimated: 0, escapedH: 0, escapedE: 0, escapedZ: 0, trips: 0, immuneKilled: 0, truncated: 0 };
    this.series = [];
    this.peakZ = 0; this.tPeakZ = 0;
    this.initPopulation();
    this.seed(seeds);
    this.record();
  }

  initPopulation() {
    const { N, pop } = this.g;
    for (let i = 0; i < N; i++) {
      if (this.det) {
        this.M[i] = pop[i] * this.r.iota;
        this.S[i] = pop[i] - this.M[i];
      } else {
        const P = Math.round(pop[i]);
        this.M[i] = this.rng.binom(P, this.r.iota);
        this.S[i] = P - this.M[i];
      }
      this.H0[i] = this.S[i] + this.M[i];
    }
    // detailed-balance weights: resident population (floor avoids 0/0)
    this.pi = new Float64Array(N);
    for (let i = 0; i < N; i++) this.pi[i] = this.H0[i] + 0.5;
    // static part of normal-life walking rates (detailed balance w.r.t. pi)
    const g = this.g;
    this.baseQ = new Float64Array(N * 8);
    for (let i = 0; i < N; i++) for (let d = 0; d < 8; d++) {
      const e = i * 8 + d, j = g.nb[e];
      if (j < 0 || g.pass[e] <= 0) continue;
      this.baseQ[e] = (this.r.vH * g.pass[e] / (8 * g.dlen[d])) * 2 * this.pi[j] / (this.pi[i] + this.pi[j]);
    }
  }

  seed(cells) {
    this.seedTot = 0;
    for (const [i, z] of cells) {
      // patient zeros are drawn from the resident population where possible
      const take = Math.min(z, this.S[i]);
      this.S[i] -= take;
      this.Z[i] += z;
      this.seedTot += z;
      this.c.turned += z;
      this.cellTurned[i] += z;
      if (this.arrival[i] < 0) this.arrival[i] = 0;
    }
  }

  // time-varying policy state
  policy() {
    const r = this.r, t = this.t;
    const detected = this.tDetect >= 0;
    let resp = 0;
    if (detected) {
      const x = t - this.tDetect - r.respDelay;
      resp = x < 0 ? 0 : r.rampH <= 0 ? 1 : Math.min(1, x / r.rampH);
    }
    const responseStarted = detected && t >= this.tDetect + r.respDelay;
    return {
      detected, resp,
      pk: r.pk0 + (r.pk1 - r.pk0) * resp,
      shelter: detected ? r.shelter : 0,
      sweep: r.sweep * resp,
      exitsOpen: r.openBoundary && !(r.cordon && responseStarted),
    };
  }

  // Hybrid partitioning: transitions whose expected count exceeds HYBRID in
  // both outcomes are advanced by their mean (relative noise < 1/sqrt(HYBRID));
  // all others are sampled exactly. Integer counts are only required where
  // they matter (small populations).
  B(n, p) {
    if (this.det) return n * p;
    const m = n * p;
    if (m >= HYBRID && n - m >= HYBRID) return m;
    if (n % 1 === 0) return this.rng.binom(n, p);
    return Math.min(n, this.rng.binom(this.roundStoch(n), p));
  }
  roundStoch(x) { const f = Math.floor(x); return f + (this.rng.next() < x - f ? 1 : 0); }

  step() {
    const g = this.g, r = this.r, dt = r.dt, k = this.k, N = g.N;
    const pol = this.policy();
    this.pol = pol;
    const S = this.S, M = this.M, E = this.E, Z = this.Z, D = this.D;
    const c = this.c;

    // ---------------------------------------------------------- 1. local reactions
    const bEff = r.beta * (1 - pol.shelter);
    const pZdec = 1 - Math.exp(-(r.gamma + pol.sweep) * dt);
    const fracSwept = (r.gamma + pol.sweep) > 0 ? pol.sweep / (r.gamma + pol.sweep) : 0;
    const pProg = 1 - Math.exp(-k * r.sigma * dt);
    const pDleave = 1 - Math.exp(-(r.zeta + r.omega) * dt);
    const pReanim = r.zeta / (r.zeta + r.omega);
    for (let i = 0; i < N; i++) {
      const z = Z[i];
      let eTot = 0;
      for (let s = 0; s < k; s++) eTot += E[i * k + s];
      if (z <= 0 && eTot <= 0 && D[i] <= 0) continue;
      const H = S[i] + M[i] + eTot;
      let newE = 0, newD = 0, newZ = 0;
      if (z > 0 && H > 0) {
        // per-human encounter hazard (Holling II)
        const rho = H / g.area[i];
        const lam = (bEff * z) / (g.area[i] * (1 + bEff * r.tau * rho));
        const pEnc = 1 - Math.exp(-lam * dt);
        let wins = 0;
        // susceptible
        const nS = this.B(S[i], pEnc);
        if (nS > 0) {
          const w = this.B(nS, pol.pk), bitten = nS - w, killed = this.B(bitten, r.f);
          wins += w; S[i] -= bitten; newD += killed; newE += bitten - killed;
          c.bitten += bitten; c.killed += killed; this.cellDead[i] += killed;
        }
        // immune: can be killed, never infected
        const nM = this.B(M[i], pEnc);
        if (nM > 0) {
          const w = this.B(nM, pol.pk), bitten = nM - w, killed = this.B(bitten, r.f);
          wins += w; M[i] -= killed; c.killed += killed; c.immuneKilled += killed; this.cellDead[i] += killed;
          c.bitten += bitten;
        }
        // already incubating: may be killed (corpse can still reanimate)
        for (let s = 0; s < k; s++) {
          const e = E[i * k + s];
          if (e <= 0) continue;
          const nE = this.B(e, pEnc);
          if (nE <= 0) continue;
          const w = this.B(nE, pol.pk), killed = this.B(nE - w, r.f);
          wins += w; E[i * k + s] -= killed; newD += killed; c.killed += killed; this.cellDead[i] += killed;
        }
        const destroyed = Math.min(wins, z);
        Z[i] -= destroyed; c.zDestroyed += destroyed;
      }
      // zombie decay + military sweep (competing, one clock)
      if (Z[i] > 0) {
        const gone = this.B(Z[i], pZdec);
        const swept = this.B(gone, fracSwept);
        Z[i] -= gone; c.zSwept += swept; c.zDecayed += gone - swept;
      }
      // incubation progression E1 -> ... -> Ek -> Z (from start-of-step counts)
      let carry = 0;
      for (let s = 0; s < k; s++) {
        const e = E[i * k + s];
        const out = e > 0 ? this.B(e, pProg) : 0;
        E[i * k + s] = e - out + carry;
        carry = out;
      }
      newZ += carry;
      // corpses: reanimate or be disposed of
      if (D[i] > 0) {
        const leave = this.B(D[i], pDleave);
        const re = this.B(leave, pReanim);
        D[i] -= leave; newZ += re; c.reanimated += re; c.disposed += leave - re;
      }
      E[i * k] += newE;
      D[i] += newD;
      Z[i] += newZ;
      if (newZ > 0) { c.turned += newZ; this.cellTurned[i] += newZ; }
    }

    // ---------------------------------------------------------- 2. derived fields
    const Htot = this.Htot, phi = this.phi, psi = this.psi;
    for (let i = 0; i < N; i++) {
      let h = S[i] + M[i];
      for (let s = 0; s < k; s++) h += E[i * k + s];
      Htot[i] = h;
      phi[i] = Z[i] + h > 0 ? Z[i] / (Z[i] + h) : 0;           // local zombie share
      const rho = h / g.area[i];
      psi[i] = rho / (rho + 500);                                 // crowd attractiveness in [0,1)
    }
    this.refreshBias();

    const act = this.active;
    act.fill(0);
    for (let i = 0; i < N; i++) {
      if (Z[i] > 0) { act[i] = 1; for (let d = 0; d < 8; d++) { const j = g.nb[i * 8 + d]; if (j >= 0) act[j] = 1; } }
      else if (Htot[i] > 0) { for (let s = 0; s < k; s++) if (E[i * k + s] > 0) { act[i] = 1; break; } }
    }
    this.slowTick = this.stepCount % SLOW === 0;
    this.stepCount++;

    // ---------------------------------------------------------- 3. vehicle trips
    this.trips(pol);

    // ---------------------------------------------------------- 4. local movement
    this.refreshLocal();
    this.walk(pol);

    // ---------------------------------------------------------- 5. bookkeeping
    this.t += dt;
    if (this.tDetect < 0 && c.turned >= r.detectN) this.tDetect = this.t;
    let zt = 0;
    const cut = this.det ? ATTO : 0;
    for (let i = 0; i < N; i++) {
      if (cut) { // mean-field "atto-zombie" cutoff (fractions of an individual)
        if (Z[i] > 0 && Z[i] < cut) { c.truncated += Z[i]; Z[i] = 0; }
        if (D[i] > 0 && D[i] < cut) { c.truncated += D[i]; D[i] = 0; }
        for (let s = 0; s < k; s++) if (E[i * k + s] > 0 && E[i * k + s] < cut) { c.truncated += E[i * k + s]; E[i * k + s] = 0; }
      }
      zt += Z[i];
      if (this.arrival[i] < 0 && Z[i] >= 1) this.arrival[i] = this.t;
      if (this.fallen[i] < 0 && this.H0[i] >= 20) {
        let h = S[i] + M[i];
        for (let s = 0; s < k; s++) h += E[i * k + s];
        if (h < 0.1 * this.H0[i]) this.fallen[i] = this.t;
      }
    }
    if (zt > this.peakZ) { this.peakZ = zt; this.tPeakZ = this.t; }
    if (Math.floor(this.t + 1e-9) > Math.floor(this.series[this.series.length - 1].t + 1e-9)) this.record();
    else this.last = null;
  }

  refreshBias() {
    const N = this.g.N, r = this.r;
    for (let i = 0; i < N; i++) {
      this.ePhi[i] = Math.exp(-r.chiH * this.phi[i]);
      this.ePsi[i] = Math.exp(r.chiZ * this.psi[i]);
    }
  }

  // Multi-rate splitting: cells with no zombies in their 3x3 neighbourhood and
  // no incubating residents only carry "normal life" movement, which is slow
  // and density-preserving; it is integrated every SLOW steps with step
  // SLOW*dt. Everything near the epidemic is integrated every step.
  trips(pol) {
    const g = this.g, r = this.r, K = this.K;
    const dS = this.dS, dM = this.dM, dE = this.dE;
    dS.fill(0); dM.fill(0); dE.fill(0);
    const baseRate = r.tripRate * (1 - pol.shelter);
    const w = this.tripW, slowTick = this.slowTick;
    for (let i = 0; i < g.N; i++) {
      const H = this.Htot[i];
      if (H <= 0) continue;
      const a = K.start[i], b = K.start[i + 1];
      if (a === b) continue;
      const active = this.active[i] === 1;
      if (!active && !slowTick) continue;
      const dt = active ? r.dt : r.dt * SLOW;
      const panicLvl = this.phi[i] / (this.phi[i] + 0.02);
      const pr = r.panicTrips * panicLvl * (1 - r.congestion);
      const rate = baseRate + pr;
      if (rate <= 0) continue;
      // Destination law: normal trips use Metropolis acceptance
      // min(1, pi_j/pi_i) (density-preserving); panic trips are re-weighted
      // by exp(-chiH * phi_j) (flee zombies). Rejected trips stay home.
      let tot = 0;
      if (pr > 0) {
        let flee = 0;
        for (let m = a; m < b; m++) {
          const j = K.dest[m];
          flee += K.prob[m] * (j < 0 ? (pol.exitsOpen ? 1 : 0) : this.ePhi[j]);
        }
        for (let m = a; m < b; m++) {
          const j = K.dest[m], p = K.prob[m];
          const accB = j < 0 ? 0 : Math.min(1, this.pi[j] / this.pi[i]);
          const accP = flee > 0 ? (j < 0 ? (pol.exitsOpen ? 1 : 0) : this.ePhi[j]) / flee : 0;
          const x = (baseRate * p * accB + pr * p * accP) / rate;
          w[m - a] = x; tot += x;
        }
      } else {
        for (let m = a; m < b; m++) {
          const j = K.dest[m];
          const x = j < 0 ? 0 : K.prob[m] * Math.min(1, this.pi[j] / this.pi[i]);
          w[m - a] = x; tot += x;
        }
      }
      if (tot <= 0) continue;
      const pTrip = (1 - Math.exp(-rate * dt)) * Math.min(1, tot);
      for (let m = a; m < b; m++) w[m - a] /= tot;
      this.moveHumans(i, pTrip, w, K.dest, a, b - a, true);
    }
    this.applyHumanDeltas();
  }

  // Multinomial relocation of every human compartment of cell i: each person
  // leaves with prob pLeave, choosing slot s with prob w[s]; dests[off+s] < 0
  // means off-map (evacuated).
  moveHumans(i, pLeave, w, dests, off, m, isTrip) {
    const k = this.k;
    if (this.S[i] > 0) this.moveOne(this.S, this.dS, i, 1, 0, pLeave, w, dests, off, m, isTrip, false);
    if (this.M[i] > 0) this.moveOne(this.M, this.dM, i, 1, 0, pLeave, w, dests, off, m, isTrip, false);
    for (let s = 0; s < k; s++) if (this.E[i * k + s] > 0) this.moveOne(this.E, this.dE, i, k, s, pLeave, w, dests, off, m, isTrip, true);
  }

  moveOne(arr, darr, i, stride, sub, pLeave, w, dests, off, m, isTrip, isE) {
    const left = this.B(arr[i * stride + sub], pLeave);
    if (left <= 0) return;
    darr[i * stride + sub] -= left;
    if (left <= 12 && left % 1 === 0 && !this.det) {
      // few movers: one categorical draw each
      for (let n = 0; n < left; n++) {
        let u = this.rng.next(), s = 0;
        for (; s < m - 1; s++) { u -= w[s]; if (u <= 0) break; }
        while (s > 0 && w[s] <= 0) s--;
        const j = dests[off + s];
        if (j < 0) { this.c.escapedH += 1; if (isE) this.c.escapedE += 1; }
        else darr[j * stride + sub] += 1;
        if (isTrip) this.c.trips += 1;
      }
      return;
    }
    let rem = left, pr = 1;
    for (let s = 0; s < m && rem > 0; s++) {
      const p = w[s];
      if (p <= 0) continue;
      const x = pr - p <= 1e-12 ? rem : this.B(rem, Math.min(1, p / pr));
      pr -= p; rem -= x;
      if (x <= 0) continue;
      const j = dests[off + s];
      if (j < 0) { this.c.escapedH += x; if (isE) this.c.escapedE += x; }
      else darr[j * stride + sub] += x;
      if (isTrip) this.c.trips += x;
    }
    if (rem > 0) darr[i * stride + sub] += rem; // numerical leftovers stay home
  }

  applyHumanDeltas() {
    const S = this.S, M = this.M, E = this.E, N = this.g.N, k = this.k;
    for (let i = 0; i < N; i++) {
      S[i] += this.dS[i]; M[i] += this.dM[i];
      if (S[i] < 0) S[i] = 0;
      if (M[i] < 0) M[i] = 0;
    }
    for (let x = 0; x < N * k; x++) { E[x] += this.dE[x]; if (E[x] < 0) E[x] = 0; }
  }

  walkHumans(pol, dt, activeOnly) {
    const g = this.g, r = this.r, N = g.N;
    const q = this.q, w = this.tripW, dest = this.dest8;
    this.dS.fill(0); this.dM.fill(0); this.dE.fill(0);
    const aBase = r.aH * (1 - pol.shelter);
    const baseQ = this.baseQ, ePhi = this.ePhi;
    for (let i = 0; i < N; i++) {
      if (this.Htot[i] <= 0) continue;
      const active = this.active[i] === 1;
      if (active !== activeOnly) continue;
      let Q = 0;
      const panicLvl = r.panic * this.phi[i] / (this.phi[i] + 0.02);
      if (panicLvl > 0) {
        let fz = 0;
        for (let d = 0; d < 8; d++) {
          const e = i * 8 + d;
          if (g.pass[e] <= 0 || (g.isExit[e] && !pol.exitsOpen)) continue;
          const j = g.nb[e];
          fz += j >= 0 ? ePhi[j] : 1;
        }
        for (let d = 0; d < 8; d++) {
          const e = i * 8 + d;
          let qd = aBase * baseQ[e];
          if (g.pass[e] > 0 && !(g.isExit[e] && !pol.exitsOpen)) {
            const j = g.nb[e];
            qd += (r.vH * g.pass[e] / (8 * g.dlen[d])) * panicLvl * 8 * (j >= 0 ? ePhi[j] : 1) / fz;
          }
          q[d] = qd; Q += qd; dest[d] = g.nb[e];
        }
      } else {
        for (let d = 0; d < 8; d++) { const e = i * 8 + d; q[d] = aBase * baseQ[e]; Q += q[d]; dest[d] = g.nb[e]; }
      }
      if (Q > 0) {
        for (let d = 0; d < 8; d++) w[d] = q[d] / Q;
        this.moveHumans(i, 1 - Math.exp(-Q * dt), w, dest, 0, 8, false);
      }
    }
    this.applyHumanDeltas();
  }

  walkZombies(pol, dt) {
    const g = this.g, r = this.r, N = g.N, q = this.q, Z = this.Z, dZ = this.dZ, c = this.c, ePsi = this.ePsi;
    dZ.fill(0);
    for (let i = 0; i < N; i++) {
      const z = Z[i];
      if (z <= 0) continue;
      let fz = 0;
      for (let d = 0; d < 8; d++) {
        const e = i * 8 + d;
        if (g.pass[e] <= 0 || (g.isExit[e] && !pol.exitsOpen)) continue;
        const j = g.nb[e];
        fz += j >= 0 ? ePsi[j] : 1;
      }
      let Q = 0;
      for (let d = 0; d < 8; d++) {
        const e = i * 8 + d;
        let qd = 0;
        if (g.pass[e] > 0 && !(g.isExit[e] && !pol.exitsOpen)) {
          const j = g.nb[e];
          qd = (r.aZ * r.vZ * g.pass[e] / (8 * g.dlen[d])) * 8 * (j >= 0 ? ePsi[j] : 1) / fz;
        }
        q[d] = qd; Q += qd;
      }
      if (Q <= 0) continue;
      const left = this.B(z, 1 - Math.exp(-Q * dt));
      if (left <= 0) continue;
      dZ[i] -= left;
      let rem = left, pr = 1;
      for (let d = 0; d < 8 && rem > 0; d++) {
        const p = q[d] / Q;
        if (p <= 0) continue;
        const x = pr - p <= 1e-12 ? rem : this.B(rem, Math.min(1, p / pr));
        pr -= p; rem -= x;
        if (x <= 0) continue;
        const j = g.nb[i * 8 + d];
        if (j < 0) c.escapedZ += x; else dZ[j] += x;
      }
      if (rem > 0) dZ[i] += rem;
    }
    for (let i = 0; i < N; i++) { Z[i] += dZ[i]; if (Z[i] < 0) Z[i] = 0; }
  }

  // Sub-stepping keeps the per-substep jump probability <= 1 - 1/e so that
  // walkers are not artificially capped at one cell per step (speed L/dt).
  walk(pol) {
    const r = this.r, L = this.g.L, dt = r.dt;
    const nh = Math.max(1, Math.ceil(((r.aH + r.panic) * r.vH * dt / L) / 1.0));
    for (let s = 0; s < nh; s++) {
      this.walkHumans(pol, dt / nh, true);
      if (s < nh - 1) this.refreshLocal();
    }
    if (this.slowTick) this.walkHumans(pol, dt * SLOW, false);
    const nz = Math.max(1, Math.ceil((r.aZ * r.vZ * dt / L) / 1.0));
    for (let s = 0; s < nz; s++) this.walkZombies(pol, dt / nz);
  }

  // recompute human totals (fields phi/psi are held fixed within a step)
  refreshLocal() {
    const N = this.g.N, k = this.k;
    for (let i = 0; i < N; i++) {
      let h = this.S[i] + this.M[i];
      for (let s = 0; s < k; s++) h += this.E[i * k + s];
      this.Htot[i] = h;
    }
  }

  totals() {
    const N = this.g.N, k = this.k;
    let S = 0, M = 0, E = 0, Z = 0, D = 0;
    for (let i = 0; i < N; i++) {
      S += this.S[i]; M += this.M[i]; Z += this.Z[i]; D += this.D[i];
      for (let s = 0; s < k; s++) E += this.E[i * k + s];
    }
    return { S, M, E, Z, D, H: S + M + E };
  }

  record() {
    const T = this.totals(), c = this.c;
    this.series.push({
      t: this.t, S: T.S, M: T.M, E: T.E, Z: T.Z, D: T.D, H: T.H,
      killed: c.killed, lost: c.killed + c.turned - c.reanimated - (this.seedTot || 0), zRemoved: c.zDestroyed + c.zSwept + c.zDecayed, escapedH: c.escapedH, turned: c.turned,
    });
    this.last = T;
  }

  isOver() {
    const T = this.last || this.totals();
    this.last = T;
    return this.t >= this.r.hours - 1e-9 || (T && T.Z + T.E + T.D < (this.det ? 0.5 : 1) && this.t > 0);
  }

  // Per-cell humans / zombies for rendering
  snapshot() {
    const N = this.g.N, k = this.k;
    const H = new Float32Array(N), Z = new Float32Array(N), D = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let h = this.S[i] + this.M[i];
      for (let s = 0; s < k; s++) h += this.E[i * k + s];
      H[i] = h; Z[i] = this.Z[i]; D[i] = this.cellDead[i];
    }
    return { H, Z, D };
  }
}

// ------------------------------------------------------------------ seeding

export function chooseSeeds(geom, params, clicks, rng) {
  const { N, n, pop } = geom;
  const out = [];
  if (params.seedMode === 'click' && clicks.length) {
    for (const i of clicks) out.push([i, params.z0]);
    return out;
  }
  if (params.seedMode === 'center') {
    // most populated cell within 3 cells of the centre
    const c = Math.floor(n / 2);
    let best = c * n + c, bp = -1;
    for (let r = c - 3; r <= c + 3; r++) for (let cc = c - 3; cc <= c + 3; cc++) {
      const i = r * n + cc;
      if (pop[i] > bp) { bp = pop[i]; best = i; }
    }
    out.push([best, params.z0]);
    return out;
  }
  if (params.seedMode === 'densest') {
    let best = 0;
    for (let i = 0; i < N; i++) if (pop[i] > pop[best]) best = i;
    out.push([best, params.z0]);
    return out;
  }
  // population-weighted random sites
  let tot = 0;
  for (let i = 0; i < N; i++) tot += pop[i];
  for (let s = 0; s < params.sites; s++) {
    let u = rng.next() * tot;
    for (let i = 0; i < N; i++) { u -= pop[i]; if (u <= 0) { out.push([i, params.z0]); break; } }
  }
  return out;
}
