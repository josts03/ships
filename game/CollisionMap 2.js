/**
 * CollisionMap
 * ------------
 * Wraps a 2400×1792 collision-map PNG and provides fast canvas-space queries.
 *
 * Pixel color conventions (in the PNG):
 *   Black  r<80,  g<80,  b<80        → land / impassable
 *   Yellow r>200, g>150, b<80        → yellow dock (#FFD700)
 *   Purple r>130, g<80,  b>150       → purple dock (#8B5CF6)
 *   Anything else                    → navigable water
 *
 * All public methods accept CANVAS-space coordinates (1024×768).
 * Internally they scale to image-space (2400×1792) for the pixel lookup.
 *
 * Usage
 *   const cm = new CollisionMap(imgElement);   // build from loaded <img>
 *   cm.isLand(x, y)                            // → boolean
 *   cm.getDockAtPosition(x, y)                 // → '#FFD700' | '#8B5CF6' | null
 *   cm.findDockCenters()                       // → [{id,cx,cy,color,approachVector}]
 *   cm.getLandNormal(x, y)                     // → [nx, ny]
 *   cm.getPixelType(x, y)                      // → 'land'|'water'|'yellow'|'purple'
 */

const IMG_W = 2400;
const IMG_H = 1792;

// Pixel classification thresholds
const LAND_MAX = 110;                          // all three channels below this → land (catches dark grays too)

// Permissive helpers — defined as functions so both findDockCenters and
// getDockAtPosition share exactly the same logic.
function isYellowPixel(r, g, b) {
  return r > 180 && g > 140 && b < 100 && r > g && g > b;
}
function isPurplePixel(r, g, b) {
  // Actual purple in collision map is ~rgb(203,108,230): b is dominant, g is mid-low.
  // b>150 AND b>r (blue is highest channel) AND g<150 AND b-g gap of 60+
  return b > 150 && b > r && g < 150 && (b - g) > 60;
}

// Dock cluster merge radius in image-space pixels.
// Must be > dock circle radius (~50px) but < half the min dock-to-dock distance (~570px).
const CLUSTER_R = 100;
// Image-space step for the dock-scan pass (finer = catches small dock squares)
const SCAN_STEP = 5;

export class CollisionMap {
  /**
   * @param {HTMLImageElement|null} img  Loaded 2400×1792 collision-map PNG.
   *   Pass null to disable (all-water mode — collision still reported false).
   * @param {number} [canvasWidth=1024]   Logical canvas width  (game space).
   * @param {number} [canvasHeight=768]   Logical canvas height (game space).
   */
  constructor(img, canvasWidth = 1024, canvasHeight = 768) {
    this._cw = canvasWidth;
    this._ch = canvasHeight;

    /** @type {Uint8ClampedArray|null} */
    this._data  = null;
    this._valid = false;

    /** @type {Array|null}  cached result of findDockCenters() */
    this._dockCache = null;

    if (img) this._init(img);
  }

