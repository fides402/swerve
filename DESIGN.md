# Swerve — Curatorial Recommendation Engine v2
## Design Document

---

## 0. Goals & Success Criteria

| Test | Expected Outcome |
|---|---|
| Like "Brazilian soul" | Within 1–2 batches, ≥1 bridge from a different country with high style sim |
| 2h session | No collapse to ≤3 artists |
| 2-month simulation | Produces new artists/scenes, zero track repeats |
| Precision@K | Maintained or improved vs v1 |
| Country entropy | ≥3 distinct countries per 20-track batch |
| Scene entropy | ≥4 distinct scenes per 20-track batch |

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    CANDIDATE GENERATION                  │
│                                                          │
│  PATH 1: LFM track.getSimilar + frontier A→B→C          │
│  PATH 2: LFM artist.getSimilar → top tracks → Tidal     │
│  PATH 3: Tidal recommendations                           │
│  PATH 4: Spotify /recommendations + EveryNoise           │
│  PATH 5: ListenBrainz CF                                 │
│  PATH 6: Discogs preset                                  │
│  PATH 7: BridgePath (NEW) ←─────────────────────────────┤
│                                       ↑                  │
│                              SceneGraph + StyleStore      │
└─────────────────────┬───────────────────────────────────┘
                      │  ~120 raw candidates
                      ▼
┌─────────────────────────────────────────────────────────┐
│                      FILTERS (unchanged)                 │
│  pop≤40 · dedup · artist blocked · LongMemory TTL (NEW) │
└─────────────────────┬───────────────────────────────────┘
                      │  ~60–80 candidates
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   BUCKET CLASSIFIER (NEW)                │
│  Assigns each candidate to: core / bridge / adjacent /  │
│  wildcard based on (style_sim, country_dist, scene_dist) │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                 PER-BUCKET SCORING (NEW)                 │
│  core_score / bridge_score / adjacent_score /           │
│  wildcard_score (different weight vectors per bucket)   │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│              PORTFOLIO RERANKER (NEW)                    │
│  Quota: 50% core · 25% bridge · 15% adjacent · 10% wild │
│  MMR within each bucket + global constraints             │
│  ClusterStaleness boost (NEW)                            │
└─────────────────────┬───────────────────────────────────┘
                      │  final batch (20–30 tracks)
                      ▼
┌─────────────────────────────────────────────────────────┐
│               EXPOSURE RECORDER                          │
│  LongMemory.record(track/artist/scene/cluster)           │
└─────────────────────────────────────────────────────────┘

                  ASYNC / OFFLINE
┌─────────────────────────────────────────────────────────┐
│                  GeminiEnricher                          │
│  style_attributes · scene_tags · style_embedding ·      │
│  bridge_candidates · quality_signals                     │
│  → cached in SQLite (fingerprint + version)              │
└─────────────────────────────────────────────────────────┘
```

---

## 2. New Modules

### 2.1 StyleStore
Stores per-track and per-artist dense style representations.

**Responsibilities:**
- Cache `style_embedding` (64-dim float array) indexed by `tidalId` / `artistKey`
- Cache `style_attributes` (structured JSON from Gemini)
- Compute `profile_style` = weighted mean of liked track embeddings
- Compute Mahalanobis distance for anomaly detection

**Storage:** `localStorage` key `sw_style_store` (JSON), size-pruned to 2000 entries LRU.

### 2.2 SceneGraph
A lightweight adjacency graph: scene → {adjacent scenes, typical countries, typical eras}.

**Responsibilities:**
- Populated partially from Gemini responses and partially from hardcoded seeds
- `SceneGraph.adjacent(scene, n)` → top-N adjacent scenes
- `SceneGraph.distance(sceneA, sceneB)` → 0–1 graph distance
- `SceneGraph.countries(scene)` → typical countries for a scene

### 2.3 BridgePath (new PATH 7)
Generates "bridge" candidates: high style similarity, low country/scene/era overlap.

**See section 4.**

### 2.4 PortfolioReranker
Replaces the single MMR pass with a bucket-aware portfolio.

**See section 5.**

### 2.5 LongMemory
Tracks all exposures with TTL-based anti-repeat.

**See section 6.**

### 2.6 ClusterStaleness
Divides the style space into K clusters; tracks exploration coverage; applies staleness penalties and boosts.

**See section 6.3.**

### 2.7 GeminiEnricher
Async offline enrichment. Calls Gemini API, caches results, enriches the track metadata store.

**See section 7.**

---

## 3. Data Schemas

### 3.1 Track (extended)

```typescript
interface SwerveTrack {
  // ── existing ──────────────────────────────────────────
  tidalId:   string;
  a:         string;   // artist
  t:         string;   // title
  al:        string;   // album
  pop:       number;   // 0–100
  dur:       number;   // seconds
  img:       string;
  _src?:     string;   // source tag

