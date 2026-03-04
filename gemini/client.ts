/**
 * GeminiEnricher — Async Offline Enrichment Service
 *
 * Node.js service (run separately from the browser app).
 * Enriches tracks/artists with style attributes, scene classification,
 * bridge suggestions, and quality signals via Gemini AI.
 *
 * Usage:
 *   npx ts-node gemini/client.ts --enrich-liked
 *   npx ts-node gemini/client.ts --bridge-for "João Gilberto,Astrud Gilberto"
 *
 * Outputs are written to a shared JSON file that app.js reads
 * (or to a local SQLite DB, depending on migration phase).
 */

import { GeminiCache } from './cache.js';
import { buildPrompt, PROMPT_VERSIONS } from './prompts.js';
import type {
  GeminiPromptType, GeminiStyleOutput, GeminiBridgeOutput,
  SwerveTrack, ArtistMeta,
} from '../engine/types.js';
import type {
  StyleExtractionInput, SceneClassificationInput, BridgeSuggestionInput,
} from './prompts.js';

const GEMINI_API_KEY = 'AIzaSyDPJwhIY4J0Q0UEK1U6haPg_Xkf6OHpJV8';
const GEMINI_MODEL   = 'gemini-2.0-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ─── RATE LIMITER ─────────────────────────────────────────────────────────────

class RateLimiter {
  private tokens:    number;
  private maxTokens: number;
  private refillRate: number;   // tokens per ms
  private lastRefill: number;
  private dailyCount:  number;
  private dailyLimit:  number;
  private dayStart:    number;

  constructor(maxPerMin = 55, dailyLimit = 500) {
    this.maxTokens  = maxPerMin;
    this.tokens     = maxPerMin;
    this.refillRate = maxPerMin / 60_000;
    this.lastRefill = Date.now();
    this.dailyCount = 0;
    this.dailyLimit = dailyLimit;
    this.dayStart   = Date.now();
  }

  private _refill(): void {
    const now  = Date.now();
    const diff = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + diff * this.refillRate);
    this.lastRefill = now;

    // Reset daily counter at midnight
    if (now - this.dayStart > 86_400_000) {
      this.dailyCount = 0;
      this.dayStart = now;
    }
  }

  async acquire(): Promise<void> {
    this._refill();
    if (this.dailyCount >= this.dailyLimit) {
      throw new Error(`Daily Gemini request limit (${this.dailyLimit}) reached.`);
    }
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise(r => setTimeout(r, waitMs));
      this._refill();
    }
    this.tokens -= 1;
    this.dailyCount += 1;
  }
}

// ─── GEMINI CLIENT ────────────────────────────────────────────────────────────

export class GeminiEnricher {
  private cache:       GeminiCache;
  private rateLimiter: RateLimiter;

  constructor(dbPath = './gemini-cache.db') {
    this.cache       = new GeminiCache(dbPath);
    this.rateLimiter = new RateLimiter(55, 500);
  }

  // ── CORE API CALL ──────────────────────────────────────────────────────────

