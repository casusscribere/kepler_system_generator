/*
 * Procedural Solar System — seeded generation + elliptical/eccentric orbits
 *
 * A whole star system is derived deterministically from a short seed string.
 * The same seed always reproduces the same system, so a seed can be copied,
 * shared (it also lives in the URL hash), and re-loaded later. Orbits are true
 * Keplerian ellipses with the star at one focus; bodies obey Kepler's equation
 * (speed up at periapsis, slow at apoapsis) and Kepler's 3rd law (period grows
 * with semi-major axis).
 */

const TWO_PI = Math.PI * 2;

// ---- seeded PRNG ---------------------------------------------------------
// xmur3 hashes a string to a 32-bit seed; mulberry32 turns that into a fast,
// well-distributed stream of floats in [0, 1). Deterministic per seed.

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convenience wrapper around a seeded stream.
function makeRng(seed) {
  const next = mulberry32(xmur3(seed)());
  const api = {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // approx. normal via two samples; handy for clustering values near a mean
    gauss: () => (next() + next() + next() - 1.5) / 1.5,
  };
  return api;
}

// ---- generation tables ---------------------------------------------------

// Main-sequence spectral classes, weighted by real-ish abundance (M common,
// O rare). Drives the star's colour and size.
const STAR_TYPES = [
  { cls: 'M', color: [255, 150, 90],  minR: 16, maxR: 22, weight: 46 },
  { cls: 'K', color: [255, 190, 120], minR: 18, maxR: 24, weight: 24 },
  { cls: 'G', color: [255, 225, 150], minR: 20, maxR: 26, weight: 14 },
  { cls: 'F', color: [255, 245, 220], minR: 22, maxR: 28, weight: 8  },
  { cls: 'A', color: [210, 225, 255], minR: 24, maxR: 32, weight: 5  },
  { cls: 'B', color: [170, 200, 255], minR: 28, maxR: 38, weight: 2  },
  { cls: 'O', color: [150, 180, 255], minR: 32, maxR: 44, weight: 1  },
];

const PLANET_CLASSES = {
  rocky:  { rMin: 3,  rMax: 8,  palette: [[180,170,160],[200,160,120],[160,140,130],[210,120,90]] },
  desert: { rMin: 5,  rMax: 9,  palette: [[220,180,120],[230,150,90],[200,170,110]] },
  ocean:  { rMin: 6,  rMax: 10, palette: [[90,140,230],[70,170,200],[110,160,255]] },
  ice:    { rMin: 4,  rMax: 9,  palette: [[200,225,240],[180,210,235],[210,230,255]] },
  gas:    { rMin: 12, rMax: 22, palette: [[210,170,130],[200,180,150],[180,160,200],[170,190,210]] },
};

function weightedStar(rng) {
  const total = STAR_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = rng.next() * total;
  for (const t of STAR_TYPES) {
    if ((r -= t.weight) <= 0) return t;
  }
  return STAR_TYPES[0];
}

function jitterColor(rng, c) {
  return [
    constrain(c[0] + rng.int(-18, 18), 0, 255),
    constrain(c[1] + rng.int(-18, 18), 0, 255),
    constrain(c[2] + rng.int(-18, 18), 0, 255),
  ];
}

// ---- the generator -------------------------------------------------------
// Builds { star, bodies } from a seed. Inner planets skew rocky/desert, outer
// skew gas/ice. Spacing is geometric (Titius–Bode-like). Period comes from
// Kepler's 3rd law so the whole system stays physically coherent.