  _init(img) {
    const oc  = document.createElement('canvas');
    oc.width  = IMG_W;
    oc.height = IMG_H;
    const ctx = oc.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, IMG_W, IMG_H);
    try {
      this._data  = ctx.getImageData(0, 0, IMG_W, IMG_H).data;
      this._valid = true;
    } catch (e) {
      console.warn('[CollisionMap] getImageData failed (CORS?):', e.message);
    }
  }

  // ── Internal pixel access ──────────────────────────────────────────────

  /**
   * Return [r, g, b, a] at image-space (ix, iy). Clamps to image bounds.
   * Returns [255,255,255,255] (white/water) if data is not loaded.
   */
  getCollisionPixel(ix, iy) {
    if (!this._valid) return [255, 255, 255, 255];
    const x = Math.round(Math.max(0, Math.min(IMG_W - 1, ix)));
    const y = Math.round(Math.max(0, Math.min(IMG_H - 1, iy)));
    const i = (y * IMG_W + x) * 4;
    const d = this._data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  /** Canvas-space → image-space (no rounding — callers round as needed). */
  _toImg(cx, cy) {
    return [cx * (IMG_W / this._cw), cy * (IMG_H / this._ch)];
  }

  // ── Public queries ─────────────────────────────────────────────────────

  /** True if the canvas-space point lies on land (black pixel). */
  isLand(canvasX, canvasY) {
    if (!this._valid) return false;
    const [ix, iy] = this._toImg(canvasX, canvasY);
    const [r, g, b] = this.getCollisionPixel(ix, iy);
    return r < LAND_MAX && g < LAND_MAX && b < LAND_MAX;
  }

  /**
   * Returns the dock color at a canvas-space point, or null if water/land.
   * @returns {'#FFD700'|'#8B5CF6'|null}
   */
  getDockAtPosition(canvasX, canvasY) {
    if (!this._valid) return null;
    const [ix, iy] = this._toImg(canvasX, canvasY);
    const [r, g, b] = this.getCollisionPixel(ix, iy);
    if (isYellowPixel(r, g, b)) return '#FFD700';
    if (isPurplePixel(r, g, b)) return '#8B5CF6';
    return null;
  }

  /**
   * Scan the image every SCAN_STEP pixels to locate dock-colored regions.
   * Clusters hits within CLUSTER_R (image-space), averages each cluster to
   * get a dock center, then converts to canvas-space.
   *
   * @returns {Array<{id,cx,cy,color,approachVector}>}  canvas-space dock defs
   */
  findDockCenters() {
    if (this._dockCache) return this._dockCache;
    if (!this._valid) return [];

    // ── Pass 1: collect hits ──
    const hits = [];   // { ix, iy, color }
    for (let iy = 0; iy < IMG_H; iy += SCAN_STEP) {
      for (let ix = 0; ix < IMG_W; ix += SCAN_STEP) {
        const [r, g, b] = this.getCollisionPixel(ix, iy);
        if (isYellowPixel(r, g, b)) {
          hits.push({ ix, iy, color: '#FFD700' });
        } else if (isPurplePixel(r, g, b)) {
          hits.push({ ix, iy, color: '#8B5CF6' });
        }
      }
    }

    // ── Pass 2: greedy clustering ──
    // Each cluster: { color, cx, cy, sumX, sumY, count }
    const clusters = [];
    for (const h of hits) {
      let best = null, bestD = Infinity;
      for (const cl of clusters) {
        if (cl.color !== h.color) continue;
        const d = Math.hypot(h.ix - cl.cx, h.iy - cl.cy);
        if (d < CLUSTER_R && d < bestD) { bestD = d; best = cl; }
      }
      if (best) {
        best.sumX += h.ix;  best.sumY += h.iy;  best.count++;
        best.cx = best.sumX / best.count;
        best.cy = best.sumY / best.count;
      } else {
        clusters.push({
          color: h.color,
          cx: h.ix, cy: h.iy,
          sumX: h.ix, sumY: h.iy,
          count: 1,
        });
      }
    }

    // Ignore tiny noise clusters (fewer than 4 scan hits)
    const valid = clusters.filter((c) => c.count >= 4);

    // Sort: yellows by x then y; purples after
    valid.sort((a, b) => {
      if (a.color !== b.color) return a.color === '#FFD700' ? -1 : 1;
      const dx = a.cx - b.cx;
      return Math.abs(dx) > 20 ? dx : a.cy - b.cy;
    });

    // Convert to canvas-space dock definitions
    const scaleX = this._cw / IMG_W;
    const scaleY = this._ch / IMG_H;

    this._dockCache = valid.map((cl, idx) => {
      const cx = cl.cx * scaleX;
      const cy = cl.cy * scaleY;
      return {
        id:            idx + 1,
        cx,
        cy,
        color:         cl.color,
        approachVector: this._inferApproachVector(cx, cy, cl.color),
      };
    });

    return this._dockCache;
  }

  /**
   * Heuristic approach vector based on dock canvas position:
   *   top third (cy < CH/3)        → [0,-1]    heading upward
   *   bottom third (cy > 2*CH/3)   → [1,0]     heading right
   *   middle (island) purple left  → [0.707,-0.707]
   *   middle (island) purple right → [-0.707,0.707]
   *   default                      → [0,-1]
   */
  _inferApproachVector(cx, cy, color) {
    if (cy < this._ch / 3)          return [0, -1];
    if (cy > (this._ch * 2) / 3)    return [1,  0];
    if (color === '#8B5CF6')        return cx < this._cw / 2 ? [0.707, -0.707] : [-0.707, 0.707];
    return [0, -1];
  }

  /**
   * Compute an outward surface normal at a land point.
   * Samples 8 compass directions at PROBE canvas pixels away; the normal
   * is the average of directions that are open water.
   *
   * @param {number} canvasX
   * @param {number} canvasY
   * @returns {[number, number]}  unit vector pointing into open water
   */
  getLandNormal(canvasX, canvasY) {
    if (!this._valid) return [0, 1];

    const PROBE = 8;
    const DIRS  = [
      [ 1,  0], [-1,  0], [ 0,  1], [ 0, -1],
      [ 0.707,  0.707], [-0.707,  0.707],
      [ 0.707, -0.707], [-0.707, -0.707],
    ];

    let nx = 0, ny = 0;
    for (const [dx, dy] of DIRS) {
      const sx = canvasX + dx * PROBE;
      const sy = canvasY + dy * PROBE;
      if (!this.isLand(sx, sy)) { nx += dx; ny += dy; }
    }

    const len = Math.hypot(nx, ny);
    return len < 0.001 ? [0, 1] : [nx / len, ny / len];
  }

  /**
   * Pixel type for the debug overlay.
   * @returns {'land'|'water'|'yellow'|'purple'}
   */
  getPixelType(canvasX, canvasY) {
    if (!this._valid) return 'water';
    const dock = this.getDockAtPosition(canvasX, canvasY);
    if (dock === '#FFD700') return 'yellow';
    if (dock === '#8B5CF6') return 'purple';
    if (this.isLand(canvasX, canvasY)) return 'land';
    return 'water';
  }
}
