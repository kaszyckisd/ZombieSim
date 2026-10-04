# ZombieSim model specification

(Generated from `web/js/methods.js`.)


## 1. State space

The study area is a square lattice of *n × n* cells of side *L*. Each cell *i* has land fraction ℓ_i and effective area A_i = max(ℓ_i, 0.02)·L². Each cell holds non-negative counts:

```
S  susceptible humans        M  naturally immune humans
E₁…E_k  bitten, incubating  Z  active zombies
D  corpses that can reanimate
H = S + M + ΣE  (living humans)
```

Absorbing tallies record humans killed, zombies destroyed, swept or decayed, corpses disposed of, and people and zombies who left the map. Time is in hours. The initial condition is S + M = the census/grid population, with M ~ Binomial(pop, ι).

## 2. Encounters (Holling type II)

With human density ρ_i = H_i/A_i, a zombie searching area β per hour, and handling time τ per attack, the per-zombie encounter rate is

```
c(ρ) = β ρ / (1 + β τ ρ)        (→ 1/τ as ρ → ∞)
```

Each living human therefore faces the hazard λ_i = β Z_i / (A_i(1 + βτρ_i)). Once the outbreak is detected, β is multiplied by (1 − s), where s is shelter-in-place compliance.

## 3. Encounter outcomes

An encounter destroys the zombie with probability p_k(t). Otherwise the human is bitten, and is killed outright with probability f.

```
S bitten:  killed → D (may reanimate);  survives → E₁
M bitten:  killed → removed (never reanimates);  survives → M
E bitten:  killed → D;  survives → stays E
```

p_k(t) = p_k0 + (p_k1 − p_k0)·R(t), where the response level R(t) ramps linearly from 0 to 1. The ramp starts after the detection time plus a delay. Detection happens when cumulative turned ≥ N_detect.

## 4. Disease progression and corpses

```
E_j → E_{j+1} → … → Z     rate kσ each stage   (incubation ~ Erlang(k, kσ), mean 1/σ)
D → Z at rate ζ,  D → disposed at rate ω    ⇒  P(reanimate) = ζ/(ζ+ω)
Z → removed at rate γ + η R(t)             (decay + military sweep)
```

## 5. Movement

**Walking** is a continuous-time random walk on the 8-neighbour lattice. An edge i→j has passability π_ij = max(min(ℓ_i, ℓ_j), 𝟙[road crosses i↔j]), so water can be crossed only on mapped roads (bridges). The jump rate is

```
q_ij = (v π_ij / (8 d_ij)) · a · B_ij       d_ij ∈ {L, √2 L}
```

Humans (v = walking speed) combine two terms. Normal mobility a₀(1−s) uses B_ij = 2P_j/(P_i+P_j), where P is the resident population. This satisfies *detailed balance*, P_iq_ij = P_jq_ji, so the census distribution is stationary. Panic flight a_p·φ_i/(φ_i+0.02), with φ the local zombie share, uses B_ij ∝ exp(−χ_h φ_j), normalised to mean 1. Zombies use activity a_z, speed v_z and B_ij ∝ exp(χ_z ψ_j), with ψ = ρ/(ρ+500) (attraction to crowds). Zombies never drive.

For an unbiased zombie walk, the macroscopic diffusivity is D = ¼ Σ_j q_j d_j² = a_z v_z L (1+√2)/8.

**Vehicle trips.** For each cell touched by a road, the destination kernel K(i,·) is estimated by 16 random walks on the road graph. Each walk chooses edges with class weights (motorway 6 … residential 1), makes no U-turns, and has an Exp(mean trip length) length. Walks that leave the map count as evacuation. Normal trips occur at rate r_0(1−s) with Metropolis acceptance min(1, P_j/P_i). Panic trips occur at rate r_p(1−congestion)·φ/(φ+0.02), re-weighted by exp(−χ_hφ_j). Incubating travellers carry the infection across town, which gives long-range jumps.

**Boundary.** If open, people can leave through map-edge cells (on foot, or by road for panic trips). A quarantine cordon closes the boundary when the response begins.

