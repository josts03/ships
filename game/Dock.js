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

// How close a boat must be to its assigned dock to start unloading.
export const DOCK_APPROACH_RADIUS = 55;

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
   * Snap the boat to dock center and begin unloading.
   */
  startUnloading(boat) {
    this.occupied      = true;
    this.unloadingBoat = boat;
    this.unloadTimer   = 0;

    const c = this.center;
    boat.x = c.x;
    boat.y = c.y;
    boat.clearPath();
    boat.state = 'UNLOADING';
  }

  /** Trigger a brief red flash. */
  flashWrongColor() {
    this.flashTimer = FLASH_DURATION;
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

    // Mixed cargo: once the primary blocks are unloaded here, switch the boat
    // to its secondary color and send it back out to find a second dock.
    if (boat.mixedCargo &&
        boat.cargoRemaining === (boat.cargoCount - boat.primaryCargoCount)) {
      boat.cargoColor    = boat.secondaryColor;
      boat.mixedCargo    = false;  // now a normal boat for the secondary dock
      boat.state         = 'SAILING';
      boat.clearPath();
      this.occupied      = false;
      this.unloadingBoat = null;
      return;
    }

    // Cargo emptied: hold the berth while the boat waits for the player to draw
    // an exit path. Release the dock only once the boat actually departs
    // (Boat.update flips WAITING_EXIT → EXITING when a path is assigned). This
    // prevents a freshly-assigned boat from being routed onto the waiting one.
    if (boat.cargoRemaining === 0) {
      // Set boat to wait for an exit path once unloading is done.
      if (boat.state === 'UNLOADING') {
        boat.state = 'WAITING_EXIT';
        boat.clearPath();
      }
      // Release the dock only once the boat has departed (no longer waiting)
      // AND has actually moved clear of the berth (>80px from center).
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
      boat.cargoRemaining = Math.max(0, boat.cargoRemaining - 1);
      onPlink?.();

      if (boat.cargoRemaining === 0) {
        // Finished — wait at the dock for the player to draw an exit path.
        boat.state = 'WAITING_EXIT';
        boat.clearPath();
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
