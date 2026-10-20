/**
 * Content-Addressable Cache for Generated Images
 * Uses SHA-256 hash of prompt + style + aspect_ratio + reference images to deliver
 * instant (sub-10ms) responses and eliminate redundant token/API costs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_KEY_RE = /^[a-f0-9]{64}$/;
const IMAGE_FILE_RE = /^img_\d+_[a-f0-9]{8,32}\.(?:jpg|png|webp)$/i;
const MAX_INDEX_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 1000;

class ImageCache {
  constructor(storageDir) {
    this.storageDir = path.resolve(storageDir);
    this.indexPath = path.join(this.storageDir, '.cache_index.json');
    this.hits = 0;
    this.misses = 0;
    this.index = this._loadIndex();
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this.indexPath)) {
        const indexStat = fs.lstatSync(this.indexPath);
        if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size > MAX_INDEX_BYTES) return {};
        const raw = fs.readFileSync(this.indexPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const safe = {};
        for (const [key, entry] of Object.entries(parsed)) {
          if (!CACHE_KEY_RE.test(key) || !entry || typeof entry !== 'object' ||
              typeof entry.filename !== 'string' || !IMAGE_FILE_RE.test(entry.filename)) continue;
          safe[key] = {
            ...entry,
            hash: key,
            filename: entry.filename,
            image_path: path.join(this.storageDir, entry.filename)
          };
        }
        return Object.fromEntries(Object.entries(safe).slice(0, MAX_ENTRIES));
      }
    } catch {
      // Corrupt or empty file; start with fresh index
    }
    return {};
  }

  /**
   * Merges entries written by another process (stdio + HTTP modes share the index),
   * then writes atomically (tmp file + rename) to avoid corrupting the index.
   */
  _saveIndex({ merge = true } = {}) {
    try {
      if (merge) {
        this.index = { ...this._loadIndex(), ...this.index };
      }
      const safeEntries = Object.entries(this.index)
        .filter(([key, entry]) => CACHE_KEY_RE.test(key) && entry && IMAGE_FILE_RE.test(entry.filename || ''))
        .sort(([, a], [, b]) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, MAX_ENTRIES);
      this.index = Object.fromEntries(safeEntries.map(([key, entry]) => [key, {
        ...entry,
        hash: key,
        image_path: path.join(this.storageDir, entry.filename)
      }]));
      const tmpPath = `${this.indexPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.index), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
      try {
        fs.renameSync(tmpPath, this.indexPath);
      } catch (error) {
        fs.unlinkSync(tmpPath);
        throw error;
      }
    } catch (err) {
      console.error('[Cache] Failed to save cache index:', err.message);
    }
  }

  /**
   * Generates a deterministic SHA-256 hash
   * @param {string[]} referenceHashes - SHA-256 of each reference image content
   */
  computeKey(prompt, style = 'default', aspectRatio = '1:1', referenceHashes = []) {
    // Reference suffix only when present, so keys of existing text-only entries stay valid
    const refs = referenceHashes.length > 0 ? `|${referenceHashes.join(',')}` : '';
    const normalized = `${prompt.trim().toLowerCase()}|${style.toLowerCase()}|${aspectRatio}${refs}`;
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Retrieves a cached image if it exists on disk
   */
  get(key) {
    if (!CACHE_KEY_RE.test(key)) {
      this.misses++;
      return null;
    }
    const entry = this.index[key];
    if (!entry) {
      this.misses++;
      return null;
    }

    // Rebuild paths from a restricted generated filename; never trust paths from the index.
    const imagePath = path.join(this.storageDir, entry.filename || '');
    let isRegularFile = false;
    try {
      isRegularFile = IMAGE_FILE_RE.test(entry.filename || '') && fs.lstatSync(imagePath).isFile();
    } catch {
      isRegularFile = false;
    }
    if (!isRegularFile) {
      delete this.index[key];
      this._saveIndex({ merge: false });
      this.misses++;
      return null;
    }

    this.hits++;
    return {
      ...entry,
      image_path: imagePath,
      cached: true,
      cache_hit: true
    };
  }

  /**
   * Stores a newly generated image in cache
   */
  set(key, data) {
    if (!CACHE_KEY_RE.test(key) || !IMAGE_FILE_RE.test(data.filename || '')) return;
    this.index[key] = {
      hash: key,
      filename: data.filename,
      image_path: path.join(this.storageDir, data.filename),
      style: data.style,
      aspect_ratio: data.aspect_ratio,
      file_size_bytes: data.file_size_bytes,
      mime_type: data.mime_type,
      prompt: data.prompt,
      created_at: data.created_at || new Date().toISOString()
    };
    this._saveIndex();
  }

  /**
   * Returns cache stats
   */
  getStats() {
    const totalEntries = Object.keys(this.index).length;
    return {
      entries: totalEntries,
      hits: this.hits,
      misses: this.misses,
      hit_ratio: (this.hits + this.misses) > 0 ? (this.hits / (this.hits + this.misses)).toFixed(2) : '0.00'
    };
  }

  /**
   * Returns recent images list for MCP resources or gallery
   */
  getRecent(limit = 10) {
    return Object.values(this.index)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .filter((entry) => {
        if (!IMAGE_FILE_RE.test(entry.filename || '')) return false;
        try { return fs.lstatSync(path.join(this.storageDir, entry.filename)).isFile(); } catch { return false; }
      })
      .map((entry) => ({ ...entry, image_path: path.join(this.storageDir, entry.filename) }))
      .slice(0, limit);
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.index = {};
    this.hits = 0;
    this.misses = 0;
    this._saveIndex({ merge: false });
  }
}

module.exports = { ImageCache };