## 6. Numerical scheme

Each step of length Δt applies, in order: local reactions, then vehicle trips, then walking (Lie operator splitting). Every transition with total hazard h uses the exact per-step probability 1 − e^−hΔt. Competing outcomes are split multinomially using sequential conditional binomials.

- **Stochastic mode** is a chain-binomial (tau-leap) process. Binomials use exact inversion or Bernoulli sums for small means, and a normal approximation for large means. For hybrid partitioning, a transition whose expected count exceeds 100 in both outcomes is advanced by its mean (relative noise under 10%). Small populations of zombies, incubating people and corpses stay fully stochastic, so chance extinction is represented.
- **Deterministic mode** replaces every draw with its expectation, an explicit exponential-Euler scheme for the mean-field ODEs. A 10⁻³-individual cutoff removes unphysical "atto-zombies".
- Walking is sub-stepped so that the per-substep jump probability stays ≤ 1 − 1/e. This means fast walkers are not capped at one cell per step. Normal-life movement in cells with no zombies within one cell and no incubating residents is integrated with a 6× longer step (multi-rate splitting).

The engine checks conservation exactly: every initial resident is always accounted for as human, zombie, corpse, removed or evacuated.

## 7. Analytical results (Theory tab)

Linearising a single cell around Z = 0 (no movement), each zombie produces new zombies at rate c·q and is removed at rate μ = γ + η + c·p_k, where

```
q = (1−p_k)(1−ι)[(1−f) + f ζ/(ζ+ω)]
R₀(ρ) = c(ρ) q / (γ + η + c(ρ) p_k)
```

R₀ < 1 whenever p_k ≥ p* = (Q − (γ+η)/c)/(1+Q), with Q = (1−ι)[(1−f)+fζ/(ζ+ω)]. So a city is safe at every density once humans win more than about Q/(1+Q) of fights. The critical density solves c(ρ*) = (γ+η)/(q−p_k):

```
ρ* = c* / (β(1 − τ c*)),   c* = (γ+η)/(q − p_k)
```

The early exponential growth rate r is the unique real root of the Euler–Lotka equation for the system {E₁..E_k, Z, D}:

```
1 = c(1−p_k)(1−ι)[(1−f)(kσ/(kσ+r))^k + f ζ/(ζ+ω+r)] / (μ + r)
```

It is solved by bisection. The pulled-front (Fisher–KPP) speed from zombie motion alone is 2√(rD). Vehicle trips can only make the observed front faster, and the report compares the two. Each zombie's number of offspring is geometric: competing exponential clocks, with independent thinning. So a single zombie goes extinct with probability exactly 1/R₀, and z₀ zombies with probability R₀^−z₀. The ensemble tab checks this against the fraction of stochastic runs that fade out early (Wilson 95% interval).

## 8. Data

- **US cities:** 2020 Decennial Census (P.L. 94-171) block populations with land and water areas, from the Census TIGERweb REST service. Blocks are placed at their internal points. Blocks larger than a cell are spread over an equal-area disk.
- **Elsewhere:** the Meta/CIESIN High Resolution Settlement Layer (1 arc-second, about 30 m), read from cloud-optimised GeoTIFFs by HTTP range requests. Where HRSL has no coverage (e.g. China, Russia, Australia), the fallback is Kontur Population 2023 (H3 resolution-8 hexagons, about 0.74 km², derived from GHSL, HRSL and building footprints). Each hexagon's population is spread uniformly over its footprint. The land/water mask comes from OSM water polygons (even-odd rasterisation) plus sea flooded from directed OSM coastlines.
- **Roads and place names:** OpenStreetMap via the Overpass API.

All downloads are cached on disk by the local server.

## 9. Limitations

The population is residential, with no daytime or commuter peaks. Behaviour is homogeneous within a cell. Buildings and indoor refuges are represented only through β and τ. The response is city-wide rather than spatially targeted. Parameters describe fictional zombies, so treat outputs as consequences of the stated assumptions, not predictions.

