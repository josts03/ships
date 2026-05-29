/**
 * Spawner
 * -------
 * Schedules boats, applies score-based difficulty, and pre-assigns each
 * incoming boat to a specific dock before it spawns.
 *
 * Boats spawn from the LEFT edge (y: 171–768) and RIGHT edge (y: 64–557)
 * only — canvas space (1024×768), derived from image-space ranges.
 */
import { Boat } from './Boat.js';

const CW = 1024;
const CH = 768;

const WARNING_SECS = 2.5;  // warning shown 2–3s before ship enters screen
const FIRST_SPAWN  = 2;
const MAX_BOATS    = 12;

// Two cargo colors — must match dock colors encoded in collision_map.png.
const YELLOW = '#FFD700';
const PURPLE = '#8B5CF6';

/**
 * Difficulty tiers — three phases matching score thresholds.
 *
 * intervalMin/intervalMax — spawn interval is randomised within this range
 * so timing feels organic rather than metronomic.
 *
 * Phase 1 (0–7):   ONLY small ships.         Slow, relaxed.   6–8 s
 * Phase 2 (8–19):  Small + Medium unlocked.  Building up.     4–6 s
 * Phase 3 (20+):   All three types.          Fast, chaotic.   2–4 s (ramps)
 */
const DIFFICULTY = [
  // ── Phase 1: early game — small only ───────────────────────────────────
  { minScore:  0, intervalMin: 6.0, intervalMax: 8.0,
    types: ['small'],
    maxDocksPerColor: 99 },

  // ── Phase 2: mid game — small + medium ─────────────────────────────────
  { minScore:  8, intervalMin: 5.0, intervalMax: 6.0,
    types: ['small', 'medium'],
    maxDocksPerColor: 99 },
  { minScore: 14, intervalMin: 4.0, intervalMax: 5.5,
    types: ['small', 'medium', 'medium'],
    maxDocksPerColor: 99 },

  // ── Phase 3: late game — all types ─────────────────────────────────────
  { minScore: 20, intervalMin: 3.0, intervalMax: 4.0,
    types: ['small', 'medium', 'large'],
    maxDocksPerColor: 99 },
  { minScore: 35, intervalMin: 2.5, intervalMax: 3.5,
    types: ['small', 'medium', 'medium', 'large'],
    maxDocksPerColor: 99 },
  { minScore: 55, intervalMin: 2.0, intervalMax: 3.0,
    types: ['medium', 'medium', 'large', 'large'],
    maxDocksPerColor: 99 },
  { minScore: 80, intervalMin: 2.0, intervalMax: 2.5,
    types: ['medium', 'large', 'large'],
    maxDocksPerColor: 99 },
];

/**
 * Edge spawn config — left/right only.
 * fixedVal     – the constant x (or y) for the spawn position
 * exitFixed    – where the boat heads if no path drawn (straight-through exit)
 * varyAxis     – which axis is random
 * ranges       – canvas-space ranges for the varying coordinate
 * headingAngle – initial boat heading
 */
const EDGE_CONFIG = {
  left:   { fixedVal: -30,     exitFixed: CW + 30, varyAxis: 'y', ranges: [[220, 720]], headingAngle: 0          },
  right:  { fixedVal: CW + 30, exitFixed: -30,     varyAxis: 'y', ranges: [[100, 520]], headingAngle: Math.PI    },
  top:    { fixedVal: -30,     exitFixed: CH + 30, varyAxis: 'x', ranges: [[774, 1024]], headingAngle: Math.PI/2  },
  bottom: { fixedVal: CH + 30, exitFixed: -30,     varyAxis: 'x', ranges: [[0,   580]], headingAngle: -Math.PI/2 },
};

const ARROW_RENDER = {
  left:   { getPos: (v) => ({ x: 22,      y: v       }), angle: 0          },
  right:  { getPos: (v) => ({ x: CW - 22, y: v       }), angle: Math.PI    },
  top:    { getPos: (v) => ({ x: v,       y: 22      }), angle: Math.PI/2  },
  bottom: { getPos: (v) => ({ x: v,       y: CH - 22 }), angle: -Math.PI/2 },
};

export class Spawner {
  constructor(game) {
    this.game  = game;
    this.boats = [];
    this.vortices = [];

    /** @type {Array<{timeUntilSpawn, edge, varyCoord, type, cargoColor, targetDockId}>} */
    this.pendingSpawns = [];

    this.queueTimer    = FIRST_SPAWN;

    // Counts large boats spawned so every 3rd gets mixed cargo.
    this.largeBoatCount = 0;
  }

  // ---------- Public ----------

  update(dt) {
    // Queue next spawn when timer fires (only if room for more boats).
    this.queueTimer -= dt;
    if (this.queueTimer <= 0) {
      if (this.boats.length < MAX_BOATS) {
        const queued = this._queueNextSpawn();
        // Pick a fresh random interval within the current tier's range.
        const diff = this._getDifficulty(this.game.score.current);
        this.queueTimer = queued
          ? diff.intervalMin + Math.random() * (diff.intervalMax - diff.intervalMin)
          : 2.0; // retry in 2 s if queue failed
      } else {
        const diff = this._getDifficulty(this.game.score.current);
        this.queueTimer = diff.intervalMin;
      }
    }

    // Tick pending spawns.
    const toSpawn = [];
    for (const p of this.pendingSpawns) {
      p.timeUntilSpawn -= dt;
      if (p.timeUntilSpawn <= 0) toSpawn.push(p);
    }
    this.pendingSpawns = this.pendingSpawns.filter((p) => p.timeUntilSpawn > 0);
    for (const p of toSpawn) this._spawnFromPending(p);

    // Advance boats.
    for (const b of this.boats) b.update(dt, CW, CH);
    this.boats = this.boats.filter((b) => b.alive);
  }

