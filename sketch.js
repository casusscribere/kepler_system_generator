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
 *
 * Launched projectiles use symplectic Euler integration with n-body gravity
 * from the star and all massive planets each frame.
 */

// ---- tunable scene -------------------------------------------------------

const STAR = { radius: 26, color: [255, 214, 110] };

// a  : semi-major axis (px)         e   : eccentricity (0 = circle, ->1 = needle)
// period : orbital period (seconds at speed 1)
// peri   : argument of periapsis (radians) — rotates the ellipse in its plane
// M0     : starting mean anomaly (radians) — spreads bodies out at t = 0
// gm     : gravitational parameter (px³/s²) felt by passing projectiles
const BODIES = [
  { name: 'Mercury', a: 70,  e: 0.45, period: 5,  peri: 0.4,  M0: 0.0, radius: 4,  color: [180, 170, 160], gm: 10 },
  { name: 'Venus',   a: 110, e: 0.12, period: 9,  peri: 2.1,  M0: 1.7, radius: 7,  color: [222, 184, 120], gm: 45 },
  { name: 'Earth',   a: 160, e: 0.20, period: 14, peri: 5.0,  M0: 3.2, radius: 8,  color: [110, 160, 255], gm: 50,
    moons: [ { a: 22, e: 0.05, period: 1.6, peri: 0, M0: 0, radius: 3, color: [200, 200, 210] } ] },
  { name: 'Mars',    a: 220, e: 0.55, period: 22, peri: 1.2,  M0: 0.6, radius: 6,  color: [235, 110, 70],  gm: 15 },
  { name: 'Comet',   a: 320, e: 0.82, period: 40, peri: 3.6,  M0: 5.5, radius: 3,  color: [180, 230, 255], comet: true, gm: 0 },
  { name: 'Jupiter', a: 400, e: 0.10, period: 55, peri: 0.9,  M0: 2.4, radius: 18, color: [210, 170, 130], gm: 800 },
];

const TWO_PI = Math.PI * 2;

// GM_STAR derived from Mercury's orbit: v ≈ 2π×70/5 px/s, GM = v²×r ≈ 540 000
const GM_STAR = 540000;

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

// projectile launch state
let projectiles = [];
let launchMode = false;
let launchOrigin = null;  // { sx, sy, x, y } — screen + sim coords of mouse press
let launchAim = null;     // { vx, vy } — current aimed velocity (sim px/s)
let starFlash = 0;        // 0–1, decays after a projectile hits the star

const LAUNCH_SPEED_SCALE = 0.8;  // maps screen drag pixels → sim px/s
const MIN_DRAG_PX = 8;           // ignore clicks with negligible drag
const ESCAPE_DIST = 1500;        // remove projectile beyond this radius (sim px)

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
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-6) break;
  }
  return E;
}

// Returns the {x, y} of a body on its ellipse, with the focus at (0,0).
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

function draw() {
  background(5, 6, 13);

  if (!paused) {
    const dt = (deltaTime / 1000) * speed;
    t += dt;
    updateProjectiles(dt);
  }

  if (starFlash > 0) starFlash = Math.max(0, starFlash - deltaTime / 400);

  if (launchMode) cursor('crosshair');
  else cursor(ARROW);

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

    if (body.moons) {
      for (const moon of body.moons) {
        const mp = orbitalPosition(moon, t);
        if (showOrbits) drawOrbitPath(moon, p);
        drawBody({ x: p.x + mp.x, y: p.y + mp.y }, moon);
      }
    }
  }

  for (const proj of projectiles) drawProjectile(proj);

  if (launchMode && launchOrigin && launchAim) drawLaunchPreview();

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
  const glowMult = 1 + starFlash * 2.5;
  for (let r = STAR.radius * 4 * glowMult; r > STAR.radius; r -= 4) {
    const a = map(r, STAR.radius, STAR.radius * 4 * glowMult, 60 + starFlash * 120, 0);
    fill(STAR.color[0], STAR.color[1], STAR.color[2], a);
    circle(0, 0, r * 2);
  }
  fill(STAR.color[0], STAR.color[1], STAR.color[2]);
  circle(0, 0, STAR.radius * 2);
}

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
  fill(body.color[0], body.color[1], body.color[2], 50);
  circle(p.x, p.y, body.radius * 3);
  fill(body.color[0], body.color[1], body.color[2]);
  circle(p.x, p.y, body.radius * 2);
}

