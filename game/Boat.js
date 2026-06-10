/**
 * Boat
 * ----
 * A vessel that sails along a player-drawn path to its pre-assigned dock,
 * unloads cargo block by block, then exits.
 *
 * Sprite orientation: artwork points RIGHT → sprite angle offset = 0.
 * Wake trail is drawn behind the stern before the hull sprite.
 */
import { BOAT_SPEEDS, CARGO_COUNTS } from './Game.js';

export const BOAT_STATES = {
  SAILING:      'SAILING',
  DOCKING:      'DOCKING',       // sailing the final stretch into the berth
  UNLOADING:    'UNLOADING',
  WAITING_EXIT: 'WAITING_EXIT',
  EXITING:      'EXITING',
  SUNK:         'SUNK',
};

// Hull draw dimensions (logical px) — sized to the visible PNG hull aspect
// ratios so boats don't look over-stretched horizontally.
// All three hulls share the same height (15px); only length differs.
const DRAW_DIMS = {
  small:  { w: 30, h: 15 },
  medium: { w: 39, h: 15 },
  large:  { w: 51, h: 15 },
};

// Cargo block width (BLOCK) and height (BLOCK_H) per boat type.
const BLOCK   = { small: 8, medium: 8, large: 7 };
const BLOCK_H = { small: 8, medium: 8, large: 7 };

// Cargo block offsets relative to boat center (rotated space).
const CARGO_OFFSETS = {
  small:  [[ 2, 0]],
  medium: [[-5, 0], [5, 0]],
  large:  [[-13, 0], [-4, 0], [4, 0], [13, 0]],
};

// Per-size rotational lerp rate (rad/s). Large ships turn slower than small.
const TURN_SPEED = { small: 14, medium: 9, large: 5 };
const EXIT_MARGIN = 80;  // px off-canvas before boat is considered exited

export class Boat {
  constructor({
    type       = 'small',
    cargo      = true,
    cargoColor = '#9B9B9B',
    x          = 0,
    y          = 0,
  } = {}) {
    this.type   = type;
    this.x      = x;
    this.y      = y;
    this.angle  = 0;

    this.speed          = BOAT_SPEEDS[type];
    this.cargoCount     = CARGO_COUNTS[type];
    this.cargoRemaining = cargo ? this.cargoCount : 0;
    this.cargoColor     = cargoColor;

    // Ellipse hitbox half-dimensions — exact half of the draw size (zero pad).
    this.hw = DRAW_DIMS[type].w / 2;   // half length
    this.hh = DRAW_DIMS[type].h / 2;   // half width (16px for all)
    // Land-collision probe radius for Game._firstLandPoint()'s 3-point check
    // (land only bounces — never causes game over).
    this.radius = Math.round(DRAW_DIMS[type].h * 0.42);

    // Mixed cargo (every 3rd large boat): `cargo` is a per-color block count,
    // e.g. { '#FFD700': 2, '#8B5CF6': 2 }. Such a ship may dock at ANY port
    // matching a color it still carries, in whatever order the player chooses.
    this.mixedCargo = false;
    this.cargo      = null;

    this.path      = [];
    this.pathIndex = 0;

    this.sprite       = null;   // pre-fetched by Spawner
    this.highlighted  = false;  // true while player's finger is on this boat
    this.spinState    = null;   // { elapsed, duration, startAngle } when vortex-caught
    this.vortexCd     = 0;      // brief immunity after a spin so it can drift clear
    this.targetDockId = null;   // assigned dock id (set by Spawner)

    this.state = BOAT_STATES.SAILING;
    this.alive = true;

    // Docking approach state (set by Dock.beginDocking; no teleport).
    this.dockTarget = null;          // Dock the boat is sailing into
    this.dockCenter = null;          // { x, y } exact berth center
    this.dockAngle  = null;          // bow heading to align with on arrival
    this.exitAngle  = null;          // ocean-facing heading after unloading
  }

  get spriteKey() {
    // All ships use the empty base hull; cargo is an overlay, not a sprite.
    return `${this.type}_empty`;
  }

  // ---------- Path management ----------

  assignPath(waypoints) {
    this.path      = waypoints;
    this.pathIndex = 0;
  }

  clearPath() {
    this.path      = [];
    this.pathIndex = 0;
  }

  // ---------- Cargo (supports mixed-color loads) ----------

