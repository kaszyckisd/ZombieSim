// Parameter catalogue. Every model rate the engine uses is defined here once,
// with units and an explanation; the control panel is generated from it.
// Time unit inside the engine is the HOUR; distances in km.

export const PARAM_GROUPS = [
  { id: 'outbreak', label: 'Outbreak' },
  { id: 'transmission', label: 'Transmission & disease' },
  { id: 'movement', label: 'Movement' },
  { id: 'response', label: 'Human response' },
  { id: 'sim', label: 'Simulation' },
];

export const PARAMS = [
  // ---------------------------------------------------------------- outbreak
  { id: 'seedMode', group: 'outbreak', label: 'Patient zero location', type: 'select',
    options: [['random', 'Random (population-weighted)'], ['click', 'Click on map'], ['center', 'City center'], ['densest', 'Densest cell']],
    def: 'random', help: 'Where the initial zombies appear. "Click on map" lets you place outbreak sites by clicking the map.' },
  { id: 'z0', group: 'outbreak', label: 'Initial zombies per site', min: 1, max: 200, step: 1, def: 3, unit: '',
    help: 'Number of zombies introduced at each outbreak site at t = 0.' },
  { id: 'sites', group: 'outbreak', label: 'Outbreak sites', min: 1, max: 10, step: 1, def: 1, unit: '',
    help: 'Number of independent outbreak locations (ignored in click mode: every click is a site).' },

  // ------------------------------------------------------------ transmission
  { id: 'beta', group: 'transmission', label: 'Spread rate β (search rate)', min: 0.0002, max: 0.05, def: 0.004, log: true, unit: 'km²/h',
    help: 'Area a zombie effectively searches per hour. The per-zombie encounter rate at human density ρ is c(ρ) = βρ / (1 + βτρ) (a Holling type II functional response).' },
  { id: 'handling', group: 'transmission', label: 'Attack handling time τ', min: 1, max: 120, step: 1, def: 15, unit: 'min',
    help: 'Time a zombie spends on each attack. It caps a zombie at 1/τ encounters per hour, however dense the crowd.' },
  { id: 'pk0', group: 'transmission', label: 'Human win probability (untrained)', min: 0, max: 0.95, step: 0.01, def: 0.25, unit: '',
    help: 'Probability that an encounter ends with the zombie destroyed rather than the human bitten, before any organized response.' },
  { id: 'fatal', group: 'transmission', label: 'Fatality rate f', min: 0, max: 1, step: 0.01, def: 0.30, unit: '',
    help: 'Fraction of bitten humans who are killed outright rather than escaping with a bite. Corpses of non-immune victims may reanimate.' },
  { id: 'immune', group: 'transmission', label: 'Immunity rate ι', min: 0, max: 0.5, step: 0.005, def: 0.01, unit: '',
    help: 'Fraction of the population naturally immune. Immune people can still be killed in an attack, but bites never turn them.' },
  { id: 'incub', group: 'transmission', label: 'Mean incubation 1/σ', min: 0.02, max: 96, def: 6, log: true, unit: 'h',
    help: 'Mean time from a (non-fatal) bite to turning. Incubating people behave like normal humans and can travel.' },
  { id: 'incubK', group: 'transmission', label: 'Incubation shape k (Erlang)', min: 1, max: 6, step: 1, def: 2, unit: '',
    help: 'Incubation is Erlang(k, kσ) distributed: k = 1 is exponential (memoryless), larger k is a more fixed delay.' },
  { id: 'reanim', group: 'transmission', label: 'Mean time to reanimation 1/ζ', min: 0.05, max: 168, def: 12, log: true, unit: 'h',
    help: 'Mean time for the corpse of a killed, non-immune victim to rise as a zombie.' },
  { id: 'dispose', group: 'transmission', label: 'Mean corpse disposal time 1/ω', min: 1, max: 720, def: 48, log: true, unit: 'h',
    help: 'Mean time until a corpse is destroyed, buried or burned. P(corpse reanimates) = ζ / (ζ + ω).' },
  { id: 'zLife', group: 'transmission', label: 'Zombie mean lifespan 1/γ', min: 1, max: 730, def: 60, log: true, unit: 'days',
    help: 'Zombies decompose or starve at rate γ.' },

  // ---------------------------------------------------------------- movement
  { id: 'zSpeed', group: 'movement', label: 'Zombie speed', min: 0.2, max: 25, def: 1.2, log: true, unit: 'km/h',
    help: 'Walking or running speed of a moving zombie. Zombies cannot drive; they cross water only on bridges and roads.' },
  { id: 'zActivity', group: 'movement', label: 'Zombie activity', min: 0, max: 1, step: 0.01, def: 0.5, unit: '',
    help: 'Fraction of time a zombie spends roaming rather than feeding or standing still.' },
  { id: 'zAttract', group: 'movement', label: 'Zombie attraction to crowds χz', min: 0, max: 10, step: 0.1, def: 3, unit: '',
    help: 'Strength of the zombies\' bias toward cells with more humans (a chemotaxis-like exponential weighting).' },
  { id: 'hWalk', group: 'movement', label: 'Human walking speed', min: 1, max: 10, step: 0.1, def: 4.5, unit: 'km/h', help: 'Speed of humans moving on foot.' },
  { id: 'hActivity', group: 'movement', label: 'Normal local mobility', min: 0, max: 0.5, step: 0.005, def: 0.05, unit: '',
    help: 'Fraction of time a person is out walking in normal life. Normal mobility is density-preserving: it satisfies detailed balance with respect to the census distribution, so neighbourhoods keep their population.' },
  { id: 'panic', group: 'movement', label: 'Panic flight intensity', min: 0, max: 1, step: 0.01, def: 0.5, unit: '',
    help: 'Maximum fraction of time spent fleeing when zombies are present. Panic reaches half this value at a 2% local zombie share.' },
  { id: 'flee', group: 'movement', label: 'Flight directionality χh', min: 0, max: 20, step: 0.5, def: 6, unit: '',
    help: 'How strongly fleeing humans choose neighbouring cells with a lower zombie share.' },
  { id: 'tripRate', group: 'movement', label: 'Normal vehicle trips', min: 0, max: 0.2, step: 0.005, def: 0.04, unit: '/person/h',
    help: 'Rate of car and transit trips along the road network in normal life. Incubating travellers carry the infection across town.' },
  { id: 'panicTrips', group: 'movement', label: 'Panic evacuation trips', min: 0, max: 0.5, step: 0.005, def: 0.08, unit: '/person/h',
    help: 'Extra trip rate at full panic. Destinations are biased away from zombies, and trips can leave the map (evacuation) if the boundary is open.' },
  { id: 'tripKm', group: 'movement', label: 'Mean trip length', min: 1, max: 40, step: 0.5, def: 6, unit: 'km',
    help: 'Mean length of a vehicle trip on the road graph (exponentially distributed).' },
  { id: 'congestion', group: 'movement', label: 'Panic traffic congestion', min: 0, max: 0.95, step: 0.01, def: 0.4, unit: '',
    help: 'Fraction of panic trips that fail because roads are gridlocked.' },

  // ---------------------------------------------------------------- response
  { id: 'detectN', group: 'response', label: 'Detection threshold', min: 1, max: 5000, def: 100, log: true, unit: 'zombies',
    help: 'Authorities recognise the outbreak once this many people have turned (cumulative).' },
  { id: 'shelter', group: 'response', label: 'Shelter-in-place compliance', min: 0, max: 0.95, step: 0.01, def: 0.5, unit: '',
    help: 'After detection, the fraction of contacts and normal trips removed by barricading and staying home. Scales β and normal mobility by (1 − s).' },
  { id: 'respDelay', group: 'response', label: 'Response delay', min: 0, max: 240, step: 1, def: 24, unit: 'h',
    help: 'Time from detection until an organized, armed response starts.' },
  { id: 'rampH', group: 'response', label: 'Response ramp-up', min: 0, max: 240, step: 1, def: 24, unit: 'h',
    help: 'The human win probability rises linearly from its untrained value to its armed value over this period.' },
  { id: 'pk1', group: 'response', label: 'Human win probability (armed)', min: 0, max: 0.99, step: 0.01, def: 0.5, unit: '',
    help: 'Per-encounter probability of destroying the zombie once the response is fully mobilised.' },
  { id: 'sweep', group: 'response', label: 'Military sweep rate', min: 0, max: 0.2, step: 0.001, def: 0.01, unit: '/h',
    help: 'Once the response is active, each zombie is independently hunted down at this rate (proactive clearance), scaled by the response ramp.' },
  { id: 'openBoundary', group: 'response', label: 'People can evacuate off-map', type: 'bool', def: true,
    help: 'If on, humans (and zombies) can leave through the map edge, via roads or on foot. Evacuees count as survivors who left.' },
  { id: 'cordon', group: 'response', label: 'Quarantine cordon at response', type: 'bool', def: false,
    help: 'If on, the map edge is sealed when the organized response begins: nobody leaves.' },

  // ---------------------------------------------------------------- simulation
  { id: 'mode', group: 'sim', label: 'Engine', type: 'select',
    options: [['stochastic', 'Stochastic (chain-binomial)'], ['deterministic', 'Deterministic (mean-field)']], def: 'stochastic',
    help: 'Stochastic mode draws every transition from its exact per-step binomial/multinomial law (so early die-out can happen). Deterministic mode uses expected values: an Euler-type discretisation of the corresponding ODE system.' },
  { id: 'dtMin', group: 'sim', label: 'Time step Δt', min: 1, max: 20, step: 1, def: 10, unit: 'min',
    help: 'Step size. Transition probabilities use 1 − exp(−rate·Δt), so they stay valid for any step; smaller steps reduce splitting error.' },
  { id: 'days', group: 'sim', label: 'Duration', min: 1, max: 120, step: 1, def: 30, unit: 'days', help: 'Simulated time horizon.' },
  { id: 'seed', group: 'sim', label: 'Random seed', min: 1, max: 999999, step: 1, def: 1337, unit: '', help: 'Seed for the xoshiro128** RNG, so runs are exactly reproducible.' },
  { id: 'ensembleN', group: 'sim', label: 'Ensemble size', min: 5, max: 200, step: 1, def: 24, unit: 'runs',
    help: 'Number of independent stochastic runs used for the Monte-Carlo confidence intervals.' },
];

