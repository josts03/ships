/**
 * DebugOverlay
 * ------------
 * Optional visual diagnostic layer drawn on top of everything.
 *
 * Toggle:  press  D  on keyboard
 *          OR     triple-tap  within 800 ms on touch/pointer
 *
 * Renders (in order):
 *  1. Pixel-type dot grid (30px apart) — red=land, green=water, yellow/purple=dock
 *  2. Dock circles — dashed ring (r=60), approach ring, approach arrow, ID label
 *  3. Spawn zones — green vertical bands at left/right canvas edges
 *  4. Boat hitboxes — per-boat collision circle + state tag
 *  5. Corner label — "DEBUG MODE ON"
 */
import { DOCK_APPROACH_RADIUS } from './Dock.js';

const CW = 1024;
const CH =  768;

/**
 * Spawn edge positions (canvas space, derived from Spawner EDGE_CONFIG).
 * The x values are the canvas-edge coordinates (0 = left, 1024 = right).
 */
const SPAWN_EDGES = [
  { name: 'LEFT',   x: 0,    y: null, yMin: 220, yMax: 720, xMin: null, xMax: null, dirAngle: 0,          isVertical: true  },
  { name: 'RIGHT',  x: 1024, y: null, yMin: 100, yMax: 520, xMin: null, xMax: null, dirAngle: Math.PI,    isVertical: true  },
  { name: 'TOP',    x: null, y: 0,    yMin: null, yMax: null, xMin: 774, xMax: 1024, dirAngle: Math.PI/2,  isVertical: false },
  { name: 'BOTTOM', x: null, y: 768,  yMin: null, yMax: null, xMin: 0,   xMax: 580, dirAngle: -Math.PI/2, isVertical: false },
];

/** How far apart the debug pixel-type dots are sampled (canvas space). */
const DOT_STEP = 30;

export class DebugOverlay {
  constructor(game) {
    this.game    = game;
    this.enabled = false;

    // Triple-tap tracking: store up to last 3 tap timestamps.
    this._tapTimes = [];
  }

  // ---------- Public API ----------

  toggle() {
    this.enabled = !this.enabled;
  }

  /**
   * Call on every pointerdown event to detect a triple-tap.
   * @param {number} timestamp  e.g. Date.now() or performance.now()
   */
  onTap(timestamp) {
    this._tapTimes.push(timestamp);
    if (this._tapTimes.length > 3) this._tapTimes.shift();
    if (this._tapTimes.length === 3 &&
        this._tapTimes[2] - this._tapTimes[0] < 800) {
      this.toggle();
      this._tapTimes = [];
    }
  }

  /** Render the overlay. No-op when disabled. */
  render(ctx) {
    if (!this.enabled) return;

    this._renderPixelGrid(ctx);
    this._renderDocks(ctx);
    this._renderSpawnZones(ctx);
    this._renderBoatHitboxes(ctx);
    this._renderLabel(ctx);
  }

  // ---------- 1 — Pixel-type dot grid ----------

