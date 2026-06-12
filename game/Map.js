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

    // Pre-scaled background cache. Downscaling the 2400×1792 source PNG with
    // filtering EVERY frame is the single most expensive draw call — instead
    // it is rendered once into an offscreen canvas sized to the device
    // resolution and blitted from there. Rebuilt lazily if the DPR changes
    // (e.g. window dragged to another screen).
    this._bgCanvas  = null;
    this._bgCanvasW = 0;

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
      ctx.drawImage(this._scaledBackground(), 0, 0, this.width, this.height);
    } else {
      ctx.fillStyle = '#1f6f9e';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    for (const dock of this.docks) dock.render(ctx);
  }

  /** Offscreen canvas with the background pre-scaled to device resolution. */
  _scaledBackground() {
    const dpr = window.devicePixelRatio || 1;
    const srcW = this.background.naturalWidth || this.background.width;
    // Never upscale beyond the source; otherwise match device pixels.
    const w = Math.min(srcW, Math.round(this.width * dpr));
    if (this._bgCanvas && this._bgCanvasW === w) return this._bgCanvas;

    const h  = Math.round(w * (this.height / this.width));
    const oc = document.createElement('canvas');
    oc.width  = w;
    oc.height = h;
    const octx = oc.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';   // one-time cost, full quality
    octx.drawImage(this.background, 0, 0, w, h);

    this._bgCanvas  = oc;
    this._bgCanvasW = w;
    return oc;
  }
}