export const SCENARIOS = {
  'Default (balanced)': {},
  'Romero (slow, classic)': { zSpeed: 0.8, zActivity: 0.4, incub: 18, incubK: 3, fatal: 0.5, reanim: 4, pk0: 0.3, handling: 20, beta: 0.003, zLife: 120 },
  '28 Days Later (rage virus)': { zSpeed: 14, zActivity: 0.8, incub: 0.03, incubK: 1, fatal: 0.1, reanim: 168, dispose: 24, pk0: 0.08, handling: 3, beta: 0.012, zLife: 28, zAttract: 5 },
  'World War Z (swarm)': { zSpeed: 10, zActivity: 0.9, incub: 0.2, incubK: 2, fatal: 0.05, pk0: 0.1, handling: 2, beta: 0.01, zAttract: 8, zLife: 365 },
  'Munz et al. 2009 analogue': { pk0: 0.34, pk1: 0.34, incub: 0.1, incubK: 1, fatal: 0.0, immune: 0, reanim: 24, dispose: 720, zLife: 730, shelter: 0, sweep: 0 },
  'Prepared city': { immune: 0.02, pk0: 0.4, pk1: 0.8, detectN: 10, respDelay: 3, rampH: 12, shelter: 0.8, sweep: 0.03 },
  'Total collapse': { pk0: 0.1, pk1: 0.25, detectN: 500, respDelay: 72, shelter: 0.2, sweep: 0, panicTrips: 0.2 },
};

export function defaultParams() {
  const p = {};
  for (const d of PARAMS) p[d.id] = d.def;
  return p;
}

// Convert UI parameters into engine rates (per hour, km).
export function engineRates(p) {
  return {
    beta: p.beta,
    tau: p.handling / 60,
    pk0: p.pk0, pk1: p.pk1,
    f: p.fatal, iota: p.immune,
    sigma: 1 / p.incub, k: Math.round(p.incubK),
    zeta: 1 / p.reanim, omega: 1 / p.dispose,
    gamma: 1 / (p.zLife * 24),
    vZ: p.zSpeed, aZ: p.zActivity, chiZ: p.zAttract,
    vH: p.hWalk, aH: p.hActivity, panic: p.panic, chiH: p.flee,
    tripRate: p.tripRate, panicTrips: p.panicTrips, tripKm: p.tripKm, congestion: p.congestion,
    detectN: p.detectN, shelter: p.shelter, respDelay: p.respDelay, rampH: p.rampH,
    sweep: p.sweep, openBoundary: !!p.openBoundary, cordon: !!p.cordon,
    deterministic: p.mode === 'deterministic', dt: p.dtMin / 60, hours: p.days * 24, seed: p.seed | 0,
  };
}
