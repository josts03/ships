/**
 * SoundManager
 * ------------
 * Plays game sounds via Web Audio API synthesis (no mp3 assets required).
 * If mp3 files are later added under assets/sounds/, swap the matching
 * synthesis method for an Audio element load — the play() API stays the same.
 *
 * Sounds:
 *   plink  – cargo block unloaded  (short, high→low sine)
 *   horn   – close-call warning     (foghorn bleat, throttled externally)
 *   crash  – boat collision          (thud + noise burst)
 *   ambient/music – no-op stubs until mp3 files exist
 */
export class SoundManager {
  constructor() {
    this._ctx      = null;   // AudioContext, created lazily after first user gesture
    this.muted     = false;
    this._loopStarted = false;
  }

  /** Called once on game start — resume context and optionally start loops. */
  async load() {}

  /**
   * Start looping ambient / music tracks.
   * This must be called after a user gesture (browser autoplay policy).
   * Falls back silently if files are absent or AudioContext is unavailable.
   */
  startLoops() {
    if (this._loopStarted) return;
    this._loopStarted = true;
    this._tryLoadLoop('ambient', 0.30);
    this._tryLoadLoop('music',   0.40);
  }

  play(key) {
    if (this.muted) return;
    switch (key) {
      case 'plink': this._plink(); break;
      case 'horn':  this._horn();  break;
      case 'crash': this._crash(); break;
    }
  }

  stop(_key) {}

  setMuted(muted) {
    this.muted = muted;
  }

  // --- Loop loader (mp3 if present, silent otherwise) ---

  _tryLoadLoop(name, volume) {
    try {
      const audio = new Audio(`assets/sounds/${name}.mp3`);
      audio.loop   = true;
      audio.volume = volume;
      // play() returns a Promise; silence AbortError / NotAllowedError
      audio.play().catch(() => {});
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

  // --- Synthesis ---

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