  private async _call(prompt: string, promptType: GeminiPromptType): Promise<{ text: string; tokens: number }> {
    await this.rateLimiter.acquire();

    let attempt = 0;
    const maxAttempts = 4;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const resp = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature:     0.1,   // low temp for structured extraction
              maxOutputTokens: 1024,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (resp.status === 429) {
          // Rate limited by server: exponential backoff
          const wait = Math.pow(2, attempt) * 1000;
          console.warn(`Gemini 429. Waiting ${wait}ms (attempt ${attempt}/${maxAttempts})`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        if (!resp.ok) {
          throw new Error(`Gemini API error: ${resp.status} ${resp.statusText}`);
        }

        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const tokens = data.usageMetadata?.totalTokenCount ?? 0;
        return { text, tokens };

      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }

    throw new Error('Gemini call failed after max retries');
  }

  // ── CACHED CALL ────────────────────────────────────────────────────────────

  private async _cachedCall<T>(
    promptType: GeminiPromptType,
    input: object,
    parser: (text: string) => T,
  ): Promise<T | null> {
    // Check cache first
    const cached = this.cache.get(promptType, input);
    if (cached) return cached as T;

    try {
      const prompt = buildPrompt(promptType, input);
      const { text, tokens } = await this._call(prompt, promptType);
      const parsed = parser(text);
      this.cache.set(promptType, input, parsed as object, GEMINI_MODEL, tokens);
      return parsed;
    } catch (err) {
      console.error(`GeminiEnricher [${promptType}] failed:`, err);
      return null;
    }
  }

  private _parseJSON<T>(text: string): T {
    // Strip markdown code fences if present
    const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(clean) as T;
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────

  /** Extract style attributes for a single track */
  async enrichTrack(track: SwerveTrack): Promise<GeminiStyleOutput | null> {
    if (track.pop > 50) return null;  // cost control: skip mainstream

    const input: StyleExtractionInput = {
      title:  track.t,
      artist: track.a,
      album:  track.al,
    };

    return this._cachedCall('style_extraction', input, text =>
      this._parseJSON<GeminiStyleOutput>(text)
    );
  }

  /** Classify an artist's scene */
  async classifyArtist(artist: string, meta: Partial<SceneClassificationInput> = {}): Promise<ArtistMeta | null> {
    const input: SceneClassificationInput = { artist, ...meta };
    const result = await this._cachedCall('scene_classification', input, text =>
      this._parseJSON(text)
    );
    if (!result) return null;
    const r = result as Record<string, unknown>;
    return {
      name:      artist,
      sceneTags: [r['primary_scene'] as string, ...(r['secondary_scenes'] as string[] ?? [])].filter(Boolean),
      country:   r['country'] as string,
      era:       r['era'] as string,
      qualityCred: r['scene_cred'] as number,
      enrichedAt: Date.now(),
    };
  }

  /** Get bridge artist suggestions for the given profile */
  async getBridgeSuggestions(input: BridgeSuggestionInput): Promise<GeminiBridgeOutput | null> {
    return this._cachedCall('bridge_suggestion', input, text =>
      ({ bridge_candidates: this._parseJSON(text), reasoning: '' }) as GeminiBridgeOutput
    );
  }

  // ── BATCH ENRICHMENT ──────────────────────────────────────────────────────

  /**
   * Enrich a batch of tracks (fire-and-forget style, respects rate limit).
   * Calls enrichTrack for each, writes results to outputPath.
   *
   * TODO: wire output to app.js via shared JSON file or IPC
   */
  async enrichBatch(tracks: SwerveTrack[], outputPath = './gemini-enriched.json'): Promise<void> {
    const results: Record<string, GeminiStyleOutput> = {};
    let done = 0;

    for (const t of tracks) {
      const key = `${t.a.toLowerCase().trim()}|${t.t.toLowerCase().trim()}`;
      console.log(`[${++done}/${tracks.length}] Enriching: ${t.a} — ${t.t}`);

      const output = await this.enrichTrack(t);
      if (output) results[key] = output;

      // Small delay between calls even with rate limiter
      await new Promise(r => setTimeout(r, 100));
    }

    const { writeFile } = await import('fs/promises');
    await writeFile(outputPath, JSON.stringify(results, null, 2));
    console.log(`\nWrote ${Object.keys(results).length} enriched entries to ${outputPath}`);
  }

  // ── MAINTENANCE ────────────────────────────────────────────────────────────

  stats() {
    return this.cache.stats();
  }

  pruneCache(): number {
    return this.cache.prune();
  }

  close(): void {
    this.cache.close();
  }
}

// ─── CLI ENTRY POINT ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const enricher = new GeminiEnricher();

  if (args[0] === '--stats') {
    console.log('Cache stats:', enricher.stats());
    return;
  }

  if (args[0] === '--prune') {
    const n = enricher.pruneCache();
    console.log(`Pruned ${n} stale cache entries.`);
    return;
  }

  if (args[0] === '--bridge-for' && args[1]) {
    const artists = args[1].split(',').map(s => s.trim());
    const result = await enricher.getBridgeSuggestions({
      styleSummary:   'warm groove, high harmonic complexity, contemplative mood',
      topScenes:      ['bossa nova', 'soul jazz'],
      topCountries:   ['BR', 'US'],
      topArtists:     artists,
      avoidCountries: ['BR', 'US'],
      avoidScenes:    ['bossa nova', 'samba'],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`
Usage:
  npx ts-node gemini/client.ts --stats
  npx ts-node gemini/client.ts --prune
  npx ts-node gemini/client.ts --bridge-for "Artist1,Artist2"
  `);

  enricher.close();
}

// Run if invoked directly
if (process.argv[1]?.endsWith('client.ts') || process.argv[1]?.endsWith('client.js')) {
  main().catch(console.error);
}
