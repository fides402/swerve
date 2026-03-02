# PROJECT_CONTEXT.md — SWERVE Music Discovery App

## 1. Project Purpose
SWERVE is a single-page music discovery app. Users swipe through "cards" of tracks to discover rare/obscure music — especially '70s OST, Soul, and Jazz. Liked tracks are saved to a personal library. The app streams from Tidal (via an unofficial proxy API) and learns the user's taste over time.

## 2. File Structure

```
neu/
├── index.html          — entire app (CSS + HTML structure + embedded catalog JSON)
├── app.js              — all JavaScript logic (no build step, no framework)
├── liked.csv           — Spotify export of user's liked tracks (input data)
├── tracks-data.json    — parsed version of liked.csv (791 tracks)
├── parse-csv.mjs       — Node script: converts liked.csv → tracks-data.json
├── inject-data.mjs     — Node script: injects tracks-data.json into index.html
└── .claude/
    ├── launch.json     — dev server config
    └── settings.local.json
```

## 3. Tech Stack
- **Vanilla JS** (ES2020+, `'use strict'`, no bundler, no framework)
- **HTML/CSS** embedded in `index.html` (~1100 lines CSS)
- **Node.js scripts** (`parse-csv.mjs`, `inject-data.mjs`) for one-time data prep
- **APIs**:
  - `https://api.monochrome.tf` — unofficial Tidal proxy (search, recommendations, stream URLs, lyrics)
  - `https://api.discogs.com` — music database for genre-accurate rare track discovery
- **localStorage** key: `swerve_v2` — full app state persistence

## 4. Architecture

### Data Flow
```
liked.csv → parse-csv.mjs → tracks-data.json → inject-data.mjs → index.html#catalog-data
                                                                         ↓
                                                              CATALOG constant (791 tracks)
```

### Discovery Pipeline (Preset modes: OST '70, Soul '70, Jazz '70)
```
DiscogsEngine.getTracks(presetId)
  → Discogs /database/search (genre/style/country/year filtered, rare: 5≤have<500)
  → For each release: Discogs /releases/{id} (get tracklist)
  → For each track: Tidal search (API.search)
  → Push to S.queue
```

### Discovery Pipeline (General mode)
```
Queue.refill() → _likedSeeds(5) selects random liked tracks
  → API.getRecommendations(seedId) (Tidal similarity)
  → Filter by RARE_POP_MAX=40, seen, taste engine
  → Push to S.queue
```

### Core Modules (all in app.js)
| Module | Purpose |
|---|---|
| `S` (state object) | All mutable app state, persisted to localStorage |
| `DiscogsEngine` | Fetches rare tracks per preset via Discogs API |
| `Taste` | Records likes/skips, scores tracks, picks recommendation seeds |
| `Queue` | Manages discovery queue, triggers refill |
| `Player` | Audio playback (HLS/DASH stream → Spotify preview fallback) |
| `API` | Tidal proxy client (search, recommendations, stream, lyrics) |

## 5. State Object (`S`)
```js
{
  queue: [],                // discovery queue
  seenIds: new Set(),       // tracks already shown (persisted as array)
  currentCardTrack: null,
  currentCardLiked: false,  // two-stage like flag
  lastSkipped: null,        // for undo
  myLiked: [],              // user's library
  mySkipped: [],
  playlists: [],
  activePreset: 'general',  // 'general'|'ost-70'|'soul-70'|'jazz-70'
  taste: {
    artists: {},            // artist → {liked, skipped}
    decades: {},            // decade → {liked, skipped}
    seeds: [],              // [{id, weight, title}] top 60 tracks
    total: 0,
  },
  recentArtists: [],        // rolling cooldown buffer (max 150), persisted
  discogsWeights: {},       // {presetId: {cfgIdx: weight}} — taste feedback
  tidalIdCache: {},         // spotifyId → tidalId
  player: { track, queue, idx, vol, shuffle, repeat, isPlaying }
}
```

## 6. Preset Discovery (DiscogsEngine)

