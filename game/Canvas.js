/**
 * Canvas
 * ------
 * Owns the <canvas> element and the 2D context. Keeps a fixed *logical*
 * coordinate system (the game always draws in logicalWidth x logicalHeight,
 * e.g. 1024x768) while the canvas is letterboxed to fit any window and
 * rendered at device-pixel resolution for crispness.
 *
 * Game code never worries about DPR or window size: it draws in logical units,
 * and converts pointer events back to logical units via toGameCoords().
 */
export class Canvas {
  constructor(canvasElement, logicalWidth, logicalHeight) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');

    this.width = logicalWidth;
    this.height = logicalHeight;

    this.dpr = window.devicePixelRatio || 1;
    this.displayWidth = logicalWidth; // CSS px the canvas occupies
    this.displayHeight = logicalHeight;
    this.scale = 1; // CSS px per logical unit

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);

    this.resize();
  }

  /** Recompute letterbox sizing + backing store. Safe to call any time. */
  resize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    this.dpr = window.devicePixelRatio || 1;

    // Fixed game aspect ratio (1024×768 = 4:3).
    const GAME_W = this.width;
    const GAME_H = this.height;

    // Uniform scale to fit window while preserving aspect ratio.
    const scaleX = vw / GAME_W;
    const scaleY = vh / GAME_H;
    const scale  = Math.min(scaleX, scaleY);

    // Game display size in CSS pixels.
    this.displayWidth  = Math.round(GAME_W * scale);
    this.displayHeight = Math.round(GAME_H * scale);

    // Center game canvas; gray bars fill the remaining space.
    this.offsetX = Math.round((vw - this.displayWidth)  / 2);
    this.offsetY = Math.round((vh - this.displayHeight) / 2);

    // Backing store at device pixel resolution.
    this.canvas.width  = Math.round(this.displayWidth  * this.dpr);
    this.canvas.height = Math.round(this.displayHeight * this.dpr);

    // CSS size and position.
    this.canvas.style.width    = this.displayWidth  + 'px';
    this.canvas.style.height   = this.displayHeight + 'px';
    this.canvas.style.position = 'absolute';
    this.canvas.style.left     = this.offsetX + 'px';
    this.canvas.style.top      = this.offsetY + 'px';

    // Scale transform: logical coords → device pixels.
    const sx = this.canvas.width  / GAME_W;
    const sy = this.canvas.height / GAME_H;
    this.ctx.setTransform(sx, 0, 0, sy, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';

    this.scale = scale;
  }

  /** Clear the whole backing store and paint it `color`. */
  clear(color = '#000') {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // identity = device pixels
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore(); // back to the logical transform
  }

  /**
   * Convert a clientX/clientY (from a mouse or touch event) into logical
   * game coordinates. Accounts for the letterbox offset and scaling.
   */
  toGameCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.width;
    const y = ((clientY - rect.top) / rect.height) * this.height;
    return { x, y };
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
  }
}
