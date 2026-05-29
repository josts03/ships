/**
 * Map (exported as GameMap to avoid shadowing the built-in Map)
 * -------------------------------------------------------------
 * Static playfield: background image + pixel-based collision + six docks.
 *
 * All geometry is now derived from collision_map.png (2400×1792px).
 * There are no hardcoded polygons or zone rectangles.
 *
 * Dock positions, colors and approach vectors are auto-detected at startup
 * by CollisionMap.findDockCenters().
 */
import { Dock } from './Dock.js';
import { CollisionMap } from './CollisionMap.js';

export class GameMap {
  constructor(assets, width, height) {
    this.assets = assets;
    this.width  = width;
    this.height = height;

    this.background = assets.get('background');

    // ── Pixel collision ──────────────────────────────────────────────────
    const collisionImg = assets.get('collision_map');
    this.collisionMap  = new CollisionMap(collisionImg, width, height);

    // ── Docks (auto-detected from collision_map pixel colors) ────────────
    const dockDefs = this.collisionMap.findDockCenters();
    this.docks     = dockDefs.map((d) => new Dock(d));

    if (this.docks.length === 0) {
      console.warn('[GameMap] No docks found in collision_map – check PNG colors.');
    }
  }

  // ── Convenience ────────────────────────────────────────────────────────

  dockByColor(color) {
    return this.docks.find((d) => d.color === color) ?? null;
  }

  // ── Collision queries (canvas-space) ───────────────────────────────────

  /** True if (x, y) is on land according to the collision map. */
  isLand(x, y) {
    return this.collisionMap.isLand(x, y);
  }

  /**
   * Outward surface normal at a land point.
   * @returns {[number, number]}
   */
  getLandNormal(x, y) {
    return this.collisionMap.getLandNormal(x, y);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  render(ctx) {
    if (this.background) {
      ctx.drawImage(this.background, 0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = '#1f6f9e';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    for (const dock of this.docks) dock.render(ctx);
  }
}
