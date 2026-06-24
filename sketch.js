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

// ---- gravity / physics constants -----------------------------------------
// The orbit periods use  T = PERIOD_COEF * (a / A_REF)^1.5  (Kepler's 3rd law).
// For a central force  T = 2π * a^1.5 / sqrt(GM), so the star's gravitational
// parameter that REPRODUCES those same orbits is fixed (independent of the
// star's drawn radius). Using it for launched projectiles means a projectile
// feels exactly the gravity field the planets themselves orbit in.
const A_REF = 70;
const PERIOD_COEF = 4.0;
const STAR_MU = Math.pow((TWO_PI * Math.pow(A_REF, 1.5)) / PERIOD_COEF, 2);
// Planet mass ∝ radius^3 (volume); a radius-8 world is ~5% of the star's pull,
// so flybys perturb a projectile noticeably and gas giants give real assists.
const PLANET_MU_FRAC = 0.05;
const PLANET_MU_REF_R = 8;

// Slingshot launch tuning.
const LAUNCH_K = 1.0;   // launch speed per world-unit of pull-back
const VMAX = 720;       // speed cap
const ESCAPE_R = 7000;  // projectiles beyond this are gone

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
    mu: STAR_MU, // gravitational parameter (fixed so it matches the orbits)
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
    const period = PERIOD_COEF * Math.pow(a / A_REF, 1.5) * rng.range(0.9, 1.1);

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
      // gravitational parameter for launched projectiles (mass ∝ radius^3)
      mu: STAR_MU * PLANET_MU_FRAC * Math.pow(radius / PLANET_MU_REF_R, 3),
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

// Slingshot launcher state.
let projectiles = [];      // { x, y, vx, vy, trail[], alive, fade }
let impacts = [];          // expanding impact rings
let aiming = false;        // currently dragging out a launch
let aimAnchor = { x: 0, y: 0 }; // launch origin (world coords)
let aimCurr = { x: 0, y: 0 };   // current pull point (world coords)
let panMode = false;       // the active drag is panning, not aiming
let showPredict = true;     // draw the predicted trajectory while aiming

