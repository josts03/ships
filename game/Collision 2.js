/**
 * Collision
 * ---------
 * Boat-to-boat overlap detection. Returns collision pairs (game over) and
 * warning pairs (close calls, shown as pulsing red rings).
 */

export class Collision {
  /**
   * Approximate overlap test between two oriented ellipses. B's center is
   * transformed into A's local (unrotated) frame, then tested against the
   * Minkowski-summed ellipse (combined half-dimensions).
   */
  static ellipsesOverlap(ax, ay, ahw, ahh, aAngle, bx, by, bhw, bhh, bAngle) {
    // Transform b center into a's local space
    const dx = bx - ax;
    const dy = by - ay;
    const cosA = Math.cos(-aAngle), sinA = Math.sin(-aAngle);
    const lx = dx * cosA - dy * sinA;
    const ly = dx * sinA + dy * cosA;

    // Combined half-dimensions for overlap test
    const combinedW = ahw + bhw;
    const combinedH = ahh + bhh;

    // Normalized ellipse overlap test
    const nx = lx / combinedW;
    const ny = ly / combinedH;
    return (nx * nx + ny * ny) <= 1.0;
  }

  /**
   * Check all active boat pairs using ellipse hitboxes matched to sprite size.
   * @param {Boat[]} boats
   * @returns {{ collided: [Boat, Boat] | null, warnings: [Boat, Boat][] }}
   */
  checkBoatBoat(boats) {
    const active = boats.filter(
      (b) => b.alive && b.state !== 'UNLOADING' && b.state !== 'SUNK' && !b.spinState
    );

    const warnings = [];

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];

        const overlap = Collision.ellipsesOverlap(
          a.x, a.y, a.hw, a.hh, a.angle,
          b.x, b.y, b.hw, b.hh, b.angle
        );
        if (overlap) {
          return { collided: [a, b], warnings: [] };
        }

        // Warning zone: each hull's bounding box expanded by 10px, so the horn
        // + halo trigger earlier (a reaction window before the real hitbox hits).
        const warningOverlap = Collision.ellipsesOverlap(
          a.x, a.y, a.hw + 10, a.hh + 10, a.angle,
          b.x, b.y, b.hw + 10, b.hh + 10, b.angle
        );
        if (warningOverlap) {
          warnings.push([a, b]);
        }
      }
    }

    return { collided: null, warnings };
  }
}
