/**
 * PathDrawing
 * -----------
 * Handles finger/mouse input to draw paths for boats.
 * Pointer down on a boat → record drag points → release → assign Catmull-Rom
 * spline as the boat's new path.
 * Tap (< 10px travel) → erase boat's path (continue straight).
 */

const MIN_SPLINE_POINTS = 4;  // minimum downsample points for a smooth curve
const RECORD_DIST       = 5;  // px between recorded raw points (pointermove kept light)
const DOWNSAMPLE_DIST   = 8;  // px between spline control points
const SAMPLE_STEP       = 5;  // px between sampled waypoints on the final spline
const TAP_THRESHOLD     = 10; // px total drag to count as a tap (erase) vs draw

// Path-vs-land truncation.
const LAND_SAMPLE_STEP  = 4;  // px between land-collision samples along a segment
const DOCK_OPENING      = 48; // px radius around a dock center treated as passable

export class PathDrawing {
  constructor(game) {
    this.game = game;

    this.selectedBoat     = null;
    this.activePointerId  = null;
    this.rawPoints        = [];   // points recorded during this drag
    this._followAssigned  = false; // true once the boat is following live
  }

  // ---------- Pointer event handlers (called by Game.js) ----------

  onPointerDown(x, y, pointerId) {
    const boat = this._boatAt(x, y);
    if (!boat) return false;

    this.selectedBoat    = boat;
    this.activePointerId = pointerId;
    // Start the path exactly at the boat so it follows from its own position.
    this.rawPoints       = [{ x: boat.x, y: boat.y }];
    this._followAssigned = false;
    boat.highlighted     = true;
    return true;  // tells Game to capture the pointer
  }

  onPointerMove(x, y, pointerId) {
    if (this.activePointerId !== pointerId || !this.selectedBoat) return;
    const last = this.rawPoints[this.rawPoints.length - 1];
    if (Math.hypot(x - last.x, y - last.y) >= RECORD_DIST) {
      // Real-time truncation: never register a point/segment inside a landmass.
      if (this._segmentClear(last, { x, y })) {
        this.rawPoints.push({ x, y });
      } else {
        // Drag crossed a barrier — clamp the path to the water edge. (Once the
        // finger returns to open water, drawing resumes from this edge point.)
        const edge = this._clampToEdge(last, { x, y });
        if (Math.hypot(edge.x - last.x, edge.y - last.y) >= RECORD_DIST) {
          this.rawPoints.push(edge);
        }
      }
    }

    // Dock snap assist: if the cursor is near a dock that matches this boat's
    // cargo color, pin the path's last point to the exact dock center and
    // highlight that dock. Clear all highlights first so only one shows.
    // Only snap loaded boats that are still sailing — never empty boats that
    // are waiting to exit or already exiting.
    const SNAP_RADIUS = 30;   // must draw into the dock entrance — minimal magnet
    for (const dock of this.game.map.docks) dock.snapHighlight = false;

    const boat = this.selectedBoat;
    if (boat.cargoRemaining > 0 && boat.state === 'SAILING') {
      for (const dock of this.game.map.docks) {
        if (boat.cargoForColor(dock.color) <= 0) continue;
        const dist = Math.hypot(x - dock.center.x, y - dock.center.y);
        if (dist < SNAP_RADIUS) {
          if (this.rawPoints.length > 0) {
            this.rawPoints[this.rawPoints.length - 1] = {
              x: dock.center.x,
              y: dock.center.y,
            };
          }
          dock.snapHighlight = true;
          break;
        }
      }
    }

    // Real-time following: as soon as a couple of points exist, hand the LIVE
    // raw-point array to the boat so it starts orienting and moving immediately,
    // without waiting for pointerup. The array keeps growing as we draw.
    if (!this._followAssigned && this.rawPoints.length >= 2) {
      boat.path       = this.rawPoints;
      boat.pathIndex  = 0;
      this._followAssigned = true;
    }
  }

  onPointerUp(_x, _y, pointerId) {
    if (this.activePointerId !== pointerId) return;
    this._finalize();
  }

