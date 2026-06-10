/**
 * Dock
 * ----
 * A docking berth where boats of a matching color unload.
 * Position is the center (cx, cy) in canvas space.
 *
 * No painted indicator — dock locations are baked into the background map.
 * The only thing Dock draws is a subtle white dashed ring while the player's
 * in-progress path is snapping to this dock.
 */

// Mirror of Game.js UNLOAD_TIME_PER_CARGO (in seconds) — avoids circular import.
const UNLOAD_INTERVAL = 1.75;
const FLASH_DURATION  = 0.55;  // seconds for wrong-color red flash

// Catch radius — a matching-color ship this close is forcefully pulled in and
// locked. Matched to the land-collision skip radius (90px) so there is no ring
// where a ship neither docks nor bounces (which is what let ships clip land).
export const DOCK_APPROACH_RADIUS = 90;

export class Dock {
  /**
   * @param {{ id, cx, cy, color, approachVector?: [number, number] }} def
   *   approachVector — unit-length direction the boat should be HEADING when
   *   it docks. Docking only triggers when boat.heading · approachVector > 0
   *   (within 90° of the approach direction). Defaults to [0, -1] (from below).
   */
  constructor({ id, cx, cy, color, approachVector = [0, -1] }) {
    this.id    = id;
    this.cx    = cx;
    this.cy    = cy;
    this.color = color;
    this.approachVector = approachVector;

    this.occupied      = false;
    this.unloadingBoat = null;
    this.unloadTimer   = 0;
    this.flashTimer    = 0;
    this.snapHighlight = false;  // green ring while player's path is snapping here
  }

  get center() {
    return { x: this.cx, y: this.cy };
  }

  // ---------- Gameplay ----------

  /**
   * Reserve this berth and send the boat into a DOCKING approach. The boat
   * physically sails the rest of the way to the berth center and aligns its
   * bow to the dock's inward angle — NO teleport. Boat._updateDocking() flips
   * it to UNLOADING once it has arrived and aligned.
   */
  beginDocking(boat) {
    this.occupied      = true;   // reserve immediately so no other boat targets it
    this.unloadingBoat = boat;
    this.unloadTimer   = 0;

    boat.clearPath();
    boat.dockTarget = this;
    boat.dockCenter = { x: this.cx, y: this.cy };
    boat.dockAngle  = (this.inwardAngle != null) ? this.inwardAngle : boat.angle;
    boat.state      = 'DOCKING';
  }

  /** Trigger a brief red flash. */
  flashWrongColor() {
    this.flashTimer = FLASH_DURATION;
  }

  /**
   * Unloading finished: park the boat in WAITING_EXIT and have it immediately
   * turn to face the ocean (opposite the inward dock pose) while it waits.
   */
  _sendToWaitingExit(boat) {
    boat.state = 'WAITING_EXIT';
    boat.clearPath();
    boat.exitAngle = (boat.dockAngle != null)
      ? boat.dockAngle + Math.PI
      : boat.angle + Math.PI;
  }

  /**
   * Tick the unload sequence.
   * @param {number}   dt      seconds since last frame
   * @param {Function} onPlink called once per cargo block removed
   */
  update(dt, onPlink) {
    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);

    if (!this.occupied || !this.unloadingBoat) return;

    const boat = this.unloadingBoat;

    // Still sailing into the berth — hold the reservation but don't unload yet.
    if (boat.state === 'DOCKING') return;

    // This dock unloads ONLY the blocks matching its own color. Mixed ships keep
    // their other-color cargo aboard for a later dock.
    const colorLeft = boat.cargoForColor(this.color);

    // This dock's color is fully unloaded → wait for an exit path (keeping any
    // remaining other-color cargo). Release the berth once the boat departs and
    // has moved clear of it (>80px). A still-loaded ship resumes SAILING (so it
    // can dock again); an empty ship goes EXITING.
    if (colorLeft === 0) {
      if (boat.state === 'UNLOADING') {
        this._sendToWaitingExit(boat);
      }
      if (boat.state !== 'WAITING_EXIT') {
        const dist = Math.hypot(boat.x - this.cx, boat.y - this.cy);
        if (dist > 80) {
          this.occupied      = false;
          this.unloadingBoat = null;
        }
      }
      return;
    }

    this.unloadTimer += dt;
    if (this.unloadTimer >= UNLOAD_INTERVAL) {
      this.unloadTimer -= UNLOAD_INTERVAL;
      boat.removeCargoOfColor(this.color);
      onPlink?.();

      if (boat.cargoForColor(this.color) === 0) {
        // This dock's cargo is done — turn to face the ocean and wait for a path.
        this._sendToWaitingExit(boat);
        // Berth stays occupied until the boat leaves (handled above next tick).
      }
    }
  }

  // ---------- Rendering ----------

  render(ctx) {
    // No visual indicator — dock positions are shown on background map.
    // Only show snap highlight when player is drawing near this dock.
    if (this.snapHighlight) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.arc(this.center.x, this.center.y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