function generateSystem(seed) {
  const rng = makeRng(seed);

  const st = weightedStar(rng);
  const star = {
    cls: st.cls,
    radius: rng.range(st.minR, st.maxR),
    color: st.color,
  };

  const bodies = [];
  const numPlanets = rng.int(3, 8);
  let a = rng.range(64, 92); // first orbit's semi-major axis

  for (let i = 0; i < numPlanets; i++) {
    const frac = numPlanets > 1 ? i / (numPlanets - 1) : 0; // 0 inner -> 1 outer

    // Pick a class biased by distance from the star.
    let type;
    if (frac < 0.33) type = rng.pick(['rocky', 'rocky', 'desert', 'ocean']);
    else if (frac < 0.66) type = rng.pick(['rocky', 'desert', 'ocean', 'ice', 'gas']);
    else type = rng.pick(['gas', 'gas', 'ice', 'ice']);
    const pc = PLANET_CLASSES[type];

    // Eccentricity: usually gentle, with an occasional eccentric standout.
    let e = Math.min(0.6, Math.abs(rng.gauss()) * 0.14);
    if (rng.chance(0.12)) e = rng.range(0.35, 0.6);

    // Kepler's 3rd law: T ∝ a^(3/2). Scaled so inner orbits take a few seconds.
    const period = 4.0 * Math.pow(a / 70, 1.5) * rng.range(0.9, 1.1);

    const radius = rng.range(pc.rMin, pc.rMax);
    const planet = {
      name: `${star.cls}-${i + 1}`,
      type,
      a,
      e,
      period,
      peri: rng.range(0, TWO_PI),
      M0: rng.range(0, TWO_PI),
      radius,
      color: jitterColor(rng, rng.pick(pc.palette)),
      moons: [],
    };

    // Bigger / outer worlds get moons.
    const maxMoons = type === 'gas' ? 4 : type === 'ocean' || type === 'ice' ? 2 : 1;
    const numMoons = rng.chance(radius > 9 ? 0.85 : 0.35) ? rng.int(1, maxMoons) : 0;
    let ma = radius + rng.range(6, 12);
    for (let m = 0; m < numMoons; m++) {
      planet.moons.push({
        a: ma,
        e: rng.range(0, 0.12),
        period: rng.range(1.2, 3.5),
        peri: rng.range(0, TWO_PI),
        M0: rng.range(0, TWO_PI),
        radius: rng.range(1.5, Math.max(2, radius * 0.28)),
        color: jitterColor(rng, [200, 200, 210]),
      });
      ma += rng.range(6, 12);
    }

    bodies.push(planet);
    a *= rng.range(1.38, 1.72); // geometric spacing to the next orbit
  }

  // 0–2 comets on long, highly eccentric orbits.
  const numComets = rng.chance(0.6) ? rng.int(1, 2) : 0;
  for (let c = 0; c < numComets; c++) {
    bodies.push({
      name: `comet-${c + 1}`,
      type: 'comet',
      comet: true,
      a: a * rng.range(0.7, 1.2),
      e: rng.range(0.6, 0.9),
      period: 28 * rng.range(0.8, 1.6),
      peri: rng.range(0, TWO_PI),
      M0: rng.range(0, TWO_PI),
      radius: rng.range(2.5, 3.5),
      color: jitterColor(rng, [180, 230, 255]),
      moons: [],
    });
  }

  return { star, bodies };
}

// ---- runtime state -------------------------------------------------------

let seed = '';
let system = null;

let t = 0;
let speed = 1;
let paused = false;
let showOrbits = true;
let showTrails = true;

let zoom = 1;
let panX = 0, panY = 0;
let dragging = false, lastX = 0, lastY = 0;

let stars = [];   // background starfield
let trails = [];  // per-body recent positions

// -------------------------------------------------------------------------

function setup() {
  createCanvas(windowWidth, windowHeight);
  seedStarfield();
  // Seed priority: URL hash (shareable link) > a fresh random seed.
  const fromHash = decodeURIComponent((window.location.hash || '').replace(/^#/, '')).trim();
  loadSystem(fromHash || randomSeed(), false);
  wireUI();
}

function randomSeed() {
  // Short, readable, copy-pasteable. Browser Math.random is fine here.
  let s = '';
  for (let i = 0; i < 7; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s.toUpperCase();
}

// Generate (or regenerate) the system for a seed and reset the view to fit it.
function loadSystem(newSeed, autoFit = true) {
  seed = newSeed || randomSeed();
  system = generateSystem(seed);

  t = 0; panX = 0; panY = 0;
  resetTrails();

  if (autoFit) fitView();
  else fitView();

  // Reflect the seed everywhere the user might read or copy it.
  const input = document.getElementById('seed');
  if (input) input.value = seed;
  const info = document.getElementById('info');
  if (info) {
    const planets = system.bodies.filter((b) => !b.comet).length;
    const comets = system.bodies.filter((b) => b.comet).length;
    info.textContent =
      `${system.star.cls}-class star · ${planets} planet${planets === 1 ? '' : 's'}` +
      (comets ? ` · ${comets} comet${comets === 1 ? '' : 's'}` : '');
  }
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', '#' + encodeURIComponent(seed));
  }
}

// Zoom so the outermost apoapsis comfortably fits on screen.
function fitView() {
  let maxR = system.star.radius;
  for (const b of system.bodies) maxR = Math.max(maxR, b.a * (1 + b.e));
  const margin = 0.46 * Math.min(width, height);
  zoom = constrain(margin / maxR, 0.2, 4);
}

function seedStarfield() {
  stars = [];
  const n = Math.floor((width * height) / 2400);
  for (let i = 0; i < n; i++) {
    stars.push({
      x: random(-width, width * 2),
      y: random(-height, height * 2),
      r: random(0.3, 1.4),
      tw: random(TWO_PI),
    });
  }
}

function resetTrails() {
  trails = system ? system.bodies.map(() => []) : [];
}

// ---- orbital mechanics ---------------------------------------------------

// Solve Kepler's equation  M = E - e*sin(E)  for E via Newton-Raphson.
function solveKepler(M, e) {
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-6) break;
  }
  return E;
}

// {x, y} of a body on its ellipse, with the focus (the star) at (0,0).
function orbitalPosition(o, time) {
  const n = TWO_PI / o.period;
  const M = o.M0 + n * time;
  const E = solveKepler(M, o.e);

  const b = o.a * Math.sqrt(1 - o.e * o.e);
  const px = o.a * (Math.cos(E) - o.e);
  const py = b * Math.sin(E);

  const c = Math.cos(o.peri), s = Math.sin(o.peri);
  return { x: px * c - py * s, y: px * s + py * c };
}

