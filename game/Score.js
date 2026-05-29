/**
 * Score
 * -----
 * Tracks the current run's score and persists the all-time high score in
 * localStorage. (Persistence is a utility, not gameplay — safe for Phase 1.)
 */
const STORAGE_KEY = 'harbor-master:highscore';

export class Score {
  constructor() {
    this.current = 0;
    this.high = this._loadHigh();
  }

  reset() {
    this.current = 0;
  }

  /** Add points; bumps + persists the high score when surpassed. */
  add(points) {
    this.current += points;
    if (this.current > this.high) {
      this.high = this.current;
      this._saveHigh();
    }
    return this.current;
  }

  _loadHigh() {
    try {
      return parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  _saveHigh() {
    try {
      localStorage.setItem(STORAGE_KEY, String(this.high));
    } catch {
      /* storage unavailable (private mode / quota) — ignore */
    }
  }
}
