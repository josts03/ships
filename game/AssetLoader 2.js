/**
 * AssetLoader
 * -----------
 * Loads every PNG sprite the game needs and resolves a promise once they are
 * all done. Assets are imported through Vite so they get hashed, bundled URLs
 * that work in both `vite dev` and `vite build`.
 *
 * Loading is resilient: a single failed image logs a warning and resolves as
 * null rather than rejecting, so a missing/renamed asset never hard-crashes
 * the boot sequence.
 */

// --- Asset URLs (Vite resolves these to real, bundled URLs) ---
// Ships use the EMPTY base hulls only; cargo is drawn dynamically as an
// overlay, so the pre-drawn *_cargo.png sprites are intentionally not loaded.
import smallEmpty from '../assets/boats/small_empty.png';
import mediumEmpty from '../assets/boats/medium_empty.png';
import largeEmpty from '../assets/boats/large_empty.png';
import backgroundUrl from '../assets/map/background.png';
import collisionMapUrl from '../assets/map/collision_map_v2.png';
import vortexUrl from '../assets/vortex/vortex.png';
import warningArrowUrl from '../assets/warning-arrow.png';

/** key -> bundled URL. The keys are what the rest of the game looks up. */
export const ASSET_MANIFEST = {
  small_empty:   smallEmpty,
  medium_empty:  mediumEmpty,
  large_empty:   largeEmpty,
  background:    backgroundUrl,
  collision_map: collisionMapUrl,
  vortex:        vortexUrl,
  warning_arrow: warningArrowUrl,
};

export class AssetLoader {
  constructor(manifest = ASSET_MANIFEST) {
    this.manifest = manifest;
    this.images = {}; // key -> HTMLImageElement | null
    this.total = 0;
    this.loaded = 0;
  }

  _loadImage(key, url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.images[key] = img;
        this.loaded++;
        resolve(img);
      };
      img.onerror = () => {
        console.warn(`[AssetLoader] failed to load "${key}" (${url})`);
        this.images[key] = null;
        this.loaded++;
        resolve(null);
      };
      img.src = url;
    });
  }

  /**
   * Load every asset in the manifest.
   * @param {(loaded:number, total:number)=>void} [onProgress]
   * @returns {Promise<Object>} the key -> image map
   */
  async loadAll(onProgress) {
    const entries = Object.entries(this.manifest);
    this.total = entries.length;
    this.loaded = 0;

    await Promise.all(
      entries.map(async ([key, url]) => {
        await this._loadImage(key, url);
        if (onProgress) onProgress(this.loaded, this.total);
      })
    );

    return this.images;
  }

  /** Look up a loaded image by key. Returns null if missing/failed. */
  get(key) {
    return this.images[key] ?? null;
  }

  get progress() {
    return this.total === 0 ? 0 : this.loaded / this.total;
  }
}
