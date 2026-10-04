export const METHODS_HTML = `
<h3>1. State space</h3>
<p>The study area is a square lattice of <i>n × n</i> cells of side <i>L</i>. Each cell <i>i</i> has land fraction ℓ<sub>i</sub> and effective area A<sub>i</sub> = max(ℓ<sub>i</sub>, 0.02)·L². Each cell holds non-negative counts:</p>
<span class="eq">S  susceptible humans        M  naturally immune humans
E₁…E_k  bitten, incubating  Z  active zombies
D  corpses that can reanimate
H = S + M + ΣE  (living humans)</span>
<p>Absorbing tallies record humans killed, zombies destroyed, swept or decayed, corpses disposed of, and people and zombies who left the map. Time is in hours. The initial condition is S + M = the census/grid population, with M ~ Binomial(pop, ι).</p>

<h3>2. Encounters (Holling type II)</h3>
<p>With human density ρ<sub>i</sub> = H<sub>i</sub>/A<sub>i</sub>, a zombie searching area β per hour, and handling time τ per attack, the per-zombie encounter rate is</p>
<span class="eq">c(ρ) = β ρ / (1 + β τ ρ)        (→ 1/τ as ρ → ∞)</span>
<p>Each living human therefore faces the hazard λ<sub>i</sub> = β Z<sub>i</sub> / (A<sub>i</sub>(1 + βτρ<sub>i</sub>)). Once the outbreak is detected, β is multiplied by (1 − s), where s is shelter-in-place compliance.</p>

<h3>3. Encounter outcomes</h3>
<p>An encounter destroys the zombie with probability p<sub>k</sub>(t). Otherwise the human is bitten, and is killed outright with probability f.</p>
<span class="eq">S bitten:  killed → D (may reanimate);  survives → E₁
M bitten:  killed → removed (never reanimates);  survives → M
E bitten:  killed → D;  survives → stays E</span>
<p>p<sub>k</sub>(t) = p<sub>k0</sub> + (p<sub>k1</sub> − p<sub>k0</sub>)·R(t), where the response level R(t) ramps linearly from 0 to 1. The ramp starts after the detection time plus a delay. Detection happens when cumulative turned ≥ N<sub>detect</sub>.</p>

<h3>4. Disease progression and corpses</h3>
<span class="eq">E_j → E_{j+1} → … → Z     rate kσ each stage   (incubation ~ Erlang(k, kσ), mean 1/σ)
D → Z at rate ζ,  D → disposed at rate ω    ⇒  P(reanimate) = ζ/(ζ+ω)
Z → removed at rate γ + η R(t)             (decay + military sweep)</span>

<h3>5. Movement</h3>
<p><b>Walking</b> is a continuous-time random walk on the 8-neighbour lattice. An edge i→j has passability π<sub>ij</sub> = max(min(ℓ<sub>i</sub>, ℓ<sub>j</sub>), 𝟙[road crosses i↔j]), so water can be crossed only on mapped roads (bridges). The jump rate is</p>
<span class="eq">q_ij = (v π_ij / (8 d_ij)) · a · B_ij       d_ij ∈ {L, √2 L}</span>
<p>Humans (v = walking speed) combine two terms. Normal mobility a₀(1−s) uses B<sub>ij</sub> = 2P<sub>j</sub>/(P<sub>i</sub>+P<sub>j</sub>), where P is the resident population. This satisfies <i>detailed balance</i>, P<sub>i</sub>q<sub>ij</sub> = P<sub>j</sub>q<sub>ji</sub>, so the census distribution is stationary. Panic flight a<sub>p</sub>·φ<sub>i</sub>/(φ<sub>i</sub>+0.02), with φ the local zombie share, uses B<sub>ij</sub> ∝ exp(−χ<sub>h</sub> φ<sub>j</sub>), normalised to mean 1. Zombies use activity a<sub>z</sub>, speed v<sub>z</sub> and B<sub>ij</sub> ∝ exp(χ<sub>z</sub> ψ<sub>j</sub>), with ψ = ρ/(ρ+500) (attraction to crowds). Zombies never drive.</p>
<p>For an unbiased zombie walk, the macroscopic diffusivity is D = ¼ Σ<sub>j</sub> q<sub>j</sub> d<sub>j</sub>² = a<sub>z</sub> v<sub>z</sub> L (1+√2)/8.</p>
<p><b>Vehicle trips.</b> For each cell touched by a road, the destination kernel K(i,·) is estimated by 16 random walks on the road graph. Each walk chooses edges with class weights (motorway 6 … residential 1), makes no U-turns, and has an Exp(mean trip length) length. Walks that leave the map count as evacuation. Normal trips occur at rate r<sub>0</sub>(1−s) with Metropolis acceptance min(1, P<sub>j</sub>/P<sub>i</sub>). Panic trips occur at rate r<sub>p</sub>(1−congestion)·φ/(φ+0.02), re-weighted by exp(−χ<sub>h</sub>φ<sub>j</sub>). Incubating travellers carry the infection across town, which gives long-range jumps.</p>
<p><b>Boundary.</b> If open, people can leave through map-edge cells (on foot, or by road for panic trips). A quarantine cordon closes the boundary when the response begins.</p>

<h3>6. Numerical scheme</h3>
<p>Each step of length Δt applies, in order: local reactions, then vehicle trips, then walking (Lie operator splitting). Every transition with total hazard h uses the exact per-step probability 1 − e<sup>−hΔt</sup>. Competing outcomes are split multinomially using sequential conditional binomials.</p>
<ul>
<li><b>Stochastic mode</b> is a chain-binomial (tau-leap) process. Binomials use exact inversion or Bernoulli sums for small means, and a normal approximation for large means. For hybrid partitioning, a transition whose expected count exceeds 100 in both outcomes is advanced by its mean (relative noise under 10%). Small populations of zombies, incubating people and corpses stay fully stochastic, so chance extinction is represented.</li>
<li><b>Deterministic mode</b> replaces every draw with its expectation, an explicit exponential-Euler scheme for the mean-field ODEs. A 10⁻³-individual cutoff removes unphysical "atto-zombies".</li>
<li>Walking is sub-stepped so that the per-substep jump probability stays ≤ 1 − 1/e. This means fast walkers are not capped at one cell per step. Normal-life movement in cells with no zombies within one cell and no incubating residents is integrated with a 6× longer step (multi-rate splitting).</li>
</ul>
<p>The engine checks conservation exactly: every initial resident is always accounted for as human, zombie, corpse, removed or evacuated.</p>

<h3>7. Analytical results (Theory tab)</h3>
<p>Linearising a single cell around Z = 0 (no movement), each zombie produces new zombies at rate c·q and is removed at rate μ = γ + η + c·p<sub>k</sub>, where</p>
<span class="eq">q = (1−p_k)(1−ι)[(1−f) + f ζ/(ζ+ω)]
R₀(ρ) = c(ρ) q / (γ + η + c(ρ) p_k)</span>
<p>R₀ < 1 whenever p<sub>k</sub> ≥ p* = (Q − (γ+η)/c)/(1+Q), with Q = (1−ι)[(1−f)+fζ/(ζ+ω)]. So a city is safe at every density once humans win more than about Q/(1+Q) of fights. The critical density solves c(ρ*) = (γ+η)/(q−p<sub>k</sub>):</p>
<span class="eq">ρ* = c* / (β(1 − τ c*)),   c* = (γ+η)/(q − p_k)</span>
<p>The early exponential growth rate r is the unique real root of the Euler–Lotka equation for the system {E₁..E<sub>k</sub>, Z, D}:</p>
<span class="eq">1 = c(1−p_k)(1−ι)[(1−f)(kσ/(kσ+r))^k + f ζ/(ζ+ω+r)] / (μ + r)</span>
<p>It is solved by bisection. The pulled-front (Fisher–KPP) speed from zombie motion alone is 2√(rD). Vehicle trips can only make the observed front faster, and the report compares the two. Each zombie's number of offspring is geometric: competing exponential clocks, with independent thinning. So a single zombie goes extinct with probability exactly 1/R₀, and z₀ zombies with probability R₀<sup>−z₀</sup>. The ensemble tab checks this against the fraction of stochastic runs that fade out early (Wilson 95% interval).</p>

<h3>8. Data</h3>
<ul>
<li><b>US cities:</b> 2020 Decennial Census (P.L. 94-171) block populations with land and water areas, from the Census TIGERweb REST service. Blocks are placed at their internal points. Blocks larger than a cell are spread over an equal-area disk.</li>
<li><b>Elsewhere:</b> the Meta/CIESIN High Resolution Settlement Layer (1 arc-second, about 30 m), read from cloud-optimised GeoTIFFs by HTTP range requests. Where HRSL has no coverage (e.g. China, Russia, Australia), the fallback is Kontur Population 2023 (H3 resolution-8 hexagons, about 0.74 km², derived from GHSL, HRSL and building footprints). Each hexagon's population is spread uniformly over its footprint. The land/water mask comes from OSM water polygons (even-odd rasterisation) plus sea flooded from directed OSM coastlines.</li>
<li><b>Roads and place names:</b> OpenStreetMap via the Overpass API.</li>
</ul>
<p>All downloads are cached on disk by the local server.</p>

<h3>9. Limitations</h3>
<p>The population is residential, with no daytime or commuter peaks. Behaviour is homogeneous within a cell. Buildings and indoor refuges are represented only through β and τ. The response is city-wide rather than spatially targeted. Parameters describe fictional zombies, so treat outputs as consequences of the stated assumptions, not predictions.</p>
`;