### Config Groups
Each preset has `DISCOGS_CONFIGS[presetId]` — an array of search configs with a `g` group tag. On each `getTracks()` call:
1. Group all configs by `g`
2. Shuffle groups, pick 3 different groups
3. Within each group, pick 1 config via **weighted random** (likes boost weight)
4. Fetch a **random page (1-25)** from Discogs for that config
5. Filter: `5 ≤ community.have < 500` (rare but findable on Tidal)

### Groups per preset
- **ost-70**: it, fr, de, jp, es, eeu, uk, world, lib (9 groups)
- **soul-70**: deep, funk, rnb, philly, uk, world, jazz-soul (7 groups)
- **jazz-70**: avant, modal, latin, jp, eu-south, eu-west, eu-north, fusion, eeu, world (10 groups)

### Artist Cooldown
`S.recentArtists[]` — rolling buffer of last 150 served artists. An artist is skipped if found within the first 60 positions. This prevents artist repetition across sessions.

## 7. Key Constants
```js
QUEUE_REFILL_AT = 20       // trigger refill when queue drops below this
QUEUE_TARGET    = 60       // target queue size after refill
RARE_POP_MAX    = 40       // Tidal popularity ceiling (0-100)
DISCOGS_HAVE_MAX = 500     // Discogs community.have ceiling
ARTIST_COOLDOWN  = 60      // slots before an artist re-enters rotation
API_TIMEOUT      = 9000    // fetch timeout in ms
```

## 8. UI Structure
- **Sidebar** (60px): logo, nav (Discover/Library/Playlists), liked-count pill
- **Discover view**: seed info bar, preset buttons, swipeable card stack, action buttons (undo/skip/listen-now/like), queue counter
- **Library view**: search, filter tabs (all/catalog/discovered), list rows with play/similar/add buttons
- **Playlists view**: grid of playlists, detail view
- **Mini player bar** (76px, bottom): always visible when playing
- **Full player overlay**: large art, lyrics/queue panels
- **Toast** notifications, **modals** for playlist creation

## 9. Completed Features
- [x] Swipeable card stack (drag/touch/keyboard)
- [x] Two-stage like: ❤️ once = save+stay, ❤️ twice = advance; swipe-right = immediate
- [x] Skip with undo (last skipped track recoverable)
- [x] Auto-play when card appears (Player.setQueue on card change)
- [x] Preset modes (OST/Soul/Jazz via Discogs, genre-accurate)
- [x] General mode (Tidal recommendations seeded from liked library)
- [x] Artist cooldown (cross-session, 60-slot rolling window)
- [x] Discogs group-based diversity (3 groups per refill, random pages)
- [x] Taste engine (weighted artist/decade/seed scoring)
- [x] Rarity filter (pop≤40, Discogs have 5-500)
- [x] Library as list rows with hover actions
- [x] Library + button always visible (outside hover-opacity container)
- [x] Playlists with add/remove/play
- [x] Full player with synced lyrics
- [x] Proactive queue refill in renderCardStack
- [x] Persistent state (localStorage `swerve_v2`)

## 10. Known Constraints & Decisions
- **No build step**: everything runs directly from `index.html` + `app.js` in browser
- **Tidal API is unofficial** (`api.monochrome.tf` proxy) — may break without warning
- **Discogs rate limits**: `sleep(350)` between release fetches, `sleep(130)` between Tidal searches
- **CATALOG is injected at build time**: run `node parse-csv.mjs && node inject-data.mjs` after updating `liked.csv`
- **Genre purity for presets**: Discogs search params enforce genre/style — never mix OST/Soul/Jazz configs
- **General mode never uses Discogs** (seed-based Tidal recs only)
- **Spotify previews as fallback**: if Tidal stream fails, falls back to `track.pre` (30s preview)
- **Italian UI language** throughout

## 11. Build / Run
```bash
# One-time data prep (after updating liked.csv):
node parse-csv.mjs
node inject-data.mjs

# Serve (any static server works):
npx serve .   # or python -m http.server
# Then open index.html in browser
```