  cancel(pointerId) {
    if (this.activePointerId !== pointerId) return;
    this._clearSelection();
  }

  // ---------- Finalize drag ----------

  _finalize() {
    const boat = this.selectedBoat;
    if (!boat) return;

    const pathLength = this._polylineLength(this.rawPoints);
    if (pathLength < TAP_THRESHOLD) {
      // Tap: erase path so the boat continues straight / stops following.
      boat.clearPath();
    } else {
      // The boat has been following the live raw path during the drag. Ensure
      // it is assigned (fallback) and finish empty boats off with an edge-snap
      // so they fully exit the screen.
      if (!this._followAssigned) {
        boat.path = this.rawPoints;
        boat.pathIndex = 0;
      }
      if (boat.state === 'EXITING' || boat.state === 'WAITING_EXIT') {
        this._applyEdgeSnap(boat.path);
      }
    }

    this._clearSelection();
  }

  _clearSelection() {
    if (this.selectedBoat) {
      this.selectedBoat.highlighted = false;
    }
    // Drop any dock snap highlights once the drag is over.
    if (this.game.map?.docks) {
      for (const dock of this.game.map.docks) dock.snapHighlight = false;
    }
    this.selectedBoat    = null;
    this.activePointerId = null;
    // New array — the boat keeps following the old one (its committed path).
    this.rawPoints       = [];
    this._followAssigned = false;
  }

  /**
   * If a path's last point lands within EDGE_SNAP of a screen edge, project it
   * onto that edge and add a waypoint BEYOND the edge so the boat fully exits.
   */
  _applyEdgeSnap(path) {
    const EDGE_SNAP = 60;
    const BEYOND    = 150;
    const W = this.game.canvas.width;
    const H = this.game.canvas.height;

    const last = path[path.length - 1];
    const dl = last.x, dr = W - last.x, dtop = last.y, db = H - last.y;
    const m = Math.min(dl, dr, dtop, db);
    if (m > EDGE_SNAP) return;  // not near any edge

    if (m === dl)        path.push({ x: 0, y: last.y }, { x: -BEYOND,   y: last.y });
    else if (m === dr)   path.push({ x: W, y: last.y }, { x: W + BEYOND, y: last.y });
    else if (m === dtop) path.push({ x: last.x, y: 0 }, { x: last.x, y: -BEYOND });
    else                 path.push({ x: last.x, y: H }, { x: last.x, y: H + BEYOND });
  }

  // ---------- Land / barrier truncation ----------

  /**
   * True if (x, y) lies inside an impassable static body (island / concrete
   * barrier). Dock berths are legitimate openings, so points within
   * DOCK_OPENING of a dock center are always passable.
   */
  _blocked(x, y) {
    const map = this.game.map;
    if (!map || !map.isLand(x, y)) return false;
    for (const dock of map.docks) {
      const c = dock.center;
      if (Math.hypot(x - c.x, y - c.y) < DOCK_OPENING) return false;
    }
    return true;
  }

