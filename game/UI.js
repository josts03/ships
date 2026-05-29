/**
 * UI
 * --
 * In-game HUD: score top bar and collision warning circles.
 * Menu / loading / game-over screens are drawn directly by Game.
 */
export class UI {
  constructor(game) {
    this.game = game;
  }

  render(ctx) {
    this.renderCollisionWarnings(ctx);
    this.renderTopBar(ctx);
  }

  renderTopBar(ctx) {
    const score = this.game.score;
    const W = 1024;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.52)';
    ctx.fillRect(0, 0, W, 44);

    ctx.textBaseline = 'middle';
    ctx.font = '700 22px system-ui, sans-serif';

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE: ${score.current}`, 18, 22);

    ctx.textAlign = 'right';
    ctx.fillStyle = score.current > 0 && score.current >= score.high
      ? '#ffe066'
      : 'rgba(255,255,255,0.7)';
    ctx.fillText(`RECORD: ${score.high}`, W - 18, 22);

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
}
