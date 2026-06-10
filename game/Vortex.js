/**
 * Vortex
 * ------
 * A timed whirlpool hazard that drifts across open water.
 * Boats caught inside its radius have their path erased and are stunned
 * (spinning in place) for SPIN_DURATION seconds, then released at a random heading.
 *
 * Spawn zones (canvas space, derived from image space 2400×1792):
 *   Zone 1: x 85–235,  y 171–557  (left open water)
 *   Zone 2: x 597–939, y 171–557  (right open water)
 * These are enforced by Game._randomOpenWaterPos(); Vortex itself just drifts.
 */
import { VORTEX_DURATION } from './Game.js';

const CW = 1024;
const CH = 768;

const DRAW_SIZE    = 80;             // px — visual size of vortex sprite
const MOVE_SPEED   = 25;             // px/s drift speed
const ROT_RATE     = Math.PI;        // rad/s — full 360° every 2 s
const SPIN_DURATION = 0.7;           // seconds for the single 360° spin

export const VORTEX_RADIUS = 30;     // px — catch (interaction) radius

export class Vortex {
  constructor({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;

    this.angle     = 0;
    this.elapsed   = 0;
    this.active    = true;

    this.moveAngle = Math.random() * Math.PI * 2;
    this.moveTimer = 2 + Math.random(); // seconds until next direction change
  }

  get remaining() {
    return Math.max(0, VORTEX_DURATION / 1000 - this.elapsed);
  }

  // ---------- Update ----------

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= VORTEX_DURATION / 1000) {
      this.active = false;
      return;
    }

    // Drift with occasional direction changes.
    this.moveTimer -= dt;
    if (this.moveTimer <= 0) {
      this.moveAngle = Math.random() * Math.PI * 2;
      this.moveTimer = 2 + Math.random();
    }
    this.x += Math.cos(this.moveAngle) * MOVE_SPEED * dt;
    this.y += Math.sin(this.moveAngle) * MOVE_SPEED * dt;

    // Bounce off canvas margins.
    const margin = VORTEX_RADIUS + 10;
    if (this.x < margin)       { this.x = margin;      this.moveAngle = Math.PI - this.moveAngle; }
    if (this.x > CW - margin)  { this.x = CW - margin; this.moveAngle = Math.PI - this.moveAngle; }
    if (this.y < margin)       { this.y = margin;       this.moveAngle = -this.moveAngle; }
    if (this.y > CH - margin)  { this.y = CH - margin;  this.moveAngle = -this.moveAngle; }

    // Spin the visual.
    this.angle += ROT_RATE * dt;
  }

  /**
   * Test one boat against this vortex.
   * If caught, erase its path and start the spin stun.
   */
  affectBoat(boat) {
    if (!this.active || !boat.alive) return;
    if (boat.spinState) return;
    if ((boat.vortexCd ?? 0) > 0) return;   // still immune from a recent spin
    // Don't catch boats that are parked / maneuvering at a berth.
    if (boat.state === 'UNLOADING' || boat.state === 'SUNK' ||
        boat.state === 'DOCKING'   || boat.state === 'WAITING_EXIT') return;

    // Caught when the ship's hitbox intersects the vortex radius.
    const reach = VORTEX_RADIUS + Math.min(boat.hw ?? 0, boat.hh ?? 0);
    if (Math.hypot(boat.x - this.x, boat.y - this.y) > reach) return;

    // Erase the drawn path, spin briefly, then keep drifting helplessly in the
    // current heading. The player must draw a new path to save it.
    boat.clearPath();
    boat.spinState = {
      elapsed:    0,
      duration:   SPIN_DURATION,
      startAngle: boat.angle,   // one full turn returns to this heading
    };
  }

  // ---------- Render ----------

  render(ctx, assets) {
    if (!this.active) return;

    const img = assets.get('vortex');
    if (!img) return;

    // Scale up 0→1 over the first second, down 1→0 over the last second.
    const scale = Math.min(1, this.elapsed, this.remaining);
    if (scale <= 0) return;

    const size = DRAW_SIZE * scale;
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
}