  // ── new: geographic / temporal ────────────────────────
  country?:  string;   // ISO 3166-1 alpha-2 ("BR", "US", "NG"...)
  region?:   string;   // broader region ("West Africa", "Rio de Janeiro")
  language?: string;   // BCP-47 ("pt-BR", "yo", "en"...)
  era?:      string;   // "1960s" | "1970s" | ... | "2020s"
  label?:    string;   // record label

  // ── new: style ────────────────────────────────────────
  styleEmbedding?:    number[];        // 64-dim, cosine-normalised
  styleAttributes?:   StyleAttributes;
  sceneTags?:         string[];        // ["bossa nova", "samba-soul", ...]
  qualitySignals?:    QualitySignals;

  // ── new: internal ─────────────────────────────────────
  _bucket?:     BucketType;            // assigned during portfolio build
  _bucketScore?: number;
}
```

### 3.2 StyleAttributes

```typescript
interface StyleAttributes {
  groove:          number;    // 0–1  rhythmic density / swing feel
  harmony:         number;    // 0–1  complexity (simple→jazz)
  feel:            string[];  // ["warm", "melancholic", "driving", ...]
  instrumentation: string[];  // ["guitar", "Rhodes", "baião percussion", ...]
  mood:            string[];  // ["contemplative", "euphoric", ...]
  era:             string;    // canonical era label
  scene:           string;    // primary scene
  tempo_feel:      string;    // "laid-back" | "mid-tempo" | "driving"
  rawText?:        string;    // Gemini explanation (stored for debugging)
}
```

### 3.3 QualitySignals

```typescript
interface QualitySignals {
  sceneCred:       number;   // 0–1: label/scene prestige (from SceneGraph)
  labelCred:       number;   // 0–1: label tier (indie boutique vs major)
  rareTagCount:    number;   // count of rare Last.fm tags
  isOriginal:      boolean;  // MusicBrainz original release
  coListenerScore: number;   // 0–1: overlap with LB similar users
  geminiConfidence?: number; // 0–1: Gemini's own confidence in extraction
}
```

### 3.4 UserProfile (extended)

```typescript
interface UserProfileState {
  // ── existing (persisted in localStorage as today) ─────
  profileVector: Record<string, number>;   // sparse feature accumulator
  profileTotal:  number;

  // ── new: style center ────────────────────────────────
  profileStyle?: {
    center:    number[];     // mean of liked embeddings (64-dim)
    count:     number;       // how many embeddings averaged
    // future: covariance for Mahalanobis
  };

  // ── new: exposure history ─────────────────────────────
  exposure: {
    tracks:   Record<string, number>;  // tidalId → timestamp last seen
    artists:  Record<string, { lastSeen: number; count: number }>;
    scenes:   Record<string, { lastSeen: number; count: number }>;
    countries:Record<string, number>;  // country → total plays
    clusters: Record<string, { lastSeen: number; count: number }>;
  };

  // ── new: cluster coverage ────────────────────────────
  clusterCoverage: Record<string, number>;  // clusterId → exposure count
}
```

### 3.5 BucketType

```typescript
type BucketType = 'core' | 'bridge' | 'adjacent' | 'wildcard';
```

---

## 4. BridgePath — Algorithm

### 4.1 Concept
A bridge track satisfies:
- **High style similarity** to `profile_style` (embedding cosine ≥ threshold)
- **Low "expectedness"** (different country/scene/era from top-explored domains)

```
bridge_value(track) = style_sim(track, profile) × (1 − expectedness(track, profile))
```

### 4.2 Expectedness

```
expectedness(track, profile) =
    w_country × country_overlap(track.country, profile.topCountries)
  + w_scene   × scene_overlap(track.sceneTags, profile.topScenes)
  + w_era     × era_match(track.era, profile.topEra)
  + w_artist  × artist_familiarity(track.artist, profile.exposure.artists)

where:
  country_overlap = exposure_count(country) / max_country_count  (0–1)
  scene_overlap   = max overlap fraction of track.sceneTags ∩ profile.topScenes
  era_match       = 1 if track.era == profile.dominantEra else 0
  artist_familiarity = min(1, artist_exposure_count / 5)

weights: w_country=0.35, w_scene=0.35, w_era=0.15, w_artist=0.15
```

### 4.3 Bridge Score

```
bridge_score(track) =
    0.35 × style_sim(track.styleEmbedding, profile.center)
  + 0.30 × (1 − expectedness(track, profile))
  + 0.20 × curated_quality(track.qualitySignals)
  + 0.10 × freshness(track, exposure)
  + 0.05 × serendipity_bonus  // bonus if country never seen before