// -------------------------------------------------------------------------

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  // Right-drag pans, so stop the browser context menu on the canvas.
  cnv.elt.addEventListener('contextmenu', (e) => e.preventDefault());
  seedStarfield();
  // Seed priority: URL hash (shareable link) > a fresh random seed.
  const fromHash = decodeURIComponent((window.location.hash || '').replace(/^#/, '')).trim();
  loadSystem(fromHash || freshSeed(), false);
  wireUI();
}

function freshSeed() {
  // Short, readable, copy-pasteable. Browser Math.random is fine here.
  let s = '';
  for (let i = 0; i < 7; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s.toUpperCase();
}

// Generate (or regenerate) the system for a seed and reset the view to fit it.
function loadSystem(newSeed, autoFit = true) {
  seed = newSeed || freshSeed();
  system = generateSystem(seed);

  t = 0; panX = 0; panY = 0;
  resetTrails();
  projectiles = [];
  impacts = [];
  aiming = false;

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

  const dt = paused ? 0 : (deltaTime / 1000) * speed;
  t += dt;
  updateProjectiles(dt);
  updateImpacts(dt);

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

  drawProjectiles();
  drawImpacts();
  drawAiming();

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

// ---- gravity & projectiles ----------------------------------------------

// Gravity sources (star + planets) at a given simulation time. Moons and
// comets are too light to matter and are skipped.
function gravitySources(time) {
  const src = [{ x: 0, y: 0, mu: system.star.mu, radius: system.star.radius }];
  for (const b of system.bodies) {
    if (b.comet || !b.mu) continue;
    const p = orbitalPosition(b, time);
    src.push({ x: p.x, y: p.y, mu: b.mu, radius: b.radius });
  }
  return src;
}

// Net gravitational acceleration at (x, y) from all sources. Plummer-softened
// near each body so close passes stay finite rather than blowing up.
function accelAt(x, y, sources) {
  let ax = 0, ay = 0;
  for (const s of sources) {
    const dx = s.x - x, dy = s.y - y;
    const soft = s.radius * 0.5;
    const r2 = dx * dx + dy * dy + soft * soft;
    const inv = s.mu / (r2 * Math.sqrt(r2)); // mu / r^3
    ax += dx * inv;
    ay += dy * inv;
  }
  return [ax, ay];
}

// One velocity-Verlet step for a projectile against a fixed source snapshot.
function stepProjectile(pr, h, sources) {
  const a0 = accelAt(pr.x, pr.y, sources);
  pr.x += pr.vx * h + 0.5 * a0[0] * h * h;
  pr.y += pr.vy * h + 0.5 * a0[1] * h * h;
  const a1 = accelAt(pr.x, pr.y, sources);
  pr.vx += 0.5 * (a0[0] + a1[0]) * h;
  pr.vy += 0.5 * (a0[1] + a1[1]) * h;

  for (const s of sources) {
    const dx = pr.x - s.x, dy = pr.y - s.y;
    if (dx * dx + dy * dy < s.radius * s.radius) {
      pr.alive = false;
      spawnImpact(pr.x, pr.y, s.radius);
      return;
    }
  }
  if (pr.x * pr.x + pr.y * pr.y > ESCAPE_R * ESCAPE_R) pr.alive = false;
}

// Advance every projectile over this frame's dt. Bodies move during the frame,
// so we resample the gravity field on each fixed sub-step (shared across all
// projectiles for that sub-step — cost is independent of projectile count).
function updateProjectiles(dt) {
  if (dt > 0 && projectiles.some((p) => p.alive)) {
    const target = 0.015;
    const steps = Math.min(200, Math.max(1, Math.ceil(dt / target)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const time = t - dt + h * (i + 1);
      const sources = gravitySources(time);
      for (const pr of projectiles) {
        if (pr.alive) stepProjectile(pr, h, sources);
      }
    }
    for (const pr of projectiles) {
      if (pr.alive) {
        pr.trail.push({ x: pr.x, y: pr.y });
        if (pr.trail.length > 260) pr.trail.shift();
      }
    }
  }
  // Fade out spent projectiles, then drop them.
  for (const pr of projectiles) {
    if (!pr.alive) pr.fade -= dt > 0 ? dt * 1.1 : 0;
  }
  projectiles = projectiles.filter((pr) => pr.alive || pr.fade > 0);
}

// Initial velocity from the current slingshot pull (launch is opposite the
// drag direction, magnitude proportional to pull length).
function launchVelocity() {
  const dx = aimAnchor.x - aimCurr.x;
  const dy = aimAnchor.y - aimCurr.y;
  const len = Math.hypot(dx, dy);
  if (len < 3) return null;
  const v = Math.min(len * LAUNCH_K, VMAX);
  return { vx: (dx / len) * v, vy: (dy / len) * v, len, speed: v };
}

function launchProjectile() {
  const v = launchVelocity();
  if (!v) return;
  projectiles.push({
    x: aimAnchor.x, y: aimAnchor.y, vx: v.vx, vy: v.vy, trail: [], alive: true, fade: 1,
  });
  if (projectiles.length > 60) projectiles.shift();
}

// Integrate a throwaway copy forward to preview the path. Bodies are frozen at
// the current time, so it's a close (not exact) guide for moving targets.
function predictedPath() {
  const v = launchVelocity();
  if (!v) return null;
  const sources = gravitySources(t);
  let x = aimAnchor.x, y = aimAnchor.y, vx = v.vx, vy = v.vy;
  const pts = [{ x, y }];
  const h = 0.04;
  for (let i = 0; i < 600; i++) {
    const a0 = accelAt(x, y, sources);
    x += vx * h + 0.5 * a0[0] * h * h;
    y += vy * h + 0.5 * a0[1] * h * h;
    const a1 = accelAt(x, y, sources);
    vx += 0.5 * (a0[0] + a1[0]) * h;
    vy += 0.5 * (a0[1] + a1[1]) * h;
    pts.push({ x, y });
    let hit = false;
    for (const s of sources) {
      const dx = x - s.x, dy = y - s.y;
      if (dx * dx + dy * dy < s.radius * s.radius) { hit = true; break; }
    }
    if (hit || x * x + y * y > ESCAPE_R * ESCAPE_R) break;
  }
  return pts;
}

function spawnImpact(x, y, r) {
  impacts.push({ x, y, r: r * 0.5, max: r * 3.5, life: 1 });
}

function updateImpacts(dt) {
  for (const f of impacts) {
    f.r += (f.max - f.r) * Math.min(1, (dt > 0 ? dt : 0.016) * 5);
    f.life -= (dt > 0 ? dt : 0.016) * 1.6;
  }
  impacts = impacts.filter((f) => f.life > 0);
}

function drawProjectiles() {
  for (const pr of projectiles) {
    const tr = pr.trail;
    const fade = pr.alive ? 1 : Math.max(0, pr.fade);
    noFill();
    strokeWeight(2 / zoom);
    for (let k = 1; k < tr.length; k++) {
      const a = map(k, 0, tr.length, 0, 220) * fade;
      stroke(150, 230, 255, a);
      line(tr[k - 1].x, tr[k - 1].y, tr[k].x, tr[k].y);
    }
    if (pr.alive) {
      noStroke();
      fill(150, 230, 255, 70);
      circle(pr.x, pr.y, 9);
      fill(235, 250, 255);
      circle(pr.x, pr.y, 3.6);
    }
  }
}

function drawImpacts() {
  noFill();
  for (const f of impacts) {
    stroke(255, 200, 120, 220 * Math.max(0, f.life));
    strokeWeight(2 / zoom);
    circle(f.x, f.y, f.r * 2);
  }
}

function drawAiming() {
  if (!aiming) return;
  const v = launchVelocity();

  // The pull-back band (faint, from origin to the current pointer).
  stroke(140, 160, 230, 120);
  strokeWeight(1.5 / zoom);
  line(aimAnchor.x, aimAnchor.y, aimCurr.x, aimCurr.y);

  if (showPredict && v) {
    const pts = predictedPath();
    if (pts) {
      noFill();
      stroke(150, 230, 255, 150);
      strokeWeight(1.5 / zoom);
      // dashed look: draw every other short segment
      for (let k = 1; k < pts.length; k++) {
        if (k % 2 === 0) continue;
        line(pts[k - 1].x, pts[k - 1].y, pts[k].x, pts[k].y);
      }
    }
    // Launch-direction arrowhead.
    const ux = v.vx / v.speed, uy = v.vy / v.speed;
    const tipLen = 16 + Math.min(40, v.speed * 0.06);
    const tx = aimAnchor.x + ux * tipLen, ty = aimAnchor.y + uy * tipLen;
    stroke(150, 230, 255, 220);
    strokeWeight(2 / zoom);
    line(aimAnchor.x, aimAnchor.y, tx, ty);
    const ax = -uy, ay = ux;
    line(tx, ty, tx - ux * 7 + ax * 4, ty - uy * 7 + ay * 4);
    line(tx, ty, tx - ux * 7 - ax * 4, ty - uy * 7 - ay * 4);
  }

  // The launch origin.
  noStroke();
  fill(235, 250, 255);
  circle(aimAnchor.x, aimAnchor.y, 5 / zoom);
}

// ---- interaction ---------------------------------------------------------

function screenToWorld(sx, sy) {
  return { x: (sx - (width / 2 + panX)) / zoom, y: (sy - (height / 2 + panY)) / zoom };
}

function isOverUI(mx, my) {
  const el = document.getElementById('ui');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
}

function mouseWheel(e) {
  const factor = e.delta > 0 ? 0.92 : 1.08;
  zoom = constrain(zoom * factor, 0.1, 8);
  return false;
}

function mousePressed() {
  if (isOverUI(mouseX, mouseY)) return; // let the panel handle its own clicks

  // Right-button or Shift pans the view; a plain left drag aims the slingshot.
  if (mouseButton === RIGHT || keyIsDown(SHIFT)) {
    dragging = true;
    panMode = true;
    lastX = mouseX;
    lastY = mouseY;
    return;
  }

  aiming = true;
  panMode = false;
  aimAnchor = screenToWorld(mouseX, mouseY);
  aimCurr = { ...aimAnchor };
}

function mouseDragged() {
  if (dragging && panMode) {
    panX += mouseX - lastX;
    panY += mouseY - lastY;
    lastX = mouseX;
    lastY = mouseY;
    return;
  }
  if (aiming) aimCurr = screenToWorld(mouseX, mouseY);
}

function mouseReleased() {
  if (aiming) {
    launchProjectile();
    aiming = false;
  }
  dragging = false;
  panMode = false;
}

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

  $('random').addEventListener('click', () => loadSystem(freshSeed()));
  $('load').addEventListener('click', () => loadSystem($('seed').value.trim() || freshSeed()));
  $('seed').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadSystem($('seed').value.trim() || freshSeed());
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

  $('predict').addEventListener('change', (e) => { showPredict = e.target.checked; });
  $('clear').addEventListener('click', () => { projectiles = []; impacts = []; });

  $('pause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? 'Play' : 'Pause';
  });
  $('fit').addEventListener('click', () => { panX = 0; panY = 0; fitView(); });
}
