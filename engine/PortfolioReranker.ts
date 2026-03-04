/**
 * PortfolioReranker
 *
 * Replaces the single MMR pass with a bucket-aware portfolio builder.
 *
 * Pipeline:
 *   scored candidates (with _bucket assigned) →
 *   per-bucket MMR →
 *   quota fill (soft, with slack) →
 *   global constraint enforcement →
 *   novelty slots injection →
 *   final batch
 */

import type {
  SwerveTrack, BucketType, PortfolioConfig, ProfileStyle,
  ExposureHistory, StyleEmbedding,
} from './types.js';
import { cosineSim } from './utils.js';
import { ClusterStaleness } from './ClusterStaleness.js';

// ─── SCORING PER BUCKET ───────────────────────────────────────────────────────

/**
 * Compute bucket-specific score.
 * Each bucket uses different weight vectors to reward what matters most for that role.
 */
export function scoreBucket(
  track: SwerveTrack,
  bucket: BucketType,
  affinitySparse: number,   // existing cosine(profile_sparse, featureVec)
  styleSimScore: number,    // cosine(profile_style, styleEmbedding)
  qualityScore: number,     // curatedQuality()
  freshnessScore: number,   // freshness() from LongMemory
  diversityScore: number,   // distance from already-queued tracks
  bridgeDistScore: number,  // (1 - expectedness), only relevant for bridge
): number {
  switch (bucket) {

    case 'core':
      return (
        0.40 * affinitySparse +
        0.25 * styleSimScore  +
        0.15 * qualityScore   +
        0.15 * freshnessScore +
        0.05 * diversityScore
      );

    case 'bridge':
      return (
        0.35 * styleSimScore   +
        0.30 * bridgeDistScore +
        0.20 * qualityScore    +
        0.10 * freshnessScore  +
        0.05 * diversityScore
      );

    case 'adjacent':
      return (
        0.40 * bridgeDistScore +  // genre adjacency doubles as bridge dist here
        0.30 * styleSimScore   +
        0.20 * qualityScore    +
        0.10 * freshnessScore
      );

    case 'wildcard':
      return (
        0.50 * qualityScore   +
        0.25 * styleSimScore  +
        0.25 * freshnessScore
      );
  }
}

// ─── MMR ─────────────────────────────────────────────────────────────────────

/**
 * Maximal Marginal Relevance selection within a single bucket.
 * Uses style embedding for similarity when available, else feature-vec cosine.
 *
 * @param candidates  Pre-scored candidates for this bucket
 * @param n           Number to select
 * @param lambda      0=pure diversity, 1=pure score
 */