// ---- projectile physics --------------------------------------------------

// Returns gravitational acceleration vector at (x, y) at simulation time simT.
function gravAccel(x, y, simT) {
  const r2star = x * x + y * y;
  const rstar = Math.sqrt(r2star);
  const aStar = GM_STAR / Math.max(r2star, 1);
  let ax = aStar * (-x / rstar);
  let ay = aStar * (-y / rstar);

  for (const body of BODIES) {
    if (!body.gm) continue;
    const bp = orbitalPosition(body, simT);
    const dx = bp.x - x;
    const dy = bp.y - y;
    const r2 = dx * dx + dy * dy;
    const r = Math.sqrt(r2);
    const a = body.gm / Math.max(r2, 1);
    ax += a * dx / r;
    ay += a * dy / r;
  }

  return { ax, ay };
}

function updateProjectiles(dt) {
  const toRemove = [];

  for (let i = 0; i < projectiles.length; i++) {
    const proj = projectiles[i];

    const { ax, ay } = gravAccel(proj.x, proj.y, t);
    proj.vx += ax * dt;
    proj.vy += ay * dt;
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    proj.age += dt;

    proj.trail.push({ x: proj.x, y: proj.y });
    if (proj.trail.length > 80) proj.trail.shift();

    const r = Math.sqrt(proj.x * proj.x + proj.y * proj.y);

    if (r > ESCAPE_DIST) { toRemove.push(i); continue; }

    if (r < STAR.radius * 1.2) {
      starFlash = 1.0;
      toRemove.push(i);
      continue;
    }

    for (const body of BODIES) {
      const bp = orbitalPosition(body, t);
      const dx = bp.x - proj.x;
      const dy = bp.y - proj.y;
      if (Math.sqrt(dx * dx + dy * dy) < body.radius + proj.radius) {
        toRemove.push(i);
        break;
      }
    }
  }

  for (let i = toRemove.length - 1; i >= 0; i--) {
    projectiles.splice(toRemove[i], 1);
  }
}

function drawProjectile(proj) {
  if (proj.trail.length > 1) {
    noFill();
    strokeWeight(1.5 / zoom);
    for (let k = 1; k < proj.trail.length; k++) {
      const a = map(k, 0, proj.trail.length, 0, 160);
      stroke(180, 220, 255, a);
      line(proj.trail[k - 1].x, proj.trail[k - 1].y, proj.trail[k].x, proj.trail[k].y);
    }
  }

  noStroke();
  fill(180, 220, 255, 55);
  circle(proj.x, proj.y, proj.radius * 4);
  fill(225, 242, 255);
  circle(proj.x, proj.y, proj.radius * 2);
}

// Computes a preview trajectory from (startX, startY) with velocity (vx, vy).
// Planet positions are advanced in time for accuracy.
function computePreviewTrajectory(startX, startY, vx, vy) {
  const pts = [];
  let px = startX, py = startY, pvx = vx, pvy = vy;
  const dt = 0.1;

  for (let i = 0; i < 200; i++) {
    const { ax, ay } = gravAccel(px, py, t + i * dt);
    pvx += ax * dt;
    pvy += ay * dt;
    px += pvx * dt;
    py += pvy * dt;
    pts.push({ x: px, y: py });

    const r = Math.sqrt(px * px + py * py);
    if (r < STAR.radius * 1.2 || r > ESCAPE_DIST) break;
  }

  return pts;
}