  /** True if the straight segment a→b is entirely clear of barriers. */
  _segmentClear(a, b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(dist / LAND_SAMPLE_STEP));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (this._blocked(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
  }

  /** Furthest point along a→b that is still clear of barriers (water edge). */
  _clampToEdge(a, b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(dist / LAND_SAMPLE_STEP));
    let edge = { x: a.x, y: a.y };
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      if (this._blocked(px, py)) break;
      edge = { x: px, y: py };
    }
    return edge;
  }

  /** Cut a finished path at the first point that lands inside a barrier. */
  _truncateAtLand(path) {
    for (let i = 0; i < path.length; i++) {
      if (this._blocked(path[i].x, path[i].y)) {
        return path.slice(0, i);
      }
    }
    return path;
  }

  // ---------- Catmull-Rom spline ----------

  /**
   * Convert raw touch points to a dense array of waypoints via Catmull-Rom.
   * Steps: downsample → add phantom endpoints → evaluate spline at 5px intervals.
   */
  buildSpline(rawPoints) {
    if (rawPoints.length < 2) return rawPoints.slice();

    const ctrl = this._downsample(rawPoints, DOWNSAMPLE_DIST);

    if (ctrl.length < 2) return ctrl;
    if (ctrl.length < MIN_SPLINE_POINTS) {
      // Pad to at least 4 control points by interpolating.
      while (ctrl.length < MIN_SPLINE_POINTS) {
        const last = ctrl[ctrl.length - 1];
        const prev = ctrl[ctrl.length - 2];
        ctrl.push({
          x: last.x + (last.x - prev.x),
          y: last.y + (last.y - prev.y),
        });
      }
    }

    // Phantom first and last control points (repeat endpoints).
    const pts = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];

    const result = [];
    for (let i = 1; i < pts.length - 2; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2];
      // Approximate segment length to know how many samples.
      const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps  = Math.max(1, Math.ceil(segLen / SAMPLE_STEP));

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        result.push(this._catmullRom(p0, p1, p2, p3, t));
      }
    }

    return result;
  }

  /** Evaluate one Catmull-Rom segment at t ∈ [0,1]. */
  _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * (2*p1.x + (-p0.x + p2.x)*t + (2*p0.x - 5*p1.x + 4*p2.x - p3.x)*t2 + (-p0.x + 3*p1.x - 3*p2.x + p3.x)*t3),
      y: 0.5 * (2*p1.y + (-p0.y + p2.y)*t + (2*p0.y - 5*p1.y + 4*p2.y - p3.y)*t2 + (-p0.y + 3*p1.y - 3*p2.y + p3.y)*t3),
    };
  }

  /** Reduce points to roughly `spacing` px apart. */
  _downsample(pts, spacing) {
    if (pts.length === 0) return [];
    const out = [pts[0]];
    let accum = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
      accum += d;
      if (accum >= spacing) {
        out.push(pts[i]);
        accum = 0;
      }
    }
    // Always include the last point.
    const last = pts[pts.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }

  _polylineLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y);
    }
    return len;
  }

  // ---------- Boat hit-test ----------

  _boatAt(x, y) {
    const boats = this.game.spawner.boats;
    let best = null, bestDist = Infinity;
    for (const boat of boats) {
      if (!boat.alive) continue;
      const d = Math.hypot(x - boat.x, y - boat.y);
      const hitR = Math.max(boat.hw, boat.hh) + 20;
      if (d <= hitR && d < bestDist) {
        bestDist = d;
        best = boat;
      }
    }
    return best;
  }

  // ---------- Rendering ----------

  render(ctx) {
    // Active boats' remaining paths.
    for (const boat of this.game.spawner.boats) {
      if (!boat.alive) continue;
      this._renderBoatPath(ctx, boat);
    }

    // In-progress drag preview (the raw points drawn live).
    if (this.selectedBoat && this.rawPoints.length >= 2) {
      this._renderPreview(ctx);
    }
  }

  _renderBoatPath(ctx, boat) {
    const path = boat.path;
    if (!path || path.length < 2) return;
    const start = boat.pathIndex;
    if (start >= path.length) return;

    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2.5;
    ctx.setLineDash([]);          // solid line

    ctx.beginPath();
    ctx.moveTo(boat.x, boat.y);
    for (let i = start; i < path.length; i++) {
      ctx.lineTo(path[i].x, path[i].y);
    }
    ctx.stroke();

    ctx.restore();
  }

  _renderPreview(ctx) {
    const boat = this.selectedBoat;
    // Origin is the ship's CENTER — rawPoints[0] is where the hull sat at
    // pointerdown, which the live-following ship has since moved past. Skip
    // the points it already consumed so the line stretches from the deck to
    // the fingertip instead of trailing underneath the hull.
    const start = (boat.path === this.rawPoints) ? boat.pathIndex : 0;
    if (start >= this.rawPoints.length) return;

    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2;
    ctx.setLineDash([]);          // solid line

    ctx.beginPath();
    ctx.moveTo(boat.x, boat.y);
    for (let i = start; i < this.rawPoints.length; i++) {
      ctx.lineTo(this.rawPoints[i].x, this.rawPoints[i].y);
    }
    ctx.stroke();

    ctx.restore();
  }
}
