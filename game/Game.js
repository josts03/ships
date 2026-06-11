/**
 * Game
 * ----
 * Owns the game loop and the top-level state machine.
 * Phase 1: LOADING + MENU.
 * Phase 2: PLAYING drives Spawner (boats appear, cross the harbor, exit).
 */
import { Canvas } from './Canvas.js';
import { AssetLoader } from './AssetLoader.js';
import { GameMap } from './Map.js';
import { SoundManager } from './SoundManager.js';
import { Score } from './Score.js';
import { UI } from './UI.js';
import { Spawner } from './Spawner.js';
import { PathDrawing } from './PathDrawing.js';
import { Collision } from './Collision.js';
import { DebugOverlay } from './DebugOverlay.js';
import { BOAT_STATES } from './Boat.js';
import { DOCK_APPROACH_RADIUS } from './Dock.js';
import { Vortex } from './Vortex.js';

// --- Game constants ---
export const CANVAS_WIDTH  = 1024;
export const CANVAS_HEIGHT = 768;

// Background image native size — used to scale image-space coordinates.
export const IMAGE_W = 2400;
export const IMAGE_H = 1792;
export const IMG_SCALE_X = CANVAS_WIDTH  / IMAGE_W;  // ≈ 0.4267
export const IMG_SCALE_Y = CANVAS_HEIGHT / IMAGE_H;  // ≈ 0.4286

// Only two cargo colors, matching the two dock colors.
export const DOCK_COLORS = ['#FFD700', '#8B5CF6'];   // yellow, purple

export const BOAT_SPEEDS = { small: 120, medium: 80, large: 50 }; // px / second
// Global unload pace (ms per cargo block) — defined in Dock.js, the single
// source of truth used by every dock; re-exported here for discoverability.
export { UNLOAD_INTERVAL_MS } from './Dock.js';
export const CARGO_COUNTS = { small: 1, medium: 2, large: 4 };
export const VORTEX_DURATION = 15000; // ms — vortex stays active for 15 seconds
// Boat-to-boat collision now uses per-boat ellipse half-dimensions (hw/hh),
// set on each Boat from its measured sprite size — see Boat.js / Collision.js.

export const GAME_STATES = {
  LOADING: 'LOADING',
  MENU: 'MENU',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  GAMEOVER: 'GAMEOVER',
};

