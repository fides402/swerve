/**
 * BridgePath — PATH 7
 *
 * Generates "bridge" candidates: tracks/artists that are:
 *   - Stylistically close to the user's profile_style embedding
 *   - Geographically / scenically / temporally distant from the user's top domains
 *
 * "It feels like me, but it comes from somewhere else."
 *
 * Data flow:
 *   profileStyle + exposure history → candidate sources → filter + score → bridge pool
 *
 * Candidate sources (in priority order):
 *   1. GeminiEnricher.bridgeCandidates for top liked artists
 *   2. SceneGraph.adjacent traversal filtered to different countries
 *   3. LFM artist.getSimilar on frontier tracks with low country overlap
 *   4. Spotify /recommendations seeded with cross-region EveryNoise genres
 */

import type {
  SwerveTrack, ProfileStyle, ExposureHistory, BridgeCandidate,
  StyleEmbedding, CountryCode,
} from './types.js';
import { cosineSim, expectedness, curatedQuality, freshness } from './utils.js';
import { SceneGraph } from './SceneGraph.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BRIDGE_CONFIG = {
  minStyleSim:       0.40,   // minimum cosine similarity to profile center
  maxExpectedness:   0.35,   // maximum "familiarity" score
  weightStyleSim:    0.35,
  weightBridgeDist:  0.30,   // (1 - expectedness)
  weightQuality:     0.20,
  weightFreshness:   0.10,
  weightSerendipity: 0.05,   // bonus for never-seen country
  maxCandidates:     40,     // max candidates to pass to portfolio
};

// ─── EXPECTEDNESS ─────────────────────────────────────────────────────────────

/** 0=completely unexpected, 1=exactly what you always hear */
export function computeExpectedness(
  track: SwerveTrack,
  exposure: ExposureHistory,
  topScenes: string[],
  topCountries: CountryCode[],
  dominantEra: string | null,
): number {
  const W = { country: 0.35, scene: 0.35, era: 0.15, artist: 0.15 };

  // Country overlap: how dominant is this country in the user's history?
  const maxCountryCount = Math.max(1, ...Object.values(exposure.countries));
  const countryCount = track.country ? (exposure.countries[track.country] || 0) : 0;
  const countryOverlap = countryCount / maxCountryCount;

  // Scene overlap: fraction of track's scenes already in top-profile scenes
  const topSceneSet = new Set(topScenes.slice(0, 5));
  const trackScenes = track.sceneTags || [];
  const sceneOverlap = trackScenes.length
    ? trackScenes.filter(s => topSceneSet.has(s)).length / trackScenes.length
    : 0;

  // Era match
  const eraMatch = (dominantEra && track.era === dominantEra) ? 1 : 0;

  // Artist familiarity
  const artistExp = track.a ? (exposure.artists[track.a.toLowerCase().trim()]?.count || 0) : 0;
  const artistFamiliarity = Math.min(1, artistExp / 5);

  return (
    W.country  * countryOverlap  +
    W.scene    * sceneOverlap    +
    W.era      * eraMatch        +
    W.artist   * artistFamiliarity
  );
}

// ─── BRIDGE SCORE ─────────────────────────────────────────────────────────────

export function computeBridgeScore(
  track: SwerveTrack,
  profileCenter: StyleEmbedding,
  exposure: ExposureHistory,
  topScenes: string[],
  topCountries: CountryCode[],
  dominantEra: string | null,
): number {
  const styleSim = track.styleEmbedding
    ? cosineSim(track.styleEmbedding, profileCenter)
    : 0.3; // fallback: slightly below threshold — still eligible

  const expected = computeExpectedness(track, exposure, topScenes, topCountries, dominantEra);
  const bridgeDist = 1 - expected;

  const quality = curatedQuality(track);
  const fresh = freshness(track, exposure);

  // Serendipity bonus: country the user has never encountered
  const serendipityBonus = (track.country && !exposure.countries[track.country]) ? 1 : 0;

  return (
    BRIDGE_CONFIG.weightStyleSim    * styleSim   +
    BRIDGE_CONFIG.weightBridgeDist  * bridgeDist +
    BRIDGE_CONFIG.weightQuality     * quality    +
    BRIDGE_CONFIG.weightFreshness   * fresh      +
    BRIDGE_CONFIG.weightSerendipity * serendipityBonus
  );
}

