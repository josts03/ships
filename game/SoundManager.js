/**
 * SoundManager
 * ------------
 * Central audio hub. Every game event maps to ONE entry in AUDIO_FILES below.
 * If a file is missing (the original extracted audio hasn't been dropped in
 * yet) the matching Web-Audio synthesis fallback plays instead, so the game
 * stays audible either way — the play() API never changes.
 *
 * Events:
 *   music / ambient – looping background tracks (started by startLoops)
 *   shipSelected    – ship touched / selected (pointerdown on a hull)
 *   cargoUnloaded   – one cargo block removed at a dock ('plink' is an alias)
 *   shipEmpty       – ship fully empty, ready to turn around
 *   horn            – close-call warning (per-size mp3s, throttled externally)
 *   crash           – boat-boat collision
 */
import smallHornUrl  from '../assets/sounds/small-horn.mp3';
import mediumHornUrl from '../assets/sounds/medium-horn.mp3';
import largeHornUrl  from '../assets/sounds/large-horn.mp3';

// ── ORIGINAL-AUDIO HOOKS ────────────────────────────────────────────────────
// Drop the extracted original files into assets/sounds/ under these names and
// they are picked up automatically in dev. For production builds, import each
// file like the horn mp3s above (Vite only bundles imported assets) and swap
// the path string here for the imported URL — nothing else needs to change.
export const AUDIO_FILES = {
  music:         'assets/sounds/music.mp3',          // background music (looping)
  ambient:       'assets/sounds/ambient.mp3',        // harbor ambience (looping)
  shipSelected:  'assets/sounds/ship-selected.mp3',  // ship touched / selected
  cargoUnloaded: 'assets/sounds/cargo-unloaded.mp3', // single cargo block unloaded
  shipEmpty:     'assets/sounds/ship-empty.mp3',     // ship fully empty (ready to turn)
  crash:         'assets/sounds/crash.mp3',          // boat-boat collision
};

const LOOP_VOLUME = { music: 0.40, ambient: 0.30 };

const ONE_SHOT_VOLUME = {
  shipSelected:  0.55,
  cargoUnloaded: 0.70,
  shipEmpty:     0.80,
  crash:         0.90,
};

// Per-size horn config. Large is the deep blast — loudest / highest priority.
const HORN_CONFIG = {
  small:  { url: smallHornUrl,  volume: 0.55, priority: 1 },
  medium: { url: mediumHornUrl, volume: 0.75, priority: 2 },
  large:  { url: largeHornUrl,  volume: 1.00, priority: 3 },
};

export class SoundManager {
  constructor() {
    this._ctx      = null;   // AudioContext, created lazily after first user gesture
    this.muted     = false;
    this._loopStarted = false;

    // Pre-create one HTMLAudio element per horn size so playback is instant.
    this._horns = {};
    for (const [size, cfg] of Object.entries(HORN_CONFIG)) {
      const a = new Audio(cfg.url);
      a.volume   = cfg.volume;
      a.preload  = 'auto';
      this._horns[size] = a;
    }
    // Tracks the size currently sounding so a bigger blast can override a
    // smaller one but not vice-versa (large takes channel priority).
    this._activeHornPriority = 0;

    // Pre-create one element per hooked one-shot so the browser has resolved
    // (or flagged missing) every file before the first play. Missing files
    // land in _missing and route to the synthesis fallback.
    this._missing  = new Set();
    this._oneShots = {};
    for (const key of ['shipSelected', 'cargoUnloaded', 'shipEmpty', 'crash']) {
      const a = new Audio(AUDIO_FILES[key]);
      a.preload = 'auto';
      a.volume  = ONE_SHOT_VOLUME[key] ?? 0.8;
      a.addEventListener('error', () => this._missing.add(key));
      this._oneShots[key] = a;
    }

    this._loops = {};   // looping tracks, keyed 'music' / 'ambient'
  }

  /** Called once on game start — resume context and optionally start loops. */
  async load() {}

  /**
   * Start looping ambient / music tracks.
   * This must be called after a user gesture (browser autoplay policy).
   * Falls back silently if files are absent or HTMLAudio is unavailable.
   */
  startLoops() {
    if (this._loopStarted) return;
    this._loopStarted = true;
    this._tryLoadLoop('ambient');
    this._tryLoadLoop('music');
  }

  play(key) {
    if (this.muted) return;
    switch (key) {
      case 'plink':                                    // legacy alias
      case 'cargoUnloaded':
        this._playFileOr('cargoUnloaded', () => this._plink());
        break;
      case 'shipSelected':
        this._playFileOr('shipSelected', () => this._selectTick());
        break;
      case 'shipEmpty':
        this._playFileOr('shipEmpty', () => this._readyChime());
        break;
      case 'horn':
        this.playHorn('medium');                       // back-compat default
        break;
      case 'crash':
        this._playFileOr('crash', () => this._crash());
        break;
    }
  }