  renderArrows(ctx) {
    const now = performance.now();
    for (const p of this.pendingSpawns) this._renderArrow(ctx, p, now);
  }

  reset() {
    this.boats          = [];
    this.vortices       = [];
    this.pendingSpawns  = [];
    this.queueTimer     = FIRST_SPAWN;
    this.largeBoatCount = 0;
  }

  // ---------- Private ----------

  _getDifficulty(score) {
    let tier = DIFFICULTY[0];
    for (const d of DIFFICULTY) {
      if (score >= d.minScore) tier = d;
    }
    return tier;
  }

  /**
   * Pick a cargo color for the next incoming boat. Boats are no longer
   * pre-assigned to a specific dock — any dock of the matching color can
   * accept them. Equal chance of yellow or purple.
   */
  _pickColor(diff) {
    const colors = [YELLOW, PURPLE];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /** Queue one spawn entry. Returns true if queued successfully. */
  _queueNextSpawn() {
    const diff = this._getDifficulty(this.game.score.current);

    const cargoColor = this._pickColor(diff);

    const edges     = Object.keys(EDGE_CONFIG);
    const edge      = edges[Math.floor(Math.random() * edges.length)];
    const varyCoord = this._pickCoord(edge);
    const type      = diff.types[Math.floor(Math.random() * diff.types.length)];

    this.pendingSpawns.push({
      timeUntilSpawn: WARNING_SECS,
      edge,
      varyCoord,
      type,
      cargoColor,
      targetDockId: null,
    });

    return true;
  }

  _pickCoord(edge) {
    const { ranges } = EDGE_CONFIG[edge];
    const totalLen = ranges.reduce((s, [a, b]) => s + (b - a), 0);
    let pick = Math.random() * totalLen;
    for (const [a, b] of ranges) {
      const len = b - a;
      if (pick < len) return a + pick;
      pick -= len;
    }
    const [a, b] = ranges[ranges.length - 1];
    return a + Math.random() * (b - a);
  }

  _spawnFromPending(p) {
    if (this.boats.length >= MAX_BOATS) return;

    const { edge, varyCoord, type, cargoColor } = p;
    const cfg  = EDGE_CONFIG[edge];
    const x    = cfg.varyAxis === 'x' ? varyCoord : cfg.fixedVal;
    const y    = cfg.varyAxis === 'y' ? varyCoord : cfg.fixedVal;

    const boat          = new Boat({ type, cargo: true, cargoColor, x, y });
    boat.angle          = cfg.headingAngle;
    // Add random angle variation ±35 degrees so boats enter at varied headings
    const variation = (Math.random() - 0.5) * (70 * Math.PI / 180); // ±35°
    boat.angle = cfg.headingAngle + variation;
    // No pre-set path — boats drift straight until the player draws one.
    boat.path           = [];
    boat.pathIndex      = 0;
    boat.sprite         = this.game.assets.get(
      boat.cargoRemaining > 0
        ? `${boat.type}_cargo`
        : `${boat.type}_empty`
    );
    // No pre-assignment — boat docks at any matching-color dock it reaches.
    boat.targetDockId   = null;
    // hw/hh/radius are set in the Boat constructor from measured sprite size.

    // Every 3rd large boat carries mixed cargo: 2 yellow then 2 purple,
    // requiring a stop at a yellow dock followed by a purple dock.
    if (type === 'large') {
      this.largeBoatCount++;
      if (this.largeBoatCount % 3 === 0) {
        boat.mixedCargo        = true;
        boat.cargoColor        = '#FFD700';
        boat.primaryCargoCount = 2;
        boat.secondaryColor    = '#8B5CF6';
        boat.cargoCount        = 4;
        boat.cargoRemaining    = 4;
      }
    }

    this.boats.push(boat);
  }

  _renderArrow(ctx, pending, now) {
    const { edge, varyCoord, cargoColor, timeUntilSpawn } = pending;
    const cfg = ARROW_RENDER[edge];
    if (!cfg) return;
    const { x, y } = cfg.getPos(varyCoord);

    const pulse   = 0.5 + 0.5 * Math.abs(Math.sin((now / 1000) * Math.PI * 4)); // 2 Hz
    const urgency = 1 - timeUntilSpawn / WARNING_SECS;
    const alpha   = Math.max(0.4, pulse * (0.5 + 0.5 * urgency));

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(cfg.angle);
    ctx.globalAlpha = alpha;

    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(-8, -11);
    ctx.lineTo(-2,  0);
    ctx.lineTo(-8,  11);
    ctx.closePath();

    ctx.fillStyle   = cargoColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2;
    ctx.stroke();

    ctx.restore();
  }
}