  /** Number of cargo blocks of `color` still aboard. */
  cargoForColor(color) {
    if (this.mixedCargo && this.cargo) return this.cargo[color] ?? 0;
    return (color === this.cargoColor) ? this.cargoRemaining : 0;
  }

  /** Remove one cargo block of `color` (also decrements the running total). */
  removeCargoOfColor(color) {
    if (this.mixedCargo && this.cargo && this.cargo[color] > 0) {
      this.cargo[color]--;
    }
    this.cargoRemaining = Math.max(0, this.cargoRemaining - 1);
  }

  // ---------- Update ----------

  update(dt, canvasWidth, canvasHeight) {
    if (this.vortexCd > 0) this.vortexCd -= dt;

    // DOCKING: physically sail the rest of the way into the berth (no teleport),
    // turning the bow to face the dock's inward angle, then begin unloading.
    if (this.state === BOAT_STATES.DOCKING) {
      this._updateDocking(dt);
      return;
    }

    // Finished unloading: IMMEDIATELY rotate in place to face the ocean (a 180°
    // turn from the inward dock pose) and wait there. When the player draws an
    // exit path, depart along it.
    if (this.state === BOAT_STATES.WAITING_EXIT) {
      if (this.exitAngle != null) {
        this.angle = this._lerpAngle(this.angle, this.exitAngle, dt);
      }
      if (this.path.length > 0) {
        // Still carrying cargo (mixed ship headed to another dock) → SAILING so
        // it can dock again; fully empty → EXITING to leave the map.
        this.state = (this.cargoRemaining > 0)
          ? BOAT_STATES.SAILING
          : BOAT_STATES.EXITING;
      }
      return;
    }

    if (this.state === BOAT_STATES.SUNK ||
        this.state === BOAT_STATES.UNLOADING) return;

    // Vortex spin: exactly ONE quick 360° rotation in place, then recover.
    if (this.spinState) {
      this.spinState.elapsed += dt;
      const t = Math.min(1, this.spinState.elapsed / this.spinState.duration);
      this.angle = this.spinState.startAngle + t * Math.PI * 2;  // one full turn
      if (t >= 1) {
        this.angle     = this.spinState.startAngle;   // back to its last heading
        this.spinState = null;
        this.state     = BOAT_STATES.SAILING;         // resume drifting, await path
        this.vortexCd  = 2.0;   // immune briefly so it drifts clear, no re-spin
      }
      return;
    }

    const cw = canvasWidth  ?? 1024;
    const ch = canvasHeight ?? 768;

    // Off-canvas check. Loaded boats bounce back (can't leave with cargo);
    // only empty boats are allowed to exit and despawn.
    if (this.x < -EXIT_MARGIN || this.x > cw + EXIT_MARGIN ||
        this.y < -EXIT_MARGIN || this.y > ch + EXIT_MARGIN) {
      if (this.cargoRemaining > 0) {
        this.angle += Math.PI;                              // reverse direction
        this.x = Math.max(10, Math.min(cw - 10, this.x));
        this.y = Math.max(10, Math.min(ch - 10, this.y));
        this.clearPath();                                   // bounce silently
        return;
      }
      this.alive = false;
      return;
    }

    if (this.path.length > 0 && this.pathIndex < this.path.length) {
      // Following a drawn path.
      const target = this.path[this.pathIndex];
      const dx = target.x - this.x;
      const dy = target.y - this.y;
      const dist = Math.hypot(dx, dy);
      const step = this.speed * dt;

      this.angle = this._lerpAngle(this.angle, Math.atan2(dy, dx), dt);

      if (dist <= step) {
        this.x = target.x;
        this.y = target.y;
        this.pathIndex++;
      } else {
        this.x += (dx / dist) * step;
        this.y += (dy / dist) * step;
      }
    } else {
      // No path: continue straight at full speed.
      this.x += Math.cos(this.angle) * this.speed * dt;
      this.y += Math.sin(this.angle) * this.speed * dt;
    }
  }

