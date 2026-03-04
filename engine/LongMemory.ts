/**
 * LongMemory
 *
 * Tracks all track/artist/scene/cluster exposures with configurable TTL.
 * Prevents re-surfacing tracks within 1 year, artists within 30–90 days.
 *
 * Storage: localStorage key 'sw_long_memory' (JSON, pruned to control size)
 * Max size: 10,000 track entries (oldest pruned first)
 */

import type {
  SwerveTrack, ExposureHistory, LongMemoryConfig,
} from './types.js';
import { DEFAULT_LONG_MEMORY_CONFIG } from './types.js';

const STORAGE_KEY     = 'sw_long_memory';
const MAX_TRACK_ENTRIES = 10_000;

export class LongMemory {
  private cfg: LongMemoryConfig;
  private data: ExposureHistory;

  constructor(cfg: LongMemoryConfig = DEFAULT_LONG_MEMORY_CONFIG) {
    this.cfg = cfg;
    this.data = this._load();
  }

  // ── PERSISTENCE ────────────────────────────────────────────────────────────

  private _load(): ExposureHistory {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this._empty();
      return JSON.parse(raw) as ExposureHistory;
    } catch {
      return this._empty();
    }
  }

  private _empty(): ExposureHistory {
    return { tracks: {}, artists: {}, scenes: {}, countries: {}, clusters: {} };
  }

  save(): void {
    // Prune tracks before saving
    const trackEntries = Object.entries(this.data.tracks);
    if (trackEntries.length > MAX_TRACK_ENTRIES) {
      trackEntries.sort(([, a], [, b]) => a - b); // oldest first
      const pruned = trackEntries.slice(trackEntries.length - MAX_TRACK_ENTRIES);
      this.data.tracks = Object.fromEntries(pruned);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // localStorage full: prune more aggressively
      this._pruneHalf();
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch {}
    }
  }

  private _pruneHalf(): void {
    const entries = Object.entries(this.data.tracks).sort(([, a], [, b]) => a - b);
    this.data.tracks = Object.fromEntries(entries.slice(Math.floor(entries.length / 2)));
  }

  // ── RECORDING ──────────────────────────────────────────────────────────────

  /**
   * Record a track as surfaced (added to queue).
   * Called after portfolio build, before queue push.
   */
  record(track: SwerveTrack): void {
    const now = Date.now();

    // Track
    this.data.tracks[track.tidalId] = now;

    // Artist
    const ak = track.a?.toLowerCase().trim() ?? '';
    if (ak) {
      const prev = this.data.artists[ak];
      this.data.artists[ak] = {
        lastSeen: now,
        count: prev ? prev.count + 1 : 1,
      };
    }

    // Scenes
    for (const scene of (track.sceneTags ?? [])) {
      const prev = this.data.scenes[scene];
      this.data.scenes[scene] = {
        lastSeen: now,
        count: prev ? prev.count + 1 : 1,
      };
    }

    // Country
    if (track.country) {
      this.data.countries[track.country] = (this.data.countries[track.country] ?? 0) + 1;
    }

    // Cluster
    if (track._clusterId != null) {
      const cid = String(track._clusterId);
      const prev = this.data.clusters[cid];
      this.data.clusters[cid] = {
        lastSeen: now,
        count: prev ? prev.count + 1 : 1,
      };
    }
  }

  // ── BLOCKING ───────────────────────────────────────────────────────────────

  /** Hard block: track re-surfaced within trackTTL → filtered out entirely */
  isTrackBlocked(track: SwerveTrack): boolean {
    const lastSeen = this.data.tracks[track.tidalId];
    if (!lastSeen) return false;
    return (Date.now() - lastSeen) < this.cfg.trackTTL_ms;
  }

  /** Hard block: artist re-surfaced within dynamic TTL */
  isArtistBlocked(track: SwerveTrack): boolean {
    const ak = track.a?.toLowerCase().trim() ?? '';
    if (!ak) return false;
    const exp = this.data.artists[ak];
    if (!exp) return false;
    const ttl = exp.count >= this.cfg.artistExtendThreshold
      ? this.cfg.artistTTLExtended_ms
      : this.cfg.artistTTL_ms;
    return (Date.now() - exp.lastSeen) < ttl;
  }

  /** Convenience: either track or artist is blocked */
  isBlocked(track: SwerveTrack): boolean {
    return this.isTrackBlocked(track) || this.isArtistBlocked(track);
  }

  // ── STALENESS PENALTY (soft, used by scorer) ───────────────────────────────

  /**
   * Returns a [0–1] staleness score for the scene of a track.
   * 0 = scene was surfaced very recently (stale)
   * 1 = scene never surfaced or very old (fresh)
   */
  sceneStalenessPenalty(track: SwerveTrack): number {
    const scenes = track.sceneTags ?? [];
    if (!scenes.length) return 0;

    const maxPenalty = Math.max(...scenes.map(scene => {
      const exp = this.data.scenes[scene];
      if (!exp) return 0;
      const age = Date.now() - exp.lastSeen;
      if (age >= this.cfg.sceneTTL_ms) return 0;
      return 1 - (age / this.cfg.sceneTTL_ms);  // 1=just seen, 0=TTL expired
    }));

    return maxPenalty;  // multiply by a weight in the scorer
  }

  /**
   * Returns a freshness score [0–1] for scoring.
   * 1 = fully fresh (never seen), 0 = maximally stale
   */
  freshnessScore(track: SwerveTrack): number {
    if (this.isTrackBlocked(track)) return 0;
    const scenePenalty = this.sceneStalenessPenalty(track) * 0.3;
    return Math.max(0, 1 - scenePenalty);
  }

  // ── ANALYSIS HELPERS (for BridgePath + ClusterStaleness) ──────────────────

  get exposure(): ExposureHistory {
    return this.data;
  }

  /** Top N countries by play count */
  topCountries(n = 5): string[] {
    return Object.entries(this.data.countries)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .map(([c]) => c);
  }

  /** Top N scenes by play count */
  topScenes(n = 5): string[] {
    return Object.entries(this.data.scenes)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, n)
      .map(([s]) => s);
  }

  /** Most played era (rough heuristic from top scenes) */
  dominantEra(): string | null {
    // TODO: derive from track era field once LongMemory tracks era explicitly
    return null;
  }
}
