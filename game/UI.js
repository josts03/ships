/**
 * UI
 * --
 * In-game HUD, styled after the original Harbor Master:
 *   – top-left: white rounded banner hanging from the edge with the pause
 *     button ("||") and CARGO / RECORD counters in deep navy,
 *   – top-right: white ">>" fast-forward badge (inverts to navy while active).
 * Plus the pulsing collision warning circles.
 *
 * Button HIT AREAS live on Game (game.pauseButton / game.fastButton) so input
 * and visuals stay in sync; this class only draws.
 * Menu / loading / game-over screens are drawn directly by Game.
 */

const NAVY   = '#16357f';   // text + icons
const BORDER = '#2a4fa2';   // badge/banner outline
const LINE_W = 4;

export class UI {
  constructor(game) {
    this.game = game;
  }

  render(ctx) {
    this.renderCollisionWarnings(ctx);
    this.renderHud(ctx);
  }

  renderHud(ctx) {
    const score = this.game.score;

    ctx.save();
    ctx.lineWidth = LINE_W;

    // ── CARGO / RECORD banner (top corners hidden above the screen edge) ──
    ctx.fillStyle   = '#ffffff';
    ctx.strokeStyle = BORDER;
    this._rr(ctx, 8, -20, 434, 64, 18);
    ctx.fill();
    ctx.stroke();

    // ── Pause badge — own rounded square at the banner's left end ──
    const pb = this.game.pauseButton;
    this._rr(ctx, pb.x, -16, pb.width, 64, 14);
    ctx.fill();
    ctx.stroke();
    // "||" bars
    ctx.fillStyle = NAVY;
    const pcx = pb.x + pb.width / 2;
    ctx.fillRect(pcx - 11, 15, 7, 18);
    ctx.fillRect(pcx +  4, 15, 7, 18);

    // ── Counters ──
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'left';
    ctx.fillStyle    = NAVY;
    ctx.font         = '800 24px system-ui, sans-serif';
    ctx.fillText('CARGO:',  78,  24);
    ctx.fillText(String(score.current), 190, 24);
    ctx.fillText('RECORD:', 252, 24);
    ctx.fillText(String(score.high),    378, 24);

    // ── Fast-forward badge (">>") top-right — inverted while active ──
    const fb   = this.game.fastButton;
    const fast = this.game.fastMode;
    ctx.fillStyle   = fast ? NAVY : '#ffffff';
    ctx.strokeStyle = BORDER;
    this._rr(ctx, fb.x, -18, fb.width, 64, 14);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = fast ? '#ffffff' : NAVY;
    const fcy = 23;
    for (const fcx of [fb.x + 20, fb.x + 36]) {
      ctx.beginPath();
      ctx.moveTo(fcx - 6, fcy - 10);
      ctx.lineTo(fcx + 7, fcy);
      ctx.lineTo(fcx - 6, fcy + 10);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  renderCollisionWarnings(ctx) {
    const warnings = this.game.warningPairs;
    if (!warnings || warnings.length === 0) return;

    const now = performance.now() / 1000;
    const seen = new Set();

    ctx.save();
    for (const [a, b] of warnings) {
      for (const boat of [a, b]) {
        if (seen.has(boat)) continue;
        seen.add(boat);

        // Pulse radius at 3 Hz between 1.0× and 1.3×.
        const pulse = 1 + 0.15 * Math.sin(now * Math.PI * 6);
        const r = (boat.radius + 15) * pulse;

        ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(boat.x, boat.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Rounded-rect path (clamped radius), matching Game._roundRectPath. */
  _rr(ctx, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
