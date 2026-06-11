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

// THE global unload pace — single source of truth for EVERY dock (Game.js
// re-exports it with the other gameplay constants). One cargo block leaves the
// ship exactly this often while it is parked in the UNLOADING state; the timer
// is strictly dt-driven, so no dock can run faster or slower than the others.
export const UNLOAD_INTERVAL_MS = 800;
const UNLOAD_INTERVAL = UNLOAD_INTERVAL_MS / 1000;  // seconds (dt is seconds)

const FLASH_DURATION  = 0.55;  // seconds for wrong-color red flash

// Catch radius — small, so a ship must physically sail INTO the berth entrance
// before the dock takes over for the final alignment. No long-range magnet.
export const DOCK_APPROACH_RADIUS = 28;

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
   * @param {number}   dt          seconds since last frame
   * @param {Function} onPlink     called once per cargo block removed
   * @param {Function} onShipEmpty called once when the ship's LAST block (any
   *                               color) is removed — it is ready to turn
   */
  update(dt, onPlink, onShipEmpty) {
    if (this.flashTimer > 0) this.flashTimer = Math.max(0, this.flashTimer - dt);

    if (!this.occupied || !this.unloadingBoat) return;

    const boat = this.unloadingBoat;

    // The reserved boat no longer exists (despawned or sunk) — free the berth
    // so the dock doesn't stay blocked forever.
    if (!boat.alive || boat.state === 'SUNK') {
      this.occupied      = false;
      this.unloadingBoat = null;
      this.unloadTimer   = 0;
      return;
    }

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
          this.unloadTimer   = 0;
        }
      }
      return;
    }

    // STRICT global pace: the timer advances ONLY while the ship is parked in
    // the UNLOADING state — never during the approach, the exit wait, or the
    // departure — so every dock unloads at exactly UNLOAD_INTERVAL_MS.
    if (boat.state !== 'UNLOADING') return;

    this.unloadTimer += dt;
    if (this.unloadTimer >= UNLOAD_INTERVAL) {
      this.unloadTimer -= UNLOAD_INTERVAL;
      boat.removeCargoOfColor(this.color);
      onPlink?.();

      if (boat.cargoForColor(this.color) === 0) {
        // This dock's cargo is done — turn to face the ocean and wait for a path.
        this._sendToWaitingExit(boat);
        // Berth stays occupied until the boat leaves (handled above next tick).
        // Fully empty ship (no other-color cargo left) is ready to turn around.
        if (boat.cargoRemaining === 0) onShipEmpty?.();
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