  /**
   * Play the horn .mp3 for a given ship size ('small'|'medium'|'large').
   * A larger (higher-priority) horn can interrupt a smaller one that is still
   * playing, but a smaller horn won't cut off a larger blast in progress.
   */
  playHorn(size = 'medium') {
    if (this.muted) return;
    const cfg = HORN_CONFIG[size];
    const audio = this._horns[size];
    if (!cfg || !audio) return;

    // Channel priority: don't let a small honk stomp a deep blast.
    if (cfg.priority < this._activeHornPriority && !audio.paused) return;
    this._activeHornPriority = cfg.priority;

    try {
      audio.currentTime = 0;
      const p = audio.play();
      if (p) p.catch(() => {});
      audio.onended = () => { this._activeHornPriority = 0; };
    } catch { /* autoplay blocked / element busy — ignore */ }
  }

  stop(_key) {}

  setMuted(muted) {
    this.muted = muted;
    for (const a of Object.values(this._loops)) {
      if (muted) a.pause();
      else a.play().catch(() => {});
    }
  }

  // --- File-or-synthesis one-shot playback ---

  /** Play the hooked file for `key`; run the synth fallback if it can't play. */
  _playFileOr(key, fallback) {
    const audio = this._oneShots[key];
    if (!audio || this._missing.has(key)) { fallback?.(); return; }
    try {
      audio.currentTime = 0;
      const p = audio.play();
      // A 404'd file rejects play() with NotSupportedError — remember that and
      // fall back to synthesis from here on.
      if (p) p.catch((err) => {
        if (err?.name === 'NotSupportedError') this._missing.add(key);
        fallback?.();
      });
    } catch {
      fallback?.();
    }
  }

  // --- Loop loader (mp3 if present, silent otherwise) ---

  _tryLoadLoop(name) {
    try {
      const audio = new Audio(AUDIO_FILES[name]);
      audio.loop   = true;
      audio.volume = LOOP_VOLUME[name] ?? 0.35;
      this._loops[name] = audio;
      // play() returns a Promise; silence AbortError / NotAllowedError
      if (!this.muted) audio.play().catch(() => {});
    } catch {
      // HTMLAudio not available or file missing — silently skip
    }
  }

  // --- AudioContext lazy init ---

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
    return this._ctx;
  }

  // --- Synthesis fallbacks (used until the original mp3 files exist) ---

  _plink() {
    try {
      const ac = this._getCtx();
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      const t = ac.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046, t);
      osc.frequency.exponentialRampToValueAtTime(523, t + 0.12);
      gain.gain.setValueAtTime(0.35, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    } catch { /* AudioContext unavailable */ }
  }

  /** Soft rising tick — ship touched/selected. */
  _selectTick() {
    try {
      const ac = this._getCtx();
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      const t = ac.currentTime;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.exponentialRampToValueAtTime(880, t + 0.05);
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      osc.start(t); osc.stop(t + 0.09);
    } catch { /* AudioContext unavailable */ }
  }

  /** Rising two-note chime — ship fully empty, ready to turn. */
  _readyChime() {
    try {
      const ac = this._getCtx();
      const t  = ac.currentTime;
      for (const [offset, freq] of [[0, 523.25], [0.11, 783.99]]) {
        const osc = ac.createOscillator(), gain = ac.createGain();
        osc.connect(gain); gain.connect(ac.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t + offset);
        gain.gain.setValueAtTime(0.0001, t + offset);
        gain.gain.linearRampToValueAtTime(0.28, t + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.28);
        osc.start(t + offset); osc.stop(t + offset + 0.3);
      }
    } catch { /* AudioContext unavailable */ }
  }

  _horn() {
    try {
      const ac = this._getCtx();
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.connect(gain); gain.connect(ac.destination);
      const t = ac.currentTime;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(110, t);
      osc.frequency.setValueAtTime(98,  t + 0.12);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.06);
      gain.gain.setValueAtTime(0.22, t + 0.32);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      osc.start(t); osc.stop(t + 0.7);
    } catch { /* AudioContext unavailable */ }
  }

  _crash() {
    try {
      const ac = this._getCtx();
      const t  = ac.currentTime;

      // Low thud (descending pitch)
      const osc  = ac.createOscillator(), gOsc = ac.createGain();
      osc.connect(gOsc); gOsc.connect(ac.destination);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(18, t + 0.35);
      gOsc.gain.setValueAtTime(0.55, t);
      gOsc.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      osc.start(t); osc.stop(t + 0.4);

      // White-noise burst
      const sr     = ac.sampleRate;
      const frames = Math.ceil(sr * 0.22);
      const buf    = ac.createBuffer(1, frames, sr);
      const data   = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      const src   = ac.createBufferSource(), gNoise = ac.createGain();
      src.buffer  = buf;
      src.connect(gNoise); gNoise.connect(ac.destination);
      gNoise.gain.setValueAtTime(0.35, t);
      gNoise.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      src.start(t);
    } catch { /* AudioContext unavailable */ }
  }
}