function drawLaunchPreview() {
  const { x: ox, y: oy } = launchOrigin;
  const { vx, vy } = launchAim;

  // Dotted trajectory
  const pts = computePreviewTrajectory(ox, oy, vx, vy);
  for (let i = 0; i < pts.length; i += 4) {
    const a = map(i, 0, pts.length, 210, 25);
    stroke(180, 220, 255, a);
    strokeWeight(2.5 / zoom);
    noFill();
    point(pts[i].x, pts[i].y);
  }

  // Aim arrow — capped display length, always readable regardless of speed
  const mag = Math.sqrt(vx * vx + vy * vy);
  const dispLen = Math.min(mag, 130);
  const angle = Math.atan2(vy, vx);
  const tipX = ox + Math.cos(angle) * dispLen;
  const tipY = oy + Math.sin(angle) * dispLen;

  stroke(180, 220, 255, 210);
  strokeWeight(1.5 / zoom);
  line(ox, oy, tipX, tipY);

  // Arrowhead
  const headLen = 9 / zoom;
  fill(180, 220, 255, 210);
  noStroke();
  triangle(
    tipX, tipY,
    tipX + Math.cos(angle + Math.PI * 0.82) * headLen,
    tipY + Math.sin(angle + Math.PI * 0.82) * headLen,
    tipX + Math.cos(angle - Math.PI * 0.82) * headLen,
    tipY + Math.sin(angle - Math.PI * 0.82) * headLen
  );

  // Origin dot
  fill(180, 220, 255, 190);
  circle(ox, oy, 6 / zoom);
}

// ---- interaction ---------------------------------------------------------

function screenToSim(sx, sy) {
  return {
    x: (sx - width / 2 - panX) / zoom,
    y: (sy - height / 2 - panY) / zoom,
  };
}

function mouseWheel(e) {
  const factor = e.delta > 0 ? 0.92 : 1.08;
  zoom = constrain(zoom * factor, 0.25, 6);
  return false;
}

function mousePressed() {
  if (mouseX < 270 && mouseY < 280) return; // don't grab over the UI panel

  if (launchMode) {
    const sp = screenToSim(mouseX, mouseY);
    launchOrigin = { sx: mouseX, sy: mouseY, x: sp.x, y: sp.y };
    launchAim = { vx: 0, vy: 0 };
    return;
  }

  dragging = true;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseDragged() {
  if (launchMode && launchOrigin) {
    launchAim = {
      vx: (mouseX - launchOrigin.sx) * LAUNCH_SPEED_SCALE,
      vy: (mouseY - launchOrigin.sy) * LAUNCH_SPEED_SCALE,
    };
    return;
  }

  if (!dragging) return;
  panX += mouseX - lastX;
  panY += mouseY - lastY;
  lastX = mouseX;
  lastY = mouseY;
}

function mouseReleased() {
  if (launchMode && launchOrigin && launchAim) {
    const dragDist = Math.hypot(mouseX - launchOrigin.sx, mouseY - launchOrigin.sy);
    if (dragDist >= MIN_DRAG_PX) {
      projectiles.push({
        x: launchOrigin.x,
        y: launchOrigin.y,
        vx: launchAim.vx,
        vy: launchAim.vy,
        radius: 3,
        trail: [],
        age: 0,
      });
    }
    launchOrigin = null;
    launchAim = null;
    return;
  }

  dragging = false;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  seedStarfield();
}

function wireUI() {
  const $ = (id) => document.getElementById(id);
  const hint = $('hint');

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
    projectiles = [];
    launchOrigin = null;
    launchAim = null;
  });
  $('launch').addEventListener('click', (e) => {
    launchMode = !launchMode;
    e.target.textContent = launchMode ? 'Cancel' : 'Launch';
    e.target.style.background = launchMode ? 'rgba(180,220,255,0.22)' : '';
    e.target.style.borderColor = launchMode ? 'rgba(180,220,255,0.6)' : '';
    launchOrigin = null;
    launchAim = null;
    hint.textContent = launchMode
      ? 'Click + drag to aim · release to fire'
      : 'Scroll to zoom · drag to pan';
  });
  $('clearProj').addEventListener('click', () => { projectiles = []; });
}
