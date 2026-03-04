/**
 * Swerve Engine v2 — Shared Type Definitions
 *
 * These interfaces define the extended data model.
 * The legacy app.js uses plain JS objects; these types serve as
 * the authoritative schema during migration and for new modules.
 */

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────

/** 64-dimensional L2-normalised style embedding vector */
export type StyleEmbedding = number[];

/** ISO 3166-1 alpha-2 country code, e.g. "BR", "NG", "JP" */
export type CountryCode = string;

/** Canonical era label */
export type Era = '1950s' | '1960s' | '1970s' | '1980s' | '1990s' | '2000s' | '2010s' | '2020s';

export type BucketType = 'core' | 'bridge' | 'adjacent' | 'wildcard';

// ─── TRACK ────────────────────────────────────────────────────────────────────

export interface StyleAttributes {
  groove:          number;    // 0–1 rhythmic density / swing feel
  harmony:         number;    // 0–1 harmonic complexity
  feel:            string[];  // e.g. ["warm", "melancholic"]
  instrumentation: string[];  // e.g. ["Rhodes", "baião percussion"]
  mood:            string[];  // e.g. ["contemplative", "euphoric"]
  era:             Era | string;
  scene:           string;    // primary scene label
  tempo_feel:      'laid-back' | 'mid-tempo' | 'driving' | string;
  rawText?:        string;    // Gemini explanation (debug only)
}

export interface QualitySignals {
  sceneCred:         number;   // 0–1 label/scene prestige
  labelCred:         number;   // 0–1 label tier (boutique → 1, major → 0)
  rareTagCount:      number;   // count of rare Last.fm tags
  isOriginal:        boolean;  // MusicBrainz original release
  coListenerScore:   number;   // 0–1 LB/LFM similar-user co-play overlap
  geminiConfidence?: number;   // 0–1 Gemini extraction confidence
}

/** Extended track, backward-compatible with legacy app.js plain objects */
export interface SwerveTrack {
  // ── legacy fields (always present) ───────────────────────────────────────
  tidalId:  string;
  a:        string;   // artist
  t:        string;   // title
  al?:      string;   // album
  pop:      number;   // 0–100 Tidal popularity
  dur?:     number;   // seconds
  img?:     string;
  _src?:    string;   // source tag: 'lfm_similar' | 'tidal_rec' | etc.

  // ── geographic / temporal ─────────────────────────────────────────────
  country?:  CountryCode;
  region?:   string;   // e.g. "West Africa", "Rio de Janeiro"
  language?: string;   // BCP-47, e.g. "pt-BR", "yo"
  era?:      Era | string;
  label?:    string;   // record label

  // ── style ─────────────────────────────────────────────────────────────
  styleEmbedding?:  StyleEmbedding;
  styleAttributes?: StyleAttributes;
  sceneTags?:       string[];
  qualitySignals?:  QualitySignals;

  // ── portfolio internals ────────────────────────────────────────────────
  _bucket?:      BucketType;
  _bucketScore?: number;
  _clusterId?:   number;  // K-means cluster assignment
}

// ─── ARTIST ───────────────────────────────────────────────────────────────────

export interface BridgeCandidate {
  artist:     string;
  scene:      string;
  country:    CountryCode;
  era:        string;
  why_bridge: string;  // Gemini's explanation
}

export interface ArtistMeta {
  name:             string;
  styleEmbedding?:  StyleEmbedding;
  sceneTags?:       string[];
  country?:         CountryCode;
  era?:             string;
  bridgeCandidates?: BridgeCandidate[];
  qualityCred?:     number;  // 0–1
  enrichedAt?:      number;  // timestamp
}

// ─── USER PROFILE ─────────────────────────────────────────────────────────────

export interface ProfileStyle {
  center: StyleEmbedding;  // weighted mean of liked track embeddings
  count:  number;
}

export interface ArtistExposure {
  lastSeen: number;  // timestamp ms
  count:    number;
  // If count >= 3, TTL extends from 30d → 90d
}

export interface ExposureHistory {
  tracks:    Record<string, number>;           // tidalId → last surfaced timestamp
  artists:   Record<string, ArtistExposure>;
  scenes:    Record<string, { lastSeen: number; count: number }>;
  countries: Record<string, number>;           // country → total plays
  clusters:  Record<string, { lastSeen: number; count: number }>;
}

export interface UserProfileV2 {
  // ── legacy (unchanged) ─────────────────────────────────────────────────
  profileVector: Record<string, number>;
  profileTotal:  number;

  // ── new ─────────────────────────────────────────────────────────────────
  profileStyle?:   ProfileStyle;
  exposure:        ExposureHistory;
  clusterCoverage: Record<string, number>;  // clusterId → exposure count
}

// ─── PORTFOLIO CONFIG ─────────────────────────────────────────────────────────

export interface BucketConfig {
  quota:     number;  // 0–1, fraction of final batch
  mmrLambda: number;  // 0=pure diversity, 1=pure score
}

export interface PortfolioConfig {
  core:     BucketConfig;
  bridge:   BucketConfig;
  adjacent: BucketConfig;
  wildcard: BucketConfig;
  batchSize: number;
}

export const DEFAULT_PORTFOLIO_CONFIG: PortfolioConfig = {
  core:     { quota: 0.50, mmrLambda: 0.60 },
  bridge:   { quota: 0.25, mmrLambda: 0.70 },
  adjacent: { quota: 0.15, mmrLambda: 0.50 },
  wildcard: { quota: 0.10, mmrLambda: 0.30 },
  batchSize: 25,
};

// ─── LONG MEMORY CONFIG ───────────────────────────────────────────────────────

export interface LongMemoryConfig {
  trackTTL_ms:        number;  // default: 365 days
  artistTTL_ms:       number;  // default: 30 days (extends to 90d after ≥3 exposures)
  artistTTLExtended_ms: number;
  artistExtendThreshold: number; // exposures before TTL extends
  sceneTTL_ms:        number;  // default: 7 days (soft staleness, not hard block)
}

export const DEFAULT_LONG_MEMORY_CONFIG: LongMemoryConfig = {
  trackTTL_ms:           365 * 24 * 3600 * 1000,
  artistTTL_ms:           30 * 24 * 3600 * 1000,
  artistTTLExtended_ms:   90 * 24 * 3600 * 1000,
  artistExtendThreshold:  3,
  sceneTTL_ms:             7 * 24 * 3600 * 1000,
};

// ─── SCENE GRAPH ──────────────────────────────────────────────────────────────

export interface SceneNode {
  name:       string;
  adjacent:   string[];   // scene names
  countries:  CountryCode[];
  eras:       string[];
  cred:       number;     // 0–1 scene prestige prior
}

// ─── GEMINI ENRICHMENT ────────────────────────────────────────────────────────

export type GeminiPromptType =
  | 'style_extraction'
  | 'scene_classification'
  | 'bridge_suggestion'
  | 'quality_assessment';

export interface GeminiCacheEntry {
  id:             number;
  fingerprint:    string;         // SHA256(artist|title|promptType|version)
  prompt_version: string;
  prompt_type:    GeminiPromptType;
  input_json:     string;
  output_json:    string;
  created_at:     number;         // unix ms
  model:          string;
  tokens_used:    number;
}

export interface GeminiStyleOutput {
  style_attributes: StyleAttributes;
  scene_tags:       string[];
  country?:         CountryCode;
  era?:             string;
  language?:        string;
  label?:           string;
  quality_signals:  Partial<QualitySignals>;
  confidence:       number;
}

export interface GeminiBridgeOutput {
  bridge_candidates: BridgeCandidate[];
  reasoning:         string;
}