```

### 4.4 BridgePath Candidate Sources
1. **Gemini bridge_suggestion** output: lists of artists/scenes cross-country
2. **SceneGraph.adjacent** traversal starting from top scenes, filtered to different countries
3. **LFM artist.getSimilar** on frontier tracks that have low country_overlap
4. **Spotify recs** seeded with bridge genre seeds (EveryNoise genres from different regions)

### 4.5 Eligibility Filter
A candidate enters the bridge pool only if:
- `style_sim ≥ 0.4`
- `expectedness < 0.35`
- `pop ≤ 40`
- Not in `LongMemory` (TTL not expired)

---

## 5. Portfolio Reranking

### 5.1 Default Quota

```typescript
const DEFAULT_PORTFOLIO: PortfolioConfig = {
  core:     { quota: 0.50, mmrLambda: 0.6 },  // 50%
  bridge:   { quota: 0.25, mmrLambda: 0.7 },  // 25%
  adjacent: { quota: 0.15, mmrLambda: 0.5 },  // 15%
  wildcard: { quota: 0.10, mmrLambda: 0.3 },  // 10%
};
```

Quotas are **soft**: if a bucket is underpopulated, slack flows to `core`.

### 5.2 Per-Bucket Score Weights

```
core_score =
    0.40 × affinity_sparse    // existing cosine(profile_sparse, featureVec)
  + 0.25 × style_sim          // cosine(profile_style, styleEmbedding)
  + 0.15 × curated_quality
  + 0.15 × freshness          // LongMemory-based
  + 0.05 × diversity

bridge_score = (as in section 4.3)

adjacent_score =
    0.40 × genre_adjacency    // SceneGraph.distance to top scenes
  + 0.30 × style_sim
  + 0.20 × curated_quality
  + 0.10 × freshness

wildcard_score =
    0.50 × curated_quality
  + 0.25 × style_sim
  + 0.25 × freshness
```

### 5.3 Global Constraints (across all buckets, final output)
- No same artist twice in the same batch
- No same country in more than 4 consecutive positions
- No same scene tag in more than 3 consecutive positions
- ClusterStaleness boost: if cluster is under-explored, tracks from it get +0.08

### 5.4 MMR Within Bucket

```
MMR(Si, Q, C) = argmax_di∈C\S [
  λ × bucket_score(di) − (1−λ) × max_dj∈S sim(di, dj)
]
```
where `sim` uses style embedding if available, else featureVec cosine.

---

## 6. Long-term Freshness & Memory

### 6.1 Track TTL Anti-repeat

```
TTL_track   = 365 days  (never re-surface a track within 1 year)
TTL_artist  = 30 days   (after ≥3 exposures in a session: 90 days)
TTL_scene   = 7 days    (push to explore other scenes regularly)
```

All TTLs are **configurable** via `Settings`.

### 6.2 Staleness Penalty

```
staleness_penalty(track) =
  if (last_seen_track < TTL_track)    → exclude entirely
  if (last_seen_artist < TTL_artist)  → score × 0.3
  if (last_seen_scene < 3 days)       → score × 0.85
  else                                → 0
```

### 6.3 ClusterStaleness

Style space divided into K=20 clusters (k-means on 64-dim style embeddings).

```
staleness(cluster) = 1 / (1 + exposure_count(cluster))
freshness_boost(track) =
  if track.cluster in under-explored clusters:
    + 0.08 × staleness(track.cluster) × style_sim(track, profile)
```

Cluster assignment: every track with a style embedding is assigned to its nearest centroid. Centroids are periodically recomputed (or shipped as fixed seed centroids from Gemini bootstrapping).

---

## 7. Quality Signals — Upgraded

Current `quality` = rare tags + MusicBrainz original bonus.

New `curated_quality`:

```
curated_quality(track) =
    0.30 × rare_tag_score           // existing rare tags
  + 0.20 × scene_cred               // label/scene prestige from SceneGraph
  + 0.20 × label_cred               // indie boutique vs major
  + 0.20 × co_listener_score        // LB/LFM similar-user co-plays
  + 0.10 × original_bonus           // MusicBrainz isOriginal
```

For **bridge** and **wildcard** buckets, quality weight is higher (0.20 → 0.30) to compensate for lower explicit affinity.

---

## 8. Gemini Integration

### 8.1 Role
Gemini is **offline/async only**. It never blocks the real-time recommendation pipeline.

### 8.2 Enrichment Triggers
1. When a track is liked (highest priority)
2. When a track enters the queue but has no style data (background, low priority)
3. Periodic batch enrichment of the most-played artists (weekly cron)

### 8.3 Outputs per Track
- `style_attributes` (JSON)
- `style_embedding` (via a text embedding or structured feature → PCA)
- `scene_tags`
- `quality_signals.sceneCred`, `labelCred`
- `country`, `era`, `language` (if not already known)

### 8.4 Outputs per Artist
- `bridge_candidates`: list of {artist, scene, country, era, why_bridge}
- Scene classification

### 8.5 Caching Strategy
```
DB: SQLite (gemini-cache.db)
Table: gemini_cache
  - id             INTEGER PRIMARY KEY
  - fingerprint    TEXT UNIQUE   -- SHA256(artist|title|prompt_version)
  - prompt_version TEXT          -- e.g. "style_v2"
  - input_json     TEXT
  - output_json    TEXT
  - created_at     INTEGER       -- unix ms
  - model          TEXT          -- "gemini-2.0-flash"
  - tokens_used    INTEGER