  /**
   * Sample the collision map every DOT_STEP pixels and draw a small colored dot:
   *   red    — land
   *   green  — navigable water
   *   yellow — yellow dock pixel
   *   purple — purple dock pixel
   */
  _renderPixelGrid(ctx) {
    const cm = this.game.map?.collisionMap;
    if (!cm) return;

    ctx.save();
    for (let y = DOT_STEP / 2; y < CH; y += DOT_STEP) {
      for (let x = DOT_STEP / 2; x < CW; x += DOT_STEP) {
        const type = cm.getPixelType(x, y);
        switch (type) {
          case 'land':   ctx.fillStyle = 'rgba(255,  50,  50, 0.75)'; break;
          case 'yellow': ctx.fillStyle = 'rgba(255, 215,   0, 0.90)'; break;
          case 'purple': ctx.fillStyle = 'rgba(139,  92, 246, 0.90)'; break;
          default:       ctx.fillStyle = 'rgba( 50, 220,  80, 0.30)'; break; // water
        }
        ctx.beginPath();
        ctx.arc(x, y, type === 'water' ? 2 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------- 2 — Dock positions ----------

  _renderDocks(ctx) {
    const docks = this.game.map?.docks ?? [];
    ctx.save();

    for (const dock of docks) {
      const isYellow = dock.color === '#FFD700';
      const c        = dock.center;

      // Large indicator circle (r = 60, dashed)
      ctx.beginPath();
      ctx.arc(c.x, c.y, 60, 0, Math.PI * 2);
      ctx.fillStyle = isYellow
        ? 'rgba(255, 215, 0, 0.14)'
        : 'rgba(139, 92, 246, 0.14)';
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = dock.color;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      // Solid approach-radius ring
      ctx.beginPath();
      ctx.arc(c.x, c.y, DOCK_APPROACH_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = dock.color;
      ctx.lineWidth   = 2;
      ctx.stroke();

      // Required approach-direction arrow
      if (dock.approachVector) {
        const [ax, ay] = dock.approachVector;
        const len = 48;
        const tipX = c.x + ax * len;
        const tipY = c.y + ay * len;
        ctx.strokeStyle = dock.color;
        ctx.lineWidth   = 3;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        // Arrowhead
        const head = 10;
        const a    = Math.atan2(ay, ax);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - head * Math.cos(a - 0.4), tipY - head * Math.sin(a - 0.4));
        ctx.lineTo(tipX - head * Math.cos(a + 0.4), tipY - head * Math.sin(a + 0.4));
        ctx.closePath();
        ctx.fillStyle = dock.color;
        ctx.fill();
      }

      // Dock ID number (large, white with shadow)
      ctx.fillStyle    = '#ffffff';
      ctx.font         = 'bold 22px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor  = '#000000';
      ctx.shadowBlur   = 5;
      ctx.fillText(dock.id, c.x, c.y);
      ctx.shadowBlur   = 0;

      // Small color hex label below ID
      ctx.fillStyle    = dock.color;
      ctx.font         = '9px monospace';
      ctx.fillText(dock.color, c.x, c.y + 14);

      // Coordinate label (small, top-right of dock)
      ctx.fillStyle    = 'rgba(255, 255, 255, 0.75)';
      ctx.font         = '9px monospace';
      ctx.textAlign    = 'left';
      ctx.fillText(`(${Math.round(c.x)},${Math.round(c.y)})`, c.x + 25, c.y - 20);
    }

    ctx.restore();
  }

  // ---------- 3 — Spawn zones ----------

  _renderSpawnZones(ctx) {
    ctx.save();
    const BAND = 20;

    for (const edge of SPAWN_EDGES) {
      ctx.fillStyle   = 'rgba(0, 220, 80, 0.20)';
      ctx.strokeStyle = 'rgba(0, 230, 80, 0.85)';
      ctx.lineWidth   = 3;

      if (edge.isVertical) {
        // LEFT / RIGHT — vertical band along the canvas side edge.
        const isLeft = edge.x === 0;
        const bx     = isLeft ? 0 : CW - BAND;
        const { yMin, yMax } = edge;

        ctx.fillRect(bx, yMin, BAND, yMax - yMin);
        ctx.beginPath();
        ctx.moveTo(edge.x, yMin);
        ctx.lineTo(edge.x, yMax);
        ctx.stroke();

        const ay = (yMin + yMax) / 2;
        const ax = isLeft ? BAND + 14 : CW - BAND - 14;
        this._dirArrow(ctx, ax, ay, edge.dirAngle);

        ctx.fillStyle    = 'rgba(60, 255, 100, 0.95)';
        ctx.font         = 'bold 11px monospace';
        ctx.textAlign    = isLeft ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.shadowColor  = '#000';
        ctx.shadowBlur   = 3;
        ctx.fillText(`${edge.name} y:${yMin}–${yMax}`,
          isLeft ? BAND + 30 : CW - BAND - 30, ay);
        ctx.shadowBlur = 0;
      } else {
        // TOP / BOTTOM — horizontal band along the canvas top/bottom edge.
        const isTop = edge.y === 0;
        const by    = isTop ? 0 : CH - BAND;
        const { xMin, xMax } = edge;

        ctx.fillRect(xMin, by, xMax - xMin, BAND);
        ctx.beginPath();
        ctx.moveTo(xMin, edge.y);
        ctx.lineTo(xMax, edge.y);
        ctx.stroke();

        const ax = (xMin + xMax) / 2;
        const ay = isTop ? BAND + 14 : CH - BAND - 14;
        this._dirArrow(ctx, ax, ay, edge.dirAngle);

        ctx.fillStyle    = 'rgba(60, 255, 100, 0.95)';
        ctx.font         = 'bold 11px monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = isTop ? 'top' : 'bottom';
        ctx.shadowColor  = '#000';
        ctx.shadowBlur   = 3;
        ctx.fillText(`${edge.name} x:${xMin}–${xMax}`,
          ax, isTop ? BAND + 26 : CH - BAND - 26);
        ctx.shadowBlur = 0;
      }
    }

    ctx.restore();
  }

  /** Draw a small filled triangle at (x,y) pointing along `angle`. */
  _dirArrow(ctx, x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = 'rgba(0, 240, 80, 0.90)';
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------- 4 — Boat hitboxes ----------

  _renderBoatHitboxes(ctx) {
    const boats = this.game.spawner?.boats ?? [];
    ctx.save();

    for (const boat of boats) {
      if (!boat.alive) continue;

      const sunk  = boat.state === 'SUNK';
      const color = sunk ? 'rgba(255,60,60,0.9)' : 'rgba(255,255,60,0.9)';

      // Collision ellipse (matches the visible sprite hull)
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.ellipse(boat.x, boat.y, boat.hw, boat.hh, boat.angle, 0, Math.PI * 2);
      ctx.stroke();

      // Center dot
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(boat.x, boat.y, 3, 0, Math.PI * 2);
      ctx.fill();

      // Heading vector
      ctx.strokeStyle = 'rgba(255, 200, 50, 0.65)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.moveTo(boat.x, boat.y);
      ctx.lineTo(
        boat.x + Math.cos(boat.angle) * (boat.radius + 14),
        boat.y + Math.sin(boat.angle) * (boat.radius + 14)
      );
      ctx.stroke();

      // Center / front / rear probe dots (land-collision check points)
      const cos = Math.cos(boat.angle), sin = Math.sin(boat.angle);
      const r08 = boat.radius * 0.8;
      const probes = [
        [boat.x,              boat.y,              '#ff0'],
        [boat.x + cos * r08,  boat.y + sin * r08,  '#ff0'],
        [boat.x - cos * r08,  boat.y - sin * r08,  '#f80'],
      ];
      for (const [px, py, col] of probes) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // State tag: "T3 S" = target dock 3, state SAILING
      ctx.fillStyle    = 'rgba(255, 255, 80, 0.92)';
      ctx.font         = '10px monospace';
      ctx.textAlign    = 'left';
      ctx.textBaseline = 'bottom';
      ctx.shadowColor  = '#000';
      ctx.shadowBlur   = 2;
      ctx.fillText(
        `T${boat.targetDockId ?? '?'} ${boat.state[0]}`,
        boat.x + boat.radius + 5,
        boat.y
      );
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  // ---------- 5 — Corner label ----------

  _renderLabel(ctx) {
    ctx.save();

    // Background pill
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    this._roundRect(ctx, 4, 4, 172, 24, 6);
    ctx.fill();

    // Green status text
    ctx.fillStyle    = 'rgba(60, 255, 80, 0.97)';
    ctx.font         = 'bold 12px monospace';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚙ DEBUG  [D] to toggle', 10, 16);

    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
