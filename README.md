# Solar System Simulator

An interactive solar system simulation running in the browser, built with [p5.js](https://p5js.org/).

## Features

### Orbital Mechanics
Bodies follow true Keplerian ellipses rather than circular paths. The central star sits at one focus of each ellipse, and bodies visibly accelerate near periapsis and slow near apoapsis (Kepler's 2nd law). Orbital positions are computed each frame by solving Kepler's equation via Newton-Raphson iteration.

The system includes Mercury, Venus, Earth (with Moon), Mars, a highly eccentric comet, and Jupiter.

### Projectile Launcher
Click **Launch** in the control panel to enter launch mode. Click anywhere on the canvas to set a spawn point, drag to aim, and release to fire a small stellar body into the system. A dotted trajectory preview updates in real time as you drag, showing how gravity will bend the path before you let go.

Once in flight, the projectile is pulled by n-body gravity — the star dominates, but massive planets (especially Jupiter) cause noticeable deflection at close range. A projectile is removed when it impacts the star (triggering a glow flash), collides with a planet, or escapes the system.

### Visuals
- Fading orbital trails behind each body
- Elliptical orbit paths drawn around each focus
- Twinkling background starfield
- Soft glow halos on all bodies and the star

### Controls
| Control | Action |
|---|---|
| Scroll | Zoom in / out |
| Click + drag | Pan the view |
| Speed slider | Scale simulation speed (0× – 5×) |
| Show orbits | Toggle orbit path lines |
| Show trails | Toggle motion trails |
| Pause / Play | Freeze simulation |
| Reset | Return to initial state |
| Launch | Enter projectile launch mode |
| Clear | Remove all in-flight projectiles |

## Running Locally

Open `index.html` directly in a browser — no build step or server required. p5.js is loaded from a CDN.

---

*Designed with [Claude Code](https://claude.ai/code) by Anthropic.*