```

Version bump → existing cache entries invalidated for that prompt type.
Rate limiting: token bucket, max 60 req/min, with exponential backoff on 429.

### 8.6 Cost Control
- Only enrich tracks with `pop ≤ 50` (no mainstream enrichment waste)
- Only enrich artists with ≥3 likes or appearing in queue ≥5 times
- Cache TTL: 90 days for style attributes, 30 days for bridge suggestions
- Hard daily cap: 500 requests/day (configurable)

---

## 9. Pseudocode — End-to-End Ranking

```
async function refill(forceSeedId):

  ── PHASE 1: CANDIDATE GENERATION ──────────────────────────
  candidates = []

  // Existing paths (unchanged logic)
  candidates += await lfmSimilarPath(seeds=weightedSeedSample(5) + frontier)
  candidates += await lfmArtistPath(topLikedArtists(4))
  candidates += await tidalPath(likedSeeds(5))
  candidates += await spotifyPath(audioProfile, everyNoiseGenres)
  candidates += await listenBrainzPath(lbTracks)
  candidates += preset ? await discogsPath() : []

  // NEW: Bridge path
  if (profileStyle.count >= 5):
    candidates += await bridgePath(profileStyle, sceneGraph, exposure)

  ── PHASE 2: HARD FILTERS ────────────────────────────────────
  candidates = candidates
    .filter(dedup)
    .filter(t => t.pop <= RARE_POP_MAX)
    .filter(t => !LongMemory.isBlocked(t))           // NEW
    .filter(t => !Taste.shouldFilter(t))
    .filter(t => !isLiked(t) && !hasSeen(t))
    .filter(t => passesGenreFilter(t) || t._bucket === 'bridge')  // bridges bypass genre filter

  ── PHASE 3: BUCKET CLASSIFICATION ──────────────────────────
  for each t in candidates:
    t._bucket = classifyBucket(t, profileStyle, exposure, sceneGraph)
    // returns 'core' | 'bridge' | 'adjacent' | 'wildcard'

  ── PHASE 4: PER-BUCKET SCORING ──────────────────────────────
  for each t in candidates:
    t._bucketScore = scoreBucket(t, t._bucket, profile, profileStyle, exposure)

  ── PHASE 5: PORTFOLIO RERANKING ─────────────────────────────
  batch = PortfolioReranker.build(candidates, PORTFOLIO_CONFIG, batchSize=25)
  // - fill each bucket with MMR up to quota
  // - apply global constraints (country run, scene run, artist dedup)
  // - ClusterStaleness boost
  // - 2 guaranteed novelty slots

  ── PHASE 6: RECORD EXPOSURE ────────────────────────────────
  for each t in batch:
    LongMemory.record(t)
    StyleStore.updateProfileStyle(t, action='surfaced')  // only if liked later

  ── PHASE 7: ASYNC ENRICHMENT (non-blocking) ─────────────────
  GeminiEnricher.enqueueIfNeeded(batch)

  return batch


function classifyBucket(track, profileStyle, exposure, sceneGraph):
  if !profileStyle || profileStyle.count < 5:
    return 'core'  // cold start: everything is core

  styleSim   = cosineSim(track.styleEmbedding, profileStyle.center)
  expected   = expectedness(track, exposure)
  adjacent   = isAdjacentGenre(track, profileTopScenes, sceneGraph)

  if styleSim >= 0.5 and expected < 0.35:  return 'bridge'
  if styleSim >= 0.35 and adjacent:         return 'adjacent'
  if styleSim < 0.25 and quality > 0.7:    return 'wildcard'
  return 'core'
```

---

## 10. File Structure

```
swerve/
├── app.js                    (existing — receives thin adapters)
├── index.html
├── DESIGN.md                 (this document)
├── MIGRATION.md
│
├── engine/                   (browser-compatible TS → compiled to engine.js)
│   ├── types.ts
│   ├── StyleStore.ts
│   ├── SceneGraph.ts
│   ├── BridgePath.ts
│   ├── PortfolioReranker.ts
│   ├── LongMemory.ts
│   └── ClusterStaleness.ts
│
└── gemini/                   (Node.js service — runs offline/locally)
    ├── client.ts
    ├── prompts.ts
    ├── cache.ts              (SQLite via better-sqlite3)
    └── rate-limiter.ts
```