// ---- render loop ---------------------------------------------------------

function draw() {
  background(5, 6, 13);

  if (!paused) t += (deltaTime / 1000) * speed;

  push();
  translate(width / 2 + panX, height / 2 + panY);
  scale(zoom);

  drawStarfield();
  drawStar();

  for (let i = 0; i < system.bodies.length; i++) {
    const body = system.bodies[i];
    if (showOrbits) drawOrbitPath(body);

    const p = orbitalPosition(body, t);

    if (showTrails) updateAndDrawTrail(i, p, body);
    drawBody(p, body);

    if (body.moons) {
      for (const moon of body.moons) {
        const mp = orbitalPosition(moon, t);
        if (showOrbits) drawOrbitPath(moon, p);
        drawBody({ x: p.x + mp.x, y: p.y + mp.y }, moon);
      }
    }
  }

  pop();
}

function drawStarfield() {
  noStroke();
  for (const s of stars) {
    const a = 140 + 100 * Math.sin(t * 2 + s.tw);
    fill(255, 255, 255, a);
    circle(s.x - width / 2, s.y - height / 2, s.r);
  }
}

function drawStar() {
  const col = system.star.color;
  const R = system.star.radius;
  noStroke();
  for (let r = R * 4; r > R; r -= 4) {
    const a = map(r, R, R * 4, 60, 0);
    fill(col[0], col[1], col[2], a);
    circle(0, 0, r * 2);
  }
  fill(col[0], col[1], col[2]);
  circle(0, 0, R * 2);
}

function drawOrbitPath(o, center) {
  const cx = center ? center.x : 0;
  const cy = center ? center.y : 0;
  noFill();
  stroke(120, 140, 220, center ? 50 : 70);
  strokeWeight(1 / zoom);
  const b = o.a * Math.sqrt(1 - o.e * o.e);
  const c = Math.cos(o.peri), s = Math.sin(o.peri);
  beginShape();
  for (let E = 0; E <= TWO_PI + 0.05; E += 0.05) {
    const px = o.a * (Math.cos(E) - o.e);
    const py = b * Math.sin(E);
    vertex(cx + px * c - py * s, cy + px * s + py * c);
  }
  endShape();
}

function updateAndDrawTrail(i, p, body) {
  const tr = trails[i];
  tr.push({ x: p.x, y: p.y });
  const maxLen = body.comet ? 90 : 45;
  if (tr.length > maxLen) tr.shift();

  noFill();
  strokeWeight((body.radius * 0.6) / zoom);
  for (let k = 1; k < tr.length; k++) {
    const a = map(k, 0, tr.length, 0, body.comet ? 200 : 120);
    stroke(body.color[0], body.color[1], body.color[2], a);
    line(tr[k - 1].x, tr[k - 1].y, tr[k].x, tr[k].y);
  }
}

function drawBody(p, body) {
  noStroke();
  fill(body.color[0], body.color[1], body.color[2], 50);
  circle(p.x, p.y, body.radius * 3);
  fill(body.color[0], body.color[1], body.color[2]);
  circle(p.x, p.y, body.radius * 2);
}

// ---- interaction ---------------------------------------------------------

function mouseWheel(e) {
  const factor = e.delta > 0 ? 0.92 : 1.08;
  zoom = constrain(zoom * factor, 0.1, 8);
  return false;
}

function mousePressed() {
  if (mouseX < 290 && mouseY < 300) return; // ignore clicks over the UI panel
  dragging = true;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseDragged() {
  if (!dragging) return;
  panX += mouseX - lastX;
  panY += mouseY - lastY;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseReleased() { dragging = false; }

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  seedStarfield();
}

function wireUI() {
  const $ = (id) => document.getElementById(id);

  $('speed').addEventListener('input', (e) => { speed = parseFloat(e.target.value); });
  $('orbits').addEventListener('change', (e) => { showOrbits = e.target.checked; });
  $('trails').addEventListener('change', (e) => {
    showTrails = e.target.checked;
    if (!showTrails) resetTrails();
  });

  $('random').addEventListener('click', () => loadSystem(randomSeed()));
  $('load').addEventListener('click', () => loadSystem($('seed').value.trim() || randomSeed()));
  $('seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadSystem($('seed').value.trim() || randomSeed());
  });

  $('copy').addEventListener('click', async () => {
    const btn = $('copy');
    try {
      await navigator.clipboard.writeText(seed);
    } catch (_) {
      $('seed').select();
      document.execCommand('copy'); // fallback for non-secure contexts
    }
    const old = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = old; }, 1100);
  });

  $('pause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? 'Play' : 'Pause';
  });
  $('fit').addEventListener('click', () => { panX = 0; panY = 0; fitView(); });
}
