/**
 * ClusterStaleness
 *
 * Divides the style space into K clusters (k-means on 64-dim style embeddings).
 * Tracks which clusters the user has explored and boosts under-explored ones.
 *
 * "Keeps exploration moving through the full aesthetic space."
 *
 * Bootstrap strategy:
 *   - On first run, centroids are either loaded from a pre-computed seed file
 *     (generated offline by GeminiEnricher) or randomly initialised from enriched liked tracks.
 *   - Centroids are re-computed at most once per week (lazy recomputation).
 */

import type { SwerveTrack, StyleEmbedding } from './types.js';
import { cosineSim } from './utils.js';

const STORAGE_KEY   = 'sw_cluster_state';
const K             = 20;    // number of clusters
const BOOST_MAX     = 0.08;  // max freshness boost added to score
const RECOMPUTE_MS  = 7 * 24 * 3600 * 1000; // 1 week

interface ClusterState {
  centroids:   StyleEmbedding[];  // K centroids
  coverage:    Record<number, { count: number; lastSeen: number }>;
  computedAt:  number;
}

export class ClusterStaleness {
  private state: ClusterState | null = null;

  constructor() {
    this.state = this._load();
  }

  private _load(): ClusterState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private _save(): void {
    if (!this.state) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {}
  }

  get isReady(): boolean {
    return this.state !== null && this.state.centroids.length === K;
  }

  // ── CLUSTER ASSIGNMENT ─────────────────────────────────────────────────────

  /** Assign a track to its nearest centroid. Returns cluster id (0 to K-1). */
  assign(embedding: StyleEmbedding): number {
    if (!this.state) return 0;
    let best = 0, bestSim = -Infinity;
    for (let i = 0; i < this.state.centroids.length; i++) {
      const sim = cosineSim(embedding, this.state.centroids[i]);
      if (sim > bestSim) { bestSim = sim; best = i; }
    }
    return best;
  }

  assignTrack(track: SwerveTrack): number | null {
    if (!track.styleEmbedding || !this.state) return null;
    const id = this.assign(track.styleEmbedding);
    track._clusterId = id;
    return id;
  }

  // ── COVERAGE RECORDING ─────────────────────────────────────────────────────

  recordExposure(track: SwerveTrack): void {
    const id = track._clusterId ?? (track.styleEmbedding ? this.assign(track.styleEmbedding) : null);
    if (id == null || !this.state) return;
    const prev = this.state.coverage[id] ?? { count: 0, lastSeen: 0 };
    this.state.coverage[id] = { count: prev.count + 1, lastSeen: Date.now() };
    this._save();
  }

  // ── FRESHNESS BOOST ────────────────────────────────────────────────────────

  /**
   * Returns a bonus [0, BOOST_MAX] for under-explored clusters.
   * cluster_staleness = 1 / (1 + exposure_count)
   * boost = BOOST_MAX * staleness * style_similarity_to_profile
   *
   * Requires the track to have a styleEmbedding.
   */
  getFreshnessBoost(track: SwerveTrack, profileCenter?: StyleEmbedding): number {
    if (!this.state || !track.styleEmbedding) return 0;
    const id = track._clusterId ?? this.assign(track.styleEmbedding);
    const exposure = this.state.coverage[id]?.count ?? 0;
    const staleness = 1 / (1 + exposure);

    // If profile center provided, weight by style similarity
    const styleSim = profileCenter ? Math.max(0, cosineSim(track.styleEmbedding, profileCenter)) : 0.5;

    return BOOST_MAX * staleness * styleSim;
  }

  // ── CENTROID MANAGEMENT ────────────────────────────────────────────────────

  /**
   * Initialise or re-compute centroids from a set of embeddings.
   * Uses k-means++ initialisation.
   *
   * Call this at startup if not yet initialised, and weekly thereafter.
   *
   * @param embeddings  Array of [tidalId, embedding] pairs from enriched liked tracks
   */
  recompute(embeddings: StyleEmbedding[]): void {
    if (embeddings.length < K) return;  // not enough data yet

    const centroids = this._kMeansPlusPlus(embeddings, K);
    this.state = {
      centroids,
      coverage: this.state?.coverage ?? {},
      computedAt: Date.now(),
    };
    this._save();
  }

  needsRecompute(): boolean {
    if (!this.state) return true;
    return (Date.now() - this.state.computedAt) > RECOMPUTE_MS;
  }

  /**
   * Seed centroids from a pre-computed list (e.g. shipped from GeminiEnricher bootstrap).
   */
  seedCentroids(centroids: StyleEmbedding[]): void {
    this.state = {
      centroids: centroids.slice(0, K),
      coverage: this.state?.coverage ?? {},
      computedAt: Date.now(),
    };
    this._save();
  }

  // ── K-MEANS++ ──────────────────────────────────────────────────────────────

  private _kMeansPlusPlus(data: StyleEmbedding[], k: number): StyleEmbedding[] {
    // TODO: implement proper k-means++ for production
    // For now: random selection without replacement (placeholder)
    const shuffled = [...data].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, k);
  }

  // ── ANALYTICS ─────────────────────────────────────────────────────────────

  /** Returns clusters sorted by exposure count (most → least explored) */
  coverageReport(): Array<{ clusterId: number; count: number; lastSeen: number }> {
    if (!this.state) return [];
    return Object.entries(this.state.coverage)
      .map(([id, data]) => ({ clusterId: Number(id), ...data }))
      .sort((a, b) => b.count - a.count);
  }
}
