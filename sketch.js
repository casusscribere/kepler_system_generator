/*
 * Solar System — elliptical & eccentric orbits
 *
 * Each body follows a true Keplerian ellipse rather than a circle.
 * The central star sits at one focus of every ellipse (Kepler's 1st law),
 * and bodies sweep equal areas in equal time (Kepler's 2nd law), so they
 * visibly speed up at periapsis and slow down at apoapsis.
 *
 * Position is found each frame by:
 *   1. advancing the mean anomaly  M = M0 + n*t
 *   2. solving Kepler's equation    M = E - e*sin(E)   for the eccentric anomaly E
 *   3. converting E -> true anomaly and radius on the ellipse
 *   4. rotating the ellipse by its argument of periapsis (orbit tilt)
 */

// ---- tunable scene -------------------------------------------------------

const STAR = { radius: 26, color: [255, 214, 110] };

// a  : semi-major axis (px)         e   : eccentricity (0 = circle, ->1 = needle)
// period : orbital period (seconds at speed 1)
// peri   : argument of periapsis (radians) — rotates the ellipse in its plane
// M0     : starting mean anomaly (radians) — spreads bodies out at t = 0
const BODIES = [
  { name: 'Mercury', a: 70,  e: 0.45, period: 5,  peri: 0.4,  M0: 0.0, radius: 4,  color: [180, 170, 160] },
  { name: 'Venus',   a: 110, e: 0.12, period: 9,  peri: 2.1,  M0: 1.7, radius: 7,  color: [222, 184, 120] },
  { name: 'Earth',   a: 160, e: 0.20, period: 14, peri: 5.0,  M0: 3.2, radius: 8,  color: [110, 160, 255],
    moons: [ { a: 22, e: 0.05, period: 1.6, peri: 0, M0: 0, radius: 3, color: [200, 200, 210] } ] },
  { name: 'Mars',    a: 220, e: 0.55, period: 22, peri: 1.2,  M0: 0.6, radius: 6,  color: [235, 110, 70] },
  { name: 'Comet',   a: 320, e: 0.82, period: 40, peri: 3.6,  M0: 5.5, radius: 3,  color: [180, 230, 255], comet: true },
  { name: 'Jupiter', a: 400, e: 0.10, period: 55, peri: 0.9,  M0: 2.4, radius: 18, color: [210, 170, 130] },
];

const TWO_PI = Math.PI * 2;

// ---- runtime state -------------------------------------------------------

let t = 0;              // simulation time (seconds)
let speed = 1;
let paused = false;
let showOrbits = true;
let showTrails = true;

let zoom = 1;
let panX = 0, panY = 0;
let dragging = false, lastX = 0, lastY = 0;

let stars = [];        // background starfield
let trails = [];       // per-body recent positions

// -------------------------------------------------------------------------

function setup() {
  createCanvas(windowWidth, windowHeight);
  seedStarfield();
  resetTrails();
  wireUI();
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
  trails = BODIES.map(() => []);
}

// Solve Kepler's equation  M = E - e*sin(E)  for E via Newton-Raphson.
function solveKepler(M, e) {
  M = ((M % TWO_PI) + TWO_PI) % TWO_PI;
  let E = e < 0.8 ? M : Math.PI; // good initial guess
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-6) break;
  }
  return E;
}

// Returns the {x, y} of a body on its ellipse, with the focus at (0,0).
function orbitalPosition(o, time) {
  const n = TWO_PI / o.period;        // mean motion (rad/s)
  const M = o.M0 + n * time;          // mean anomaly
  const E = solveKepler(M, o.e);      // eccentric anomaly

  // Position in the orbital frame: focus at origin, periapsis along +x.
  const b = o.a * Math.sqrt(1 - o.e * o.e);
  const px = o.a * (Math.cos(E) - o.e);
  const py = b * Math.sin(E);

  // Rotate by argument of periapsis to tilt the ellipse.
  const c = Math.cos(o.peri), s = Math.sin(o.peri);
  return { x: px * c - py * s, y: px * s + py * c };
}

function draw() {
  background(5, 6, 13);

  if (!paused) t += (deltaTime / 1000) * speed;

  push();
  translate(width / 2 + panX, height / 2 + panY);
  scale(zoom);

  drawStarfield();
  drawStar();

  for (let i = 0; i < BODIES.length; i++) {
    const body = BODIES[i];
    if (showOrbits) drawOrbitPath(body);

    const p = orbitalPosition(body, t);

    if (showTrails) updateAndDrawTrail(i, p, body);
    drawBody(p, body);

    // Moons orbit their parent body.
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
  noStroke();
  // glow
  for (let r = STAR.radius * 4; r > STAR.radius; r -= 4) {
    const a = map(r, STAR.radius, STAR.radius * 4, 60, 0);
    fill(STAR.color[0], STAR.color[1], STAR.color[2], a);
    circle(0, 0, r * 2);
  }
  fill(STAR.color[0], STAR.color[1], STAR.color[2]);
  circle(0, 0, STAR.radius * 2);
}

// Draw the full ellipse the body travels along. `center` lets moon orbits
// be drawn around their parent instead of the star.
function drawOrbitPath(o, center) {
  const cx = center ? center.x : 0;
  const cy = center ? center.y : 0;
  noFill();
  stroke(120, 140, 220, center ? 50 : 70);
  strokeWeight(1 / zoom);
  beginShape();
  for (let E = 0; E <= TWO_PI + 0.05; E += 0.05) {
    const b = o.a * Math.sqrt(1 - o.e * o.e);
    const px = o.a * (Math.cos(E) - o.e);
    const py = b * Math.sin(E);
    const c = Math.cos(o.peri), s = Math.sin(o.peri);
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
  // soft halo
  fill(body.color[0], body.color[1], body.color[2], 50);
  circle(p.x, p.y, body.radius * 3);
  fill(body.color[0], body.color[1], body.color[2]);
  circle(p.x, p.y, body.radius * 2);
}

// ---- interaction ---------------------------------------------------------

function mouseWheel(e) {
  const factor = e.delta > 0 ? 0.92 : 1.08;
  zoom = constrain(zoom * factor, 0.25, 6);
  return false; // block page scroll
}

function mousePressed() {
  if (mouseX < 270 && mouseY < 220) return; // don't grab over the UI panel
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
  $('pause').addEventListener('click', (e) => {
    paused = !paused;
    e.target.textContent = paused ? 'Play' : 'Pause';
  });
  $('reset').addEventListener('click', () => {
    t = 0; zoom = 1; panX = 0; panY = 0;
    resetTrails();
  });
}