export function mmrSelect(
  candidates: SwerveTrack[],
  n: number,
  lambda: number,
  getEmbedding: (t: SwerveTrack) => StyleEmbedding | null,
): SwerveTrack[] {
  if (candidates.length <= n) return [...candidates];

  const selected: SwerveTrack[] = [];
  const remaining = [...candidates];

  while (selected.length < n && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      const relevance = t._bucketScore ?? 0;

      // Max similarity to already-selected items
      let maxSim = 0;
      if (selected.length > 0) {
        const tEmb = getEmbedding(t);
        for (const s of selected) {
          const sEmb = getEmbedding(s);
          const sim = (tEmb && sEmb) ? cosineSim(tEmb, sEmb) : 0;
          if (sim > maxSim) maxSim = sim;
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

// ─── GLOBAL CONSTRAINTS ───────────────────────────────────────────────────────

interface GlobalConstraints {
  maxSameCountryRun:  number;   // max consecutive tracks from same country
  maxSameSceneRun:    number;   // max consecutive tracks from same scene
  noSameArtistInBatch: boolean;
  noveltySlots:       number;   // guaranteed new-artist slots
}

const DEFAULT_CONSTRAINTS: GlobalConstraints = {
  maxSameCountryRun:  4,
  maxSameSceneRun:    3,
  noSameArtistInBatch: true,
  noveltySlots:       2,
};

/**
 * Enforce global sequence constraints on the merged batch.
 * Swaps violating tracks to the end and fills from the pool.
 */
function enforceConstraints(
  batch: SwerveTrack[],
  overflow: SwerveTrack[],
  constraints: GlobalConstraints,
  knownArtists: Set<string>,  // artists user has encountered before
): SwerveTrack[] {
  const result: SwerveTrack[] = [];
  const usedArtists = new Set<string>();
  let countryRun = 0;
  let lastCountry: string | null = null;
  let sceneRun = 0;
  let lastScene: string | null = null;
  const pool = [...batch, ...overflow];

  for (const t of pool) {
    if (result.length >= batch.length) break;

    const artist = t.a?.toLowerCase().trim() ?? '';
    const country = t.country ?? null;
    const scene = t.sceneTags?.[0] ?? null;

    // Dedup artist within batch
    if (constraints.noSameArtistInBatch && usedArtists.has(artist)) continue;

    // Country run limit
    if (country && country === lastCountry) {
      if (countryRun >= constraints.maxSameCountryRun) continue;
    }

    // Scene run limit
    if (scene && scene === lastScene) {
      if (sceneRun >= constraints.maxSameSceneRun) continue;
    }

    // Accepted
    result.push(t);
    usedArtists.add(artist);
    countryRun = (country === lastCountry) ? countryRun + 1 : 1;
    lastCountry = country;
    sceneRun = (scene === lastScene) ? sceneRun + 1 : 1;
    lastScene = scene;
  }

  // Inject novelty slots: replace last N with lowest-expectedness new artists
  // TODO: implement novelty slot injection using exposure history
  // For now: guaranteed by bridge bucket content

  return result;
}

// ─── PORTFOLIO RERANKER ───────────────────────────────────────────────────────

export class PortfolioReranker {
  private config: PortfolioConfig;
  private staleness: ClusterStaleness;

  constructor(config: PortfolioConfig, staleness: ClusterStaleness) {
    this.config = config;
    this.staleness = staleness;
  }

  /**
   * Build the final batch from bucket-classified, scored candidates.
   *
   * @param allCandidates  All candidates with _bucket and _bucketScore set
   * @param knownArtists   Set of artist keys the user has heard before
   */
  build(
    allCandidates: SwerveTrack[],
    knownArtists: Set<string>,
    constraints: GlobalConstraints = DEFAULT_CONSTRAINTS,
  ): SwerveTrack[] {
    const { batchSize } = this.config;

    // 1. Split into buckets
    const buckets: Record<BucketType, SwerveTrack[]> = {
      core: [], bridge: [], adjacent: [], wildcard: [],
    };
    for (const t of allCandidates) {
      const b = t._bucket ?? 'core';
      buckets[b].push(t);
    }

    // 2. Apply ClusterStaleness boost before MMR
    for (const t of allCandidates) {
      const boost = this.staleness.getFreshnessBoost(t);
      if (boost > 0) t._bucketScore = (t._bucketScore ?? 0) + boost;
    }

    // 3. Per-bucket MMR
    const getEmb = (t: SwerveTrack) => t.styleEmbedding ?? null;
    const bucketTypes: BucketType[] = ['core', 'bridge', 'adjacent', 'wildcard'];
    const selected: SwerveTrack[] = [];
    const overflow: SwerveTrack[] = [];

    for (const bType of bucketTypes) {
      const cfg = this.config[bType];
      const targetN = Math.round(cfg.quota * batchSize);
      const pool = buckets[bType];

      if (pool.length === 0) continue;

      const picked = mmrSelect(pool, targetN, cfg.mmrLambda, getEmb);
      selected.push(...picked);

      // Remaining go to overflow pool (for slack fill)
      const pickedSet = new Set(picked);
      overflow.push(...pool.filter(t => !pickedSet.has(t)));
    }

    // 4. Fill slack from overflow (if total < batchSize)
    const slack = batchSize - selected.length;
    if (slack > 0) {
      overflow.sort((a, b) => (b._bucketScore ?? 0) - (a._bucketScore ?? 0));
      selected.push(...overflow.slice(0, slack));
    }

    // 5. Sort merged batch by bucket order (core first, then bridge, etc.)
    const bucketOrder: Record<BucketType, number> = {
      core: 0, bridge: 1, adjacent: 2, wildcard: 3,
    };
    selected.sort((a, b) => {
      const bo = (bucketOrder[a._bucket ?? 'core'] - bucketOrder[b._bucket ?? 'core']);
      if (bo !== 0) return bo;
      return (b._bucketScore ?? 0) - (a._bucketScore ?? 0);
    });

    // 6. Enforce global constraints + novelty slots
    return enforceConstraints(selected, overflow, constraints, knownArtists);
  }
}