// ─── ELIGIBILITY FILTER ───────────────────────────────────────────────────────

export function isBridgeEligible(
  track: SwerveTrack,
  profileCenter: StyleEmbedding,
  exposure: ExposureHistory,
  topScenes: string[],
  topCountries: CountryCode[],
  dominantEra: string | null,
): boolean {
  if (track.pop > 40) return false;

  const styleSim = track.styleEmbedding
    ? cosineSim(track.styleEmbedding, profileCenter)
    : null;

  // If no embedding yet, allow through if quality is good — will be scored lower
  if (styleSim !== null && styleSim < BRIDGE_CONFIG.minStyleSim) return false;

  const expected = computeExpectedness(track, exposure, topScenes, topCountries, dominantEra);
  if (expected > BRIDGE_CONFIG.maxExpectedness) return false;

  return true;
}

// ─── MAIN BRIDGE PATH ─────────────────────────────────────────────────────────

export class BridgePath {
  private sceneGraph: SceneGraph;

  constructor(sceneGraph: SceneGraph) {
    this.sceneGraph = sceneGraph;
  }

  /**
   * Generate bridge candidates from multiple sources.
   * Returns scored + sorted candidates, capped at BRIDGE_CONFIG.maxCandidates.
   *
   * TODO: wire up actual network calls to LFM/Spotify/GeminiEnricher.
   * For now, this defines the filtering and scoring contract.
   */
  async getCandidates(
    profileStyle: ProfileStyle,
    exposure: ExposureHistory,
    topScenes: string[],
    topCountries: CountryCode[],
    dominantEra: string | null,
    rawCandidates: SwerveTrack[],         // pre-fetched from other paths
    geminiSuggestions: BridgeCandidate[], // from GeminiEnricher
  ): Promise<SwerveTrack[]> {

    // TODO: convert geminiSuggestions to SwerveTrack[] via LFM/Tidal lookup
    const fromGemini: SwerveTrack[] = []; // placeholder

    // Merge raw candidates with gemini-sourced ones
    const all = [...rawCandidates, ...fromGemini];

    // Score and filter
    const scored: Array<{ t: SwerveTrack; score: number }> = [];

    for (const t of all) {
      if (!isBridgeEligible(t, profileStyle.center, exposure, topScenes, topCountries, dominantEra)) {
        continue;
      }
      const score = computeBridgeScore(
        t, profileStyle.center, exposure, topScenes, topCountries, dominantEra,
      );
      scored.push({ t, score });
      t._bucket = 'bridge';
      t._bucketScore = score;
    }

    // Sort by bridge score descending
    scored.sort((a, b) => b.score - a.score);

    // Enforce diversity: max 2 per country, max 2 per scene
    const result: SwerveTrack[] = [];
    const countryCount: Record<string, number> = {};
    const sceneCount: Record<string, number> = {};

    for (const { t } of scored) {
      if (result.length >= BRIDGE_CONFIG.maxCandidates) break;

      const country = t.country || '__unknown';
      const scene = t.sceneTags?.[0] || '__unknown';

      if ((countryCount[country] || 0) >= 2) continue;
      if ((sceneCount[scene] || 0) >= 2) continue;

      countryCount[country] = (countryCount[country] || 0) + 1;
      sceneCount[scene] = (sceneCount[scene] || 0) + 1;
      result.push(t);
    }

    return result;
  }

  /**
   * Derives bridge-friendly genre seeds for Spotify /recommendations.
   * Returns EveryNoise genre seeds from countries/scenes NOT dominant in profile.
   *
   * TODO: cross-reference against SpotifyEngine.genreSeeds
   */
  getBridgeGenreSeeds(
    topCountries: CountryCode[],
    topScenes: string[],
    allGenreSeeds: string[],
  ): string[] {
    const dominated = new Set([...topCountries, ...topScenes].map(s => s.toLowerCase()));

    // Filter out seeds that are clearly from dominant areas
    const bridgeSeeds = allGenreSeeds.filter(g => {
      const lower = g.toLowerCase();
      return !Array.from(dominated).some(d => lower.includes(d));
    });

    // Shuffle and return up to 5
    // TODO: better selection via SceneGraph adjacency
    return bridgeSeeds.sort(() => Math.random() - 0.5).slice(0, 5);
  }
}
