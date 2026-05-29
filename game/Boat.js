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
  DOCKING:      'DOCKING',
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

const ROT_SPEED  = 10;   // exponential lerp rate for heading
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

    // Mixed cargo (every 3rd large boat): unloads `primaryCargoCount` blocks of
    // `cargoColor` at one dock, then switches to `secondaryColor` for a second.
    this.mixedCargo        = false;
    this.secondaryColor    = null;
    this.primaryCargoCount = 0;

    this.path      = [];
    this.pathIndex = 0;

    this.sprite       = null;   // pre-fetched by Spawner
    this.highlighted  = false;  // true while player's finger is on this boat
    this.spinState    = null;   // { elapsed, duration, spinRate, exitAngle } when vortex-caught
    this.targetDockId = null;   // assigned dock id (set by Spawner)

    this.state = BOAT_STATES.SAILING;
    this.alive = true;
  }

  get spriteKey() {
    return this.cargoRemaining > 0
      ? `${this.type}_cargo`
      : `${this.type}_empty`;
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

  // ---------- Update ----------

  update(dt, canvasWidth, canvasHeight) {
    // Finished unloading: hold position at the dock until the player draws an
    // exit path. The moment a path is assigned, the boat departs.
    if (this.state === BOAT_STATES.WAITING_EXIT) {
      if (this.path.length > 0) {
        this.state = BOAT_STATES.EXITING;
      }
      return;
    }

    if (this.state === BOAT_STATES.SUNK ||
        this.state === BOAT_STATES.UNLOADING) return;

    // Vortex spin: rotate in place, no translation.
    if (this.spinState) {
      this.spinState.elapsed += dt;
      this.angle += this.spinState.spinRate * dt;
      if (this.spinState.elapsed >= this.spinState.duration) {
        this.angle     = this.spinState.exitAngle;
        this.spinState = null;
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
        this.clearPath();
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
    return current + diff * (1 - Math.exp(-ROT_SPEED * dt));
  }

  // ---------- Rendering ----------

  render(ctx, assets) {
    if (!this.alive) return;

    const spriteKey = this.cargoRemaining > 0
      ? `${this.type}_cargo`
      : `${this.type}_empty`;
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

    // Pulsing white glow while waiting for the player to draw an exit path.
    if (this.state === BOAT_STATES.WAITING_EXIT) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
      const glowR = Math.max(w, h) * (0.7 + pulse * 0.35);
      const grad  = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
      grad.addColorStop(0,   `rgba(255,255,255,${0.30 + pulse * 0.35})`);
      grad.addColorStop(0.55,`rgba(255,255,255,${0.10 + pulse * 0.14})`);
      grad.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

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

      for (let i = 0; i < this.cargoRemaining && i < offsets.length; i++) {
        const [ox, oy] = offsets[i];
        const blockColor = (this.mixedCargo && i >= this.primaryCargoCount)
          ? this.secondaryColor
          : this.cargoColor;
        ctx.fillStyle   = blockColor;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth   = 1.5;
        ctx.fillRect(ox - bw / 2, oy - bh / 2, bw, bh);
        ctx.strokeRect(ox - bw / 2, oy - bh / 2, bw, bh);
      }
    }

    ctx.restore();
  }
}