export class Game {
  constructor(canvasElement) {
    this.canvas = new Canvas(canvasElement, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.ctx = this.canvas.ctx;

    this.assets = new AssetLoader();
    this.sound = new SoundManager();
    this.score = new Score();

    // Map is built once assets are loaded (LOADING -> MENU).
    this.map = null;

    // Systems wired in now for Phase 2 (held as references, not yet driven).
    this.ui = new UI(this);
    this.spawner = new Spawner(this);
    this.pathInput = new PathDrawing(this);
    this.collision = new Collision();
    this.debug = new DebugOverlay(this);

    this.state = GAME_STATES.LOADING;
    this.lastTime = 0;
    this._raf = null;

    // Warning pairs from last collision check (read by UI.js).
    this.warningPairs = [];
    // Horn throttle: seconds until next horn is allowed.
    this._hornCooldown = 0;

    // Vortex spawning: first at score 70 (difficulty tier 5), then every 25.
    this._nextVortexAt = 16;

    // Game-over animation state.
    this.impactBurst  = null;  // { x, y, elapsed } — expanding ring on collision
    this.gameOverSlide = 0;    // 0→1, clipboard card slide-in progress
    this._goTryAgainBtn = null;
    this._goMenuBtn     = null;

    // Menu "Play" button, in logical coordinates.
    this.playButton = {
      x: CANVAS_WIDTH / 2 - 150,
      y: 470,
      width: 300,
      height: 96,
    };

    // Pause button (top-right of HUD) + pause-menu buttons (set when drawn).
    this.pauseButton  = { x: CANVAS_WIDTH - 44, y: 6, width: 32, height: 32 };
    this._resumeBtn   = null;
    this._quitBtn     = null;

    this._loop = this._loop.bind(this);
    this._bindInput();
  }

  /** Boot: start the render loop, then load assets and advance to MENU. */
  async start() {
    this._raf = requestAnimationFrame(this._loop);
    try {
      await this.assets.loadAll();
    } catch (err) {
      console.error('[Game] asset loading error', err);
    }
    this.map = new GameMap(this.assets, CANVAS_WIDTH, CANVAS_HEIGHT);
    this._computeDockInwardAngles();
    this.setState(GAME_STATES.MENU);
  }

  /**
   * Assign each dock its exact "inward" heading (bow direction when parked).
   * Hardcoded clean angles (multiples of π/8) matched to the visual berth
   * orientation on the map — the auto-derived landmass angles were off by a
   * few degrees and left parked ships looking crooked.
   */
  _computeDockInwardAngles() {
    if (!this.map) return;
    const DEG = Math.PI / 180;
    const EXACT_ANGLES = {
      1: -97.5 * DEG,   // north shore pier (tilted ~7.5° off vertical)
      2: -97.5 * DEG,   // north shore pier
      3:  67.5 * DEG,   // south-east pier
      4:  67.5 * DEG,   // south-east pier
      5: -28.0 * DEG,   // island west berth
      6: 147.0 * DEG,   // island east berth
    };
    for (const dock of this.map.docks) {
      dock.inwardAngle = EXACT_ANGLES[dock.id] ?? null;
    }
  }

  /** Freeze gameplay (no reset). Cancels any in-progress path drawing. */
  pause() {
    if (this.state !== GAME_STATES.PLAYING) return;
    this.pathInput.cancel(this.pathInput.activePointerId);
    this.state = GAME_STATES.PAUSED;
  }

  /** Resume from pause WITHOUT resetting score/boats/docks. */
  resume() {
    if (this.state !== GAME_STATES.PAUSED) return;
    this.state = GAME_STATES.PLAYING;
  }

  setState(state) {
    if (state === GAME_STATES.PLAYING) {
      this.sound.startLoops();   // safe to call multiple times — guards internally
      this.spawner.reset();
      this.score.reset();
      // Release every berth — a game over can strand a dock as "occupied" by a
      // boat that no longer exists, permanently refusing ships next round.
      if (this.map) {
        for (const dock of this.map.docks) {
          dock.occupied      = false;
          dock.unloadingBoat = null;
          dock.unloadTimer   = 0;
          dock.flashTimer    = 0;
          dock.snapHighlight = false;
        }
      }
      this.warningPairs    = [];
      this._hornCooldown   = 0;
      this.impactBurst     = null;
      this.gameOverSlide   = 0;
      this._goTryAgainBtn  = null;
      this._goMenuBtn      = null;
      this._nextVortexAt   = 16;
    }
    this.state = state;
  }

  // --- Input ---
  _bindInput() {
    const el = this.canvas.canvas;

    // Keyboard: D toggles debug overlay; Esc / P toggles pause.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'd' || e.key === 'D') this.debug.toggle();
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
        if (this.state === GAME_STATES.PLAYING) this.pause();
        else if (this.state === GAME_STATES.PAUSED) this.resume();
      }
    });

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const { x, y } = this.canvas.toGameCoords(e.clientX, e.clientY);
      this._handlePointerDown(x, y, e.pointerId, el, e.timeStamp);
    }, { passive: false });

    el.addEventListener('pointermove', (e) => {
      e.preventDefault();
      const { x, y } = this.canvas.toGameCoords(e.clientX, e.clientY);
      if (this.state === GAME_STATES.PLAYING) {
        this.pathInput.onPointerMove(x, y, e.pointerId);
      }
    }, { passive: false });

    el.addEventListener('pointerup', (e) => {
      e.preventDefault();
      const { x, y } = this.canvas.toGameCoords(e.clientX, e.clientY);
      if (this.state === GAME_STATES.PLAYING) {
        this.pathInput.onPointerUp(x, y, e.pointerId);
      }
    }, { passive: false });

    el.addEventListener('pointercancel', (e) => {
      if (this.state === GAME_STATES.PLAYING) {
        this.pathInput.cancel(e.pointerId);
      }
    });
  }

  _handlePointerDown(x, y, pointerId, el, timestamp = Date.now()) {
    // Triple-tap always active — regardless of game state.
    this.debug.onTap(timestamp);

    switch (this.state) {
      case GAME_STATES.MENU:
        if (this._inRect(x, y, this.playButton)) {
          this.setState(GAME_STATES.PLAYING);
        }
        break;
      case GAME_STATES.PLAYING: {
        // Pause button takes priority over path drawing.
        if (this._inRect(x, y, this.pauseButton)) {
          this.pause();
          break;
        }
        const captured = this.pathInput.onPointerDown(x, y, pointerId);
        if (captured) {
          el.setPointerCapture(pointerId);
          this.sound.play('shipSelected');   // ship touched/selected audio hook
        }
        break;
      }
      case GAME_STATES.PAUSED:
        if (this._resumeBtn && this._inRect(x, y, this._resumeBtn)) {
          this.resume();
        } else if (this._quitBtn && this._inRect(x, y, this._quitBtn)) {
          this.setState(GAME_STATES.MENU);
        }
        break;
      case GAME_STATES.GAMEOVER:
        if (this._goTryAgainBtn && this._inRect(x, y, this._goTryAgainBtn)) {
          this.setState(GAME_STATES.PLAYING);
        } else if (this._goMenuBtn && this._inRect(x, y, this._goMenuBtn)) {
          this.setState(GAME_STATES.MENU);
        }
        break;
      default:
        break;
    }
  }

  /** Return the larger of two ship types ('small' < 'medium' < 'large'). */
  _largerType(a, b) {
    const rank = { small: 1, medium: 2, large: 3 };
    return (rank[b] ?? 0) > (rank[a] ?? 0) ? b : a;
  }

  _inRect(x, y, r) {
    return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
  }

  // --- Loop ---
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    const dt = this.lastTime ? Math.min((now - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = now;
    this.update(dt);
    this.render();
  }

  update(dt) {
    if (this.state === GAME_STATES.PLAYING) {
      this.spawner.update(dt);

      for (const boat of this.spawner.boats) {
        if (!boat.alive) continue;
        // Skip docking/land checks for boats parked or maneuvering at a berth.
        if (boat.state === BOAT_STATES.UNLOADING || boat.state === BOAT_STATES.SUNK ||
            boat.state === BOAT_STATES.DOCKING   || boat.state === BOAT_STATES.WAITING_EXIT) continue;
        if (boat.spinState) continue;  // vortex-stunned — skip docking + land checks

        if (boat.state === BOAT_STATES.SAILING) {
          this._checkDocking(boat);
          if (!boat.alive || boat.state === BOAT_STATES.DOCKING) continue;
        }

        // Land collision — 3-point pixel check: center, front, rear of boat.
        const landPt = this._firstLandPoint(boat);
        if (landPt) {
          const [nx, ny] = this.map.getLandNormal(landPt[0], landPt[1]);
          boat.angle = this._reflectAngle(boat.angle, nx, ny);
          boat.clearPath();
          boat.x += nx * 8;
          boat.y += ny * 8;
        }
      }

      // Boat-to-boat collision check.
      const { collided, warnings } = this.collision.checkBoatBoat(this.spawner.boats);
      this.warningPairs = warnings;

      if (collided) {
        this._triggerCollision(collided[0], collided[1]);
        return;
      }

      // Horn for close calls (throttled). Use the LARGER ship's horn.
      if (this._hornCooldown > 0) this._hornCooldown -= dt;
      if (warnings.length > 0 && this._hornCooldown <= 0) {
        const [a, b] = warnings[0];
        this.sound.playHorn(this._largerType(a.type, b.type));
        this._hornCooldown = 2.0;
      }

      // Tick dock unload timers — one block per UNLOAD_INTERVAL_MS, at every
      // dock equally (the pace is enforced inside Dock.update).
      for (const dock of this.map.docks) {
        dock.update(
          dt,
          () => {
            this.sound.play('cargoUnloaded');
            this.score.add(1);
            this._checkVortexSpawn();
          },
          () => this.sound.play('shipEmpty'),
        );
      }

      // Update vortices. A ship caught by an active vortex has its path erased,
      // spins briefly, then drifts helplessly (no game over).
      for (const v of this.spawner.vortices) v.update(dt);
      this.spawner.vortices = this.spawner.vortices.filter((v) => v.active);
      for (const v of this.spawner.vortices) {
        for (const boat of this.spawner.boats) v.affectBoat(boat);
      }

    } else if (this.state === GAME_STATES.GAMEOVER) {
      // Advance impact burst, then slide in the clipboard card.
      if (this.impactBurst) {
        this.impactBurst.elapsed += dt;
        if (this.impactBurst.elapsed >= 0.5) this.impactBurst = null;
      } else {
        this.gameOverSlide = Math.min(1, this.gameOverSlide + dt / 0.4);
      }
    }
  }

  _triggerCollision(a, b) {
    this.sound.play('crash');
    this.impactBurst  = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, elapsed: 0 };
    this.gameOverSlide = 0;
    this.warningPairs  = [];

    // Freeze all mobile boats.
    for (const boat of this.spawner.boats) {
      if (boat.state !== BOAT_STATES.UNLOADING) boat.state = BOAT_STATES.SUNK;
    }

    // Go directly to GAMEOVER without resetting score/spawner.
    this.state = GAME_STATES.GAMEOVER;
  }

  _checkDocking(boat) {
    // Dock at ANY non-occupied dock whose color the boat still carries (so a
    // mixed-cargo ship can be routed to either of its colors, in any order).
    for (const dock of this.map.docks) {
      if (dock.occupied) continue;
      if (boat.cargoForColor(dock.color) <= 0) continue;

      const dist = Math.hypot(boat.x - dock.center.x, boat.y - dock.center.y);
      if (dist > DOCK_APPROACH_RADIUS) continue;

      // Only "catch" the ship (disabling land collisions) once a HULL-WIDTH
      // corridor to the berth is clear of land/breakwaters — otherwise it must
      // keep SAILING and physically route in itself.
      if (!this._clearLineToDock(boat.x, boat.y, dock, boat.hh)) continue;

      dock.beginDocking(boat);   // reserve + final alignment (no teleport)
      return;
    }
  }

  /**
   * True if a corridor as wide as the ship's hull, from (x,y) to the dock
   * center, is free of land — so no part of the hull would clip a barrier when
   * pulled in. `halfWidth` is the hull's half-beam. Land within OPENING of the
   * center (the berth itself) is ignored.
   */
  _clearLineToDock(x, y, dock, halfWidth = 0) {
    const OPENING = 15;           // px around the berth that is the dock itself
    const cx = dock.center.x, cy = dock.center.y;
    const dx = cx - x, dy = cy - y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return true;
    const ux = dx / dist, uy = dy / dist;     // along the corridor
    const ox = -uy,       oy = ux;            // perpendicular (hull width)
    const offsets = halfWidth > 0 ? [-halfWidth, -halfWidth * 0.5, 0, halfWidth * 0.5, halfWidth] : [0];
    const n = Math.max(1, Math.ceil(dist / 3));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const bx = x + dx * t, by = y + dy * t;
      if (Math.hypot(bx - cx, by - cy) < OPENING) continue;  // skip the berth
      for (const o of offsets) {
        if (this.map.isLand(bx + ox * o, by + oy * o)) return false;
      }
    }
    return true;
  }

  render() {
    const ctx = this.ctx;
    this.canvas.clear('#000');

    switch (this.state) {
      case GAME_STATES.LOADING:
        this._renderLoading(ctx);
        break;
      case GAME_STATES.MENU:
        this._renderMenu(ctx);
        break;
      case GAME_STATES.PLAYING:
        this._renderPlaying(ctx);
        break;
      case GAME_STATES.PAUSED:
        this._renderPlaying(ctx);   // frozen scene beneath the overlay
        this._renderPauseMenu(ctx);
        break;
      case GAME_STATES.GAMEOVER:
        this._renderGameOver(ctx);
        break;
      default:
        break;
    }
  }

  _renderLoading(ctx) {
    const cx = CANVAS_WIDTH / 2;
    const cy = CANVAS_HEIGHT / 2;

    ctx.fillStyle = '#0a2433';
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 36px system-ui, sans-serif';
    ctx.fillText('Loading…', cx, cy - 40);

    // Progress bar
    const barW = 360;
    const barH = 16;
    const barX = cx - barW / 2;
    const barY = cy + 4;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.fillStyle = '#5ec6ff';
    ctx.fillRect(barX, barY, barW * this.assets.progress, barH);

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText(
      `${Math.round(this.assets.progress * 100)}%`,
      cx,
      barY + barH + 22
    );
  }

  _renderMenu(ctx) {
    if (this.map) this.map.render(ctx);

    // Animated water shimmer bands over the map.
    this._renderWaterShimmer(ctx);

    // Nautical vignette — darker at edges, clearer in the center.
    const vgGrad = ctx.createRadialGradient(
      CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 160,
      CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2, 640
    );
    vgGrad.addColorStop(0, 'rgba(4,18,28,0.30)');
    vgGrad.addColorStop(1, 'rgba(4,18,28,0.72)');
    ctx.fillStyle = vgGrad;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    const cx = CANVAS_WIDTH / 2;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Title shadow for depth
    ctx.save();
    ctx.shadowBlur  = 24;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.fillStyle = '#ffffff';
    ctx.font      = '800 72px system-ui, sans-serif';
    ctx.fillText('HARBOR MASTER', cx, 210);
    ctx.restore();

    // Subtitle
    ctx.fillStyle = 'rgba(180, 225, 255, 0.9)';
    ctx.font      = '600 26px system-ui, sans-serif';
    ctx.fillText('Treasure Island', cx, 272);

    // Thin decorative rule
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 180, 302); ctx.lineTo(cx + 180, 302);
    ctx.stroke();
    ctx.restore();

    // Best score badge
    if (this.score.high > 0) {
      ctx.fillStyle = 'rgba(255, 225, 80, 0.95)';
      ctx.font      = '700 22px system-ui, sans-serif';
      ctx.fillText(`BEST: ${this.score.high}`, cx, 328);
    }

    // Play button
    this._renderButton(ctx, this.playButton, 'TAP TO PLAY');

    // Debug overlay (topmost).
    this.debug.render(ctx);
  }

  /** Subtle animated light-bands over the water surface. */
  _renderWaterShimmer(ctx) {
    const t = performance.now() / 1000;
    ctx.save();
    for (let i = 0; i < 6; i++) {
      const yBase = 140 + i * 108;
      const wave  = Math.sin(t * 0.65 + i * 1.15) * 14;
      const alpha = 0.055 + 0.025 * Math.sin(t * 1.2 + i * 0.8);
      ctx.fillStyle = `rgba(70, 160, 230, ${alpha})`;
      ctx.fillRect(0, yBase + wave, CANVAS_WIDTH, 26);
    }
    ctx.restore();
  }

  _renderButton(ctx, r, label) {
    ctx.save();
    ctx.fillStyle = '#1f9d55';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    this._roundRectPath(ctx, r.x, r.y, r.width, r.height, 16);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 32px system-ui, sans-serif';
    ctx.fillText(label, r.x + r.width / 2, r.y + r.height / 2 + 1);
    ctx.restore();
  }

  _roundRectPath(ctx, x, y, w, h, radius) {
    const rr = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  _renderPlaying(ctx) {
    if (!this.map) return;
    // 1. Background + dock markers.
    this.map.render(ctx);
    // 2. Vortices (dynamic sea element — below the boats).
    for (const v of this.spawner.vortices) v.render(ctx, this.assets);
    // 3. Active boats (hull + dynamic cargo).
    for (const boat of this.spawner.boats) boat.render(ctx, this.assets);
    // 4. Drawn paths — MUST stay after the boat loop so the white player line
    //    renders ON TOP of every ship hull, visibly crossing the deck.
    this.pathInput.render(ctx);
    // 5. Incoming-boat warning arrows (UI layer).
    this.spawner.renderArrows(ctx);
    // 6. HUD always on top.
    this.ui.render(ctx);
    // 6b. Pause button in the HUD.
    this._renderPauseButton(ctx);
    // 7. Debug overlay (topmost — shows only when enabled).
    this.debug.render(ctx);
  }

  /** Draw the small "||" pause button in the top-right of the HUD. */
  _renderPauseButton(ctx) {
    const b = this.pauseButton;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    this._roundRectPath(ctx, b.x, b.y, b.width, b.height, 6);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    const barW = 5, gap = 6, h = 16;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    ctx.fillRect(cx - gap, cy - h / 2, barW, h);
    ctx.fillRect(cx + gap - barW, cy - h / 2, barW, h);
    ctx.restore();
  }

  /** Dim overlay + Resume / Quit buttons shown while PAUSED. */
  _renderPauseMenu(ctx) {
    const CW = CANVAS_WIDTH, CH = CANVAS_HEIGHT;
    ctx.save();
    ctx.fillStyle = 'rgba(4,18,28,0.72)';
    ctx.fillRect(0, 0, CW, CH);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 56px system-ui, sans-serif';
    ctx.fillText('PAUSED', CW / 2, CH / 2 - 120);

    const bw = 280, bh = 70, gap = 26;
    const x = CW / 2 - bw / 2;
    const yResume = CH / 2 - 20;
    const yQuit   = yResume + bh + gap;
    this._resumeBtn = { x, y: yResume, width: bw, height: bh };
    this._quitBtn   = { x, y: yQuit,   width: bw, height: bh };

    const drawBtn = (b, label, fill) => {
      ctx.fillStyle = fill;
      this._roundRectPath(ctx, b.x, b.y, b.width, b.height, 12);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 26px system-ui, sans-serif';
      ctx.fillText(label, b.x + b.width / 2, b.y + b.height / 2);
    };
    drawBtn(this._resumeBtn, 'Resume',           '#2f9e44');
    drawBtn(this._quitBtn,   'Quit to Main Menu', 'rgba(255,255,255,0.18)');

    ctx.restore();
  }

  _renderGameOver(ctx) {
    const CW = CANVAS_WIDTH, CH = CANVAS_HEIGHT;

    // Frozen harbor in the background.
    if (this.map) this.map.render(ctx);
    for (const boat of this.spawner.boats) boat.render(ctx, this.assets);

    // Impact burst: expanding ring + inner flash.
    if (this.impactBurst) this._renderImpactBurst(ctx);

    // Darkening overlay grows with the slide.
    const alpha = 0.15 + Math.min(0.55, this.gameOverSlide * 0.7);
    ctx.fillStyle = `rgba(4, 18, 28, ${alpha})`;
    ctx.fillRect(0, 0, CW, CH);

    // Clipboard card.
    if (this.gameOverSlide > 0) this._renderClipboard(ctx);

    // Debug overlay (topmost).
    this.debug.render(ctx);
  }

  _renderImpactBurst(ctx) {
    const { x, y, elapsed } = this.impactBurst;
    const t = elapsed / 0.5;  // 0→1

    ctx.save();

    // Outer expanding ring.
    const r = t * 130;
    ctx.strokeStyle = `rgba(255, 90, 0, ${(1 - t) * 0.9})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
    ctx.stroke();

    // Inner bright flash (fades in first half).
    const innerAlpha = Math.max(0, 1 - t * 2) * 0.6;
    if (innerAlpha > 0) {
      ctx.fillStyle = `rgba(255, 230, 80, ${innerAlpha})`;
      ctx.beginPath();
      ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  _renderClipboard(ctx) {
    const CW = CANVAS_WIDTH, CH = CANVAS_HEIGHT;
    const cardW = 600, cardH = 340;
    const cardX = (CW - cardW) / 2;

    // Cubic ease-out slide from off-top to center.
    const ease   = 1 - Math.pow(1 - this.gameOverSlide, 3);
    const cardY  = -cardH + ease * ((CH - cardH) / 2 + cardH);

    ctx.save();

    // Drop shadow.
    ctx.shadowBlur  = 32;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';

    // Card body — cream paper.
    ctx.fillStyle = '#f5eed8';
    this._roundRectPath(ctx, cardX, cardY, cardW, cardH, 18);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Clipboard metal clip.
    const clipW = 84, clipH = 30;
    const clipX = CW / 2 - clipW / 2, clipY = cardY - 14;
    ctx.fillStyle = '#4a4a4a';
    this._roundRectPath(ctx, clipX, clipY, clipW, clipH, 9);
    ctx.fill();
    // Clip hole.
    ctx.fillStyle = '#888';
    ctx.beginPath();
    ctx.arc(CW / 2, clipY + clipH / 2, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ccc';
    ctx.beginPath();
    ctx.arc(CW / 2, clipY + clipH / 2, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Fade in text + buttons after card is mostly visible.
    if (this.gameOverSlide < 0.55) return;
    const textAlpha = Math.min(1, (this.gameOverSlide - 0.55) / 0.35);

    ctx.save();
    ctx.globalAlpha = textAlpha;
    ctx.textAlign   = 'center';

    // "Nice Job!" headline.
    ctx.fillStyle    = '#1e3a2e';
    ctx.font         = '800 50px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('Nice Job!', CW / 2, cardY + 30);

    // Cargo summary.
    const units = this.score.current;
    ctx.fillStyle = '#4a4a4a';
    ctx.font      = '400 21px system-ui, sans-serif';
    ctx.fillText(
      `You safely received ${units} cargo unit${units !== 1 ? 's' : ''} this shift.`,
      CW / 2, cardY + 100
    );

    // Thin horizontal rule.
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 44, cardY + 152);
    ctx.lineTo(cardX + cardW - 44, cardY + 152);
    ctx.stroke();

    // Buttons.
    const btnY = cardY + 170;
    const tryBtn  = { x: CW / 2 - 238, y: btnY, width: 206, height: 62 };
    const menuBtn = { x: CW / 2 +  32, y: btnY, width: 206, height: 62 };

    // Store for hit-testing (in real canvas coords, not shifted).
    this._goTryAgainBtn = tryBtn;
    this._goMenuBtn     = menuBtn;

    // Try Again — green.
    ctx.fillStyle   = '#1f9d55';
    ctx.strokeStyle = 'transparent';
    this._roundRectPath(ctx, tryBtn.x, tryBtn.y, tryBtn.width, tryBtn.height, 12);
    ctx.fill();
    ctx.fillStyle    = '#ffffff';
    ctx.font         = '700 26px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Try Again', tryBtn.x + tryBtn.width / 2, tryBtn.y + tryBtn.height / 2);

    // Menu — outlined.
    ctx.fillStyle   = 'rgba(0,0,0,0)';
    ctx.strokeStyle = '#1e3a2e';
    ctx.lineWidth   = 2.5;
    this._roundRectPath(ctx, menuBtn.x, menuBtn.y, menuBtn.width, menuBtn.height, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#1e3a2e';
    ctx.fillText('Menu', menuBtn.x + menuBtn.width / 2, menuBtn.y + menuBtn.height / 2);

    ctx.restore();
  }

  // --- Vortex helpers ---

  _checkVortexSpawn() {
    // Vortices appear once score > 15, then roughly every 20 cargo after that.
    if (this.score.current < this._nextVortexAt) return;
    this._spawnVortex();
    this._nextVortexAt = this.score.current + 20;
  }

  _spawnVortex() {
    const pos = this._randomOpenWaterPos();
    if (pos) this.spawner.vortices.push(new Vortex(pos));
  }

  /**
   * Pick a random open-water position for a vortex.
   * Restricted to two valid zones (canvas-space, derived from image 2400×1792):
   *   Zone 1: x 85–235,  y 171–557  (left open water)
   *   Zone 2: x 597–939, y 171–557  (right open water)
   * Falls back to null after 20 failed attempts.
   */
  _randomOpenWaterPos() {
    // Sample random points within the canvas and accept only open water that
    // is > 150px from every dock and > 80px from any land pixel.
    const margin = 80;
    for (let i = 0; i < 40; i++) {
      const x = margin + Math.random() * (CANVAS_WIDTH  - margin * 2);
      const y = margin + Math.random() * (CANVAS_HEIGHT - margin * 2);
      if (this.map.docks.some((d) => Math.hypot(x - d.center.x, y - d.center.y) < 150)) continue;
      if (!this._landClearance(x, y, 80)) continue;
      return { x, y };
    }
    return null;
  }

  /** True if no land lies within `r` px of (x, y) — sampled rings + center. */
  _landClearance(x, y, r) {
    if (this.map.isLand(x, y)) return false;
    for (const R of [r * 0.5, r]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        if (this.map.isLand(x + Math.cos(a) * R, y + Math.sin(a) * R)) return false;
      }
    }
    return true;
  }

  // --- Land collision helpers ---

  /**
   * Return the first of the boat's 3 probe points (front, center, rear) that
   * sits on land, or null if the boat is clear.
   * @param {Boat} boat
   * @returns {[number,number]|null}  canvas-space [x, y] of the hit point
   */
  _firstLandPoint(boat) {
    const { x, y, angle, radius } = boat;

    // Skip land collision near a matching dock ONLY when the ship has a clear
    // line to it — so it can sail cleanly into a coast/island berth, but still
    // bounces off a breakwater that's between it and the dock.
    for (const dock of this.map.docks) {
      if (boat.cargoForColor(dock.color) <= 0) continue;
      const dist = Math.hypot(x - dock.center.x, y - dock.center.y);
      if (dist < 90 && this._clearLineToDock(x, y, dock, boat.hh)) return null;
    }

    const cos = Math.cos(angle), sin = Math.sin(angle);
    const r08 = radius * 0.8;
    const points = [
      [x, y],
      [x + cos * r08, y + sin * r08],
      [x - cos * r08, y - sin * r08],
    ];
    for (const pt of points) {
      if (this.map.isLand(pt[0], pt[1])) return pt;
    }
    return null;
  }

  /**
   * Reflect a heading angle off a surface with outward normal [nx, ny].
   * Uses V' = V - 2(V·N)N where V = (cos a, sin a).
   */
  _reflectAngle(angle, nx, ny) {
    const vx = Math.cos(angle), vy = Math.sin(angle);
    const dot = vx * nx + vy * ny;
    const rx = vx - 2 * dot * nx;
    const ry = vy - 2 * dot * ny;
    return Math.atan2(ry, rx);
  }
}
