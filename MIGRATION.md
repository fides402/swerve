# Swerve v2 — Migration Plan

## Principles
- **No regressions**: every phase is independently releasable and rolls back cleanly
- **Feature flags**: each new component is gated by `S.flags.*`
- **Fallback**: if a new module fails or returns empty, the existing path is used unchanged
- **Metrics first**: define success metrics before activating each phase

---

## Phase 0 — Instrumentation (deploy immediately, no behaviour change)

**Goal:** collect the data needed to measure baseline before anything changes.

### Changes to `app.js`
```js
// Add to S (state) — persisted in localStorage
S.flags = {
  longMemory:        false,
  portfolioReranker: false,
  bridgePath:        false,
  clusterStaleness:  false,
  geminiEnrich:      false,
};

// Add exposure event logging to existing swipe handlers
function recordExposure(track) {
  if (!S.flags.longMemory) return;
  LongMemory.record(track);
}
```

### Metrics to baseline (before any changes)
| Metric | How to measure |
|---|---|
| Country entropy per 20-track batch | Shannon H over `track.country` values |
| Scene entropy per 20-track batch | Shannon H over `track.sceneTags[0]` |
| Artist repeat rate | % of batches with ≥1 artist already seen in last 3 batches |
| precision@10 (proxy) | % of surfaced tracks that get liked |
| Track-already-seen rate | % of candidates rejected as already-seen |

Log these to `console.debug('[metrics]', ...)` so they're capturable.

**Rollback:** `S.flags.longMemory = false`
**Duration:** 1 week of usage.

---

## Phase 1 — LongMemory (track TTL + artist TTL)

**Activates:** `S.flags.longMemory = true`
**Depends on:** Phase 0 instrumentation

### What changes
- `LongMemory` module loaded from `engine/LongMemory.js` (compiled from TS)
- Hard filter added to `Queue.refill()`:
  ```js
  .filter(t => !LongMemory.isBlocked(t))  // replaces weaker seen-inventory
  ```
- Artist cooldown migrated from `S.artistCooldown` (25-min ephemeral) to `LongMemory` (30–90d persistent)
- `S.seen` (session-only) remains unchanged; LongMemory adds cross-session layer

### Fallback
```js
function isBlocked(t) {
  if (!S.flags.longMemory) return hasSeen(t) || isLiked(t);  // legacy
  return LongMemory.isBlocked(t) || hasSeen(t) || isLiked(t);
}
```

### Success criteria
- Artist repeat rate ↓ by ≥30%
- Track-already-seen rate does not increase (LongMemory supersedes, not adds to, session seen)
- Queue fill rate unchanged (≥20 tracks per refill)

**Rollback:** `S.flags.longMemory = false` → legacy `hasSeen` resumes
**Duration:** 2 weeks.

---

## Phase 2 — GeminiEnricher (async offline enrichment)

**Activates:** manual CLI runs (never auto-activated from browser)
**Depends on:** Phase 1

### What changes
- `gemini/client.ts` compiled to `gemini/client.js`
- User runs enrichment manually:
  ```bash
  node gemini/client.js --enrich-liked
  ```
  (reads `sw_liked` from exported JSON, writes `gemini-enriched.json`)
- `app.js` loads `gemini-enriched.json` at startup (if present):
  ```js
  async function loadGeminiEnrichments() {
    if (!S.flags.geminiEnrich) return;
    try {
      const r = await fetch('./gemini-enriched.json');
      const data = await r.json();
      Object.assign(S.geminiEnrich, data);  // key: "artist|title" → StyleOutput
    } catch {}
  }
  ```
- `FeatureVec.build()` augmented to include `style_attributes` if available:
  ```js
  const gemini = S.geminiEnrich?.[ck];
  if (gemini?.style_attributes) {
    // Add scene_tags, country, era to featureVec
    for (const s of (gemini.scene_tags || [])) vec[`sty:${s}`] = (vec[`sty:${s}`] || 0) + 0.5;
    if (gemini.country) vec[`cnt:${gemini.country}`] = 1;
  }
  ```

### Cold start behaviour
If `gemini-enriched.json` doesn't exist: no change from Phase 1. Gemini data is additive.

### Success criteria
- Tracks enriched by Gemini have higher like-rate than non-enriched (in same batch)
- Country/scene entropy per batch increases by ≥10%

**Duration:** ongoing (run enrichment weekly).

---

## Phase 3 — Portfolio Reranker (bucket-based ranking)

**Activates:** `S.flags.portfolioReranker = true`
**Depends on:** Phase 2 (soft dependency — works without Gemini enrichment)

### What changes
- `engine/PortfolioReranker.js` loaded
- `Scorer.score()` refactored: returns `{ core_score, quality, freshness, diversity }` components
- `Queue.refill()` bucket classification added:
  ```js
  for (const t of candidates) {
    t._bucket = classifyBucket(t);  // 'core' | 'bridge' | 'adjacent' | 'wildcard'
    t._bucketScore = scoreBucket(t, t._bucket, ...components);
  }
  const batch = S.flags.portfolioReranker
    ? PortfolioReranker.build(candidates, knownArtists)
    : legacyMmr(candidates);  // fallback
  ```

### Fallback
```js
// If PortfolioReranker throws or returns empty:
if (!batch.length) batch = legacyMmr(candidates);
```