  _lerpAngle(current, target, dt) {
    let diff = target - current;
    while (diff >  Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const rate = TURN_SPEED[this.type] ?? 10;
    return current + diff * (1 - Math.exp(-rate * dt));
  }

  /** Shortest signed angular difference target − current, in (−π, π]. */
  _angleDelta(current, target) {
    let d = target - current;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /**
   * DOCKING: sail straight to the berth center (no teleport) while turning the
   * bow toward the dock's inward angle. Once centered AND aligned, begin
   * unloading. The dock berth was already reserved in Dock.beginDocking().
   */
  _updateDocking(dt) {
    const c = this.dockCenter;
    if (!c) { this.state = BOAT_STATES.UNLOADING; return; }  // safety fallback

    const targetAngle = (this.dockAngle != null) ? this.dockAngle : this.angle;
    const dx = c.x - this.x, dy = c.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist >= 1) {
      // Constant SAILING-speed approach — never faster than open-water speed.
      // Only the final ~3px ease off slightly so the boat settles like a heavy
      // hull instead of snapping. min(step,dist) never overshoots the center.
      this.angle = this._lerpAngle(this.angle, targetAngle, dt);
      const ease = dist < 3 ? Math.max(0.4, dist / 3) : 1;
      const step = Math.min(this.speed * ease * dt, dist);
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    } else {
      // Reached the center (< 1px) — pin position and snap the bow exactly to
      // the dock's inward angle so no floating-point slant remains.
      this.x = c.x;
      this.y = c.y;
      this.angle = this._lerpAngle(this.angle, targetAngle, dt);
      if (Math.abs(this._angleDelta(this.angle, targetAngle)) < 0.05) {
        this.angle = targetAngle;          // exact final alignment
        this.state = BOAT_STATES.UNLOADING;
        if (this.dockTarget) this.dockTarget.unloadTimer = 0;
      }
    }
  }


  // ---------- Rendering ----------

  render(ctx, assets) {
    if (!this.alive) return;

    // Always render the EMPTY base hull — cargo is drawn dynamically on top as
    // colored blocks, so no baked-in cargo ever shows through.
    const spriteKey = `${this.type}_empty`;
    const img = assets?.get(spriteKey) ?? null;

    const { w, h } = DRAW_DIMS[this.type];

    ctx.save();
    ctx.translate(this.x, this.y);

    // White glow highlight (drawn before rotation, in world space).
    if (this.highlighted) {
      const glowR = Math.max(w, h) * 0.7;
      const grad  = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
      grad.addColorStop(0,   'rgba(255,255,255,0.45)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.15)');
      grad.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // (No glow when empty/waiting — the only feedback is the unload sound and
    // the absence of cargo blocks. The empty ship just sits quietly.)

    ctx.rotate(this.angle);

    // Wake trail — V-shaped foam behind the stern (drawn before hull).
    if (this.state !== BOAT_STATES.UNLOADING && this.state !== BOAT_STATES.SUNK) {
      ctx.save();
      const sternX = -w / 2;
      for (let i = 1; i <= 3; i++) {
        const ox     = sternX - i * 7;
        const spread = (h / 3) * (1 + i * 0.28);
        ctx.globalAlpha = Math.max(0, 0.16 - i * 0.04);
        ctx.fillStyle   = '#ffffff';
        // Upper foam dot
        ctx.beginPath();
        ctx.ellipse(ox, -spread * 0.5, 4, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // Lower foam dot
        ctx.beginPath();
        ctx.ellipse(ox, spread * 0.5, 4, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Hull sprite or fallback rect.
    if (img) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      // DEBUG: bright red rect means sprite failed to load
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px monospace';
      ctx.fillText(spriteKey, -w / 2 + 2, -h / 2 + 12);
    }

    // Cargo color blocks.
    if (this.cargoRemaining > 0) {
      const offsets = CARGO_OFFSETS[this.type];
      const bw      = BLOCK[this.type];
      const bh      = BLOCK_H[this.type];

      // Color of each remaining block. Mixed loads list each color's blocks.
      let colors;
      if (this.mixedCargo && this.cargo) {
        colors = [];
        for (const color of Object.keys(this.cargo)) {
          for (let k = 0; k < this.cargo[color]; k++) colors.push(color);
        }
      } else {
        colors = new Array(this.cargoRemaining).fill(this.cargoColor);
      }

      for (let i = 0; i < colors.length && i < offsets.length; i++) {
        const [ox, oy] = offsets[i];
        ctx.fillStyle   = colors[i];
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = 1.5;
        ctx.fillRect(ox - bw / 2, oy - bh / 2, bw, bh);
        ctx.strokeRect(ox - bw / 2, oy - bh / 2, bw, bh);
      }
    }

    ctx.restore();
  }
}