### Cold start (no style embeddings)
- Without embeddings, `classifyBucket` returns `'core'` for everything
- Portfolio still runs, but all buckets except `core` are empty
- Slack fill from `core` → behaviour identical to legacy MMR

### A/B test design
- Users with `localStorage.getItem('sw_ab') === 'v2'` get `portfolioReranker = true`
- Measure precision@10, country_entropy, scene_entropy over 2 weeks

**Success criteria:**
- Country entropy ↑ ≥15%
- precision@10 unchanged or better
- No increase in skip rate

**Duration:** 2–4 weeks A/B.

---

## Phase 4 — BridgePath (PATH 7)

**Activates:** `S.flags.bridgePath = true`
**Depends on:** Phase 3 + Gemini bridge_suggestion data

### What changes
- `engine/BridgePath.js` + `engine/SceneGraph.js` loaded
- `Queue.refill()` adds PATH 7:
  ```js
  if (S.flags.bridgePath && profileStyle.count >= 5) {
    const geminiSuggestions = S.geminiBridges?.[topArtistKey] ?? [];
    const bridgeCandidates = await BridgePath.getCandidates(
      profileStyle, LongMemory.exposure, topScenes, topCountries, dominantEra,
      allCandidates,  // use already-fetched candidates
      geminiSuggestions,
    );
    candidates.push(...bridgeCandidates);
  }
  ```
- SceneGraph seeded from `gemini-scenes.json` (output of `--classify-artists` run)

### Fallback
If `S.flags.bridgePath = false` or `profileStyle.count < 5`: bridge bucket is empty, portfolio fills from `core` slack.

### Metrics
| Metric | Target |
|---|---|
| Bridge tracks in batch | ≥4 per 20-track batch (when active) |
| Bridge like-rate | Within 20% of core like-rate |
| New country per session | ≥1 country never previously encountered |

**Duration:** 4 weeks monitoring.

---

## Phase 5 — ClusterStaleness

**Activates:** `S.flags.clusterStaleness = true`
**Depends on:** Phase 4 + ≥50 Gemini-enriched liked tracks (for embedding centroid seed)

### What changes
- `ClusterStaleness.recompute(embeddings)` called at startup if stale
- `getFreshnessBoost(t)` called in `scoreBucket()`

### Cold start
With < 50 enriched tracks: `ClusterStaleness.isReady = false` → boost = 0 for all → no effect.

---

## Feature Flag Summary

```js
S.flags = {
  longMemory:         false,  // Phase 1: persistent track/artist TTL
  geminiEnrich:       false,  // Phase 2: load gemini-enriched.json
  portfolioReranker:  false,  // Phase 3: bucket-based ranking
  bridgePath:         false,  // Phase 4: cross-scene bridge candidates
  clusterStaleness:   false,  // Phase 5: cluster exploration boost
};
```

Toggle any flag from the browser console:
```js
S.flags.portfolioReranker = true; saveState();
```

---

## Rollback Procedure

Each flag is independent. To rollback Phase N:
1. Set `S.flags.<phase_flag> = false` in browser console
2. `saveState()` to persist
3. `Queue.refill()` immediately uses legacy path

No data is lost: LongMemory data persists and resumes when flag is re-enabled.

---

## Baseline Metrics Checklist

Before starting Phase 1, capture:
- [ ] Country entropy baseline (H_country)
- [ ] Scene entropy baseline (H_scene)
- [ ] Artist repeat rate baseline
- [ ] precision@10 proxy baseline
- [ ] Avg queue fill time baseline
- [ ] % batches with 0 bridge tracks (will be 100% before Phase 4)

After Phase 4 full rollout, targets:
- [ ] H_country ↑ ≥25%
- [ ] H_scene ↑ ≥20%
- [ ] Artist repeat rate ↓ ≥40%
- [ ] precision@10 maintained ±5%
- [ ] ≥1 new-country track per session ≥80% of sessions

---

## File Dependency Graph

```
app.js
  └─ engine/LongMemory.js       (Phase 1)
  └─ gemini-enriched.json       (Phase 2, loaded at runtime)
  └─ engine/PortfolioReranker.js (Phase 3)
       └─ engine/ClusterStaleness.js
  └─ engine/BridgePath.js       (Phase 4)
       └─ engine/SceneGraph.js
  └─ gemini-scenes.json         (Phase 4, generated offline)

gemini/client.js  (offline Node.js, never imported by app.js)
  └─ gemini/cache.js
  └─ gemini/prompts.js
```

---

## Build Setup (minimal)

```json
// package.json (add to project root)
{
  "scripts": {
    "build:engine": "tsc --project tsconfig.engine.json",
    "enrich":       "node gemini/client.js --enrich-liked",
    "bridge":       "node gemini/client.js --bridge-for"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "dependencies": {
    "better-sqlite3": "^9.0.0"
  }
}
```

```json
// tsconfig.engine.json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "outDir": "./dist",
    "strict": true,
    "declaration": true
  },
  "include": ["engine/**/*.ts", "gemini/**/*.ts"]
}
```

Engine modules compile to `dist/engine/*.js` and are loaded by `app.js` via:
```html
<script type="module" src="dist/engine/LongMemory.js"></script>
```
or bundled with esbuild for a single `engine.js`.
