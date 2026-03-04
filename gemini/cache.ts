/**
 * Gemini SQLite Cache
 *
 * Caches Gemini API responses by (fingerprint = SHA256(input + prompt_version)).
 * Prevents re-querying for the same track/artist enrichment.
 *
 * Requires: better-sqlite3 (npm install better-sqlite3)
 * Usage: Node.js only (offline enrichment service)
 *
 * Schema:
 *   gemini_cache(id, fingerprint, prompt_version, prompt_type,
 *                input_json, output_json, created_at, model, tokens_used)
 */

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { GeminiCacheEntry, GeminiPromptType } from '../engine/types.js';
import { PROMPT_VERSIONS } from './prompts.js';

// Cache TTLs per prompt type (ms)
const CACHE_TTL: Record<GeminiPromptType, number> = {
  style_extraction:     90 * 24 * 3600 * 1000,  // 90 days
  scene_classification: 90 * 24 * 3600 * 1000,
  bridge_suggestion:    30 * 24 * 3600 * 1000,  // 30 days (suggestions evolve)
  quality_assessment:   90 * 24 * 3600 * 1000,
};

export class GeminiCache {
  private db: Database.Database;

  constructor(dbPath = './gemini-cache.db') {
    this.db = new Database(dbPath);
    this._init();
  }

  private _init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gemini_cache (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint    TEXT UNIQUE NOT NULL,
        prompt_version TEXT NOT NULL,
        prompt_type    TEXT NOT NULL,
        input_json     TEXT NOT NULL,
        output_json    TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        model          TEXT NOT NULL,
        tokens_used    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_fingerprint ON gemini_cache(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_created_at  ON gemini_cache(created_at);
    `);
  }

  // ── FINGERPRINT ─────────────────────────────────────────────────────────────

  static fingerprint(promptType: GeminiPromptType, input: object): string {
    const version = PROMPT_VERSIONS[promptType];
    const payload = JSON.stringify({ promptType, version, input });
    return createHash('sha256').update(payload).digest('hex');
  }

  // ── READ ────────────────────────────────────────────────────────────────────

  get(promptType: GeminiPromptType, input: object): object | null {
    const fp = GeminiCache.fingerprint(promptType, input);
    const ttl = CACHE_TTL[promptType];
    const cutoff = Date.now() - ttl;

    const row = this.db.prepare(
      'SELECT * FROM gemini_cache WHERE fingerprint = ? AND created_at > ?'
    ).get(fp, cutoff) as GeminiCacheEntry | undefined;

    if (!row) return null;

    // Version check: if prompt was updated, invalidate
    if (row.prompt_version !== PROMPT_VERSIONS[promptType]) {
      this.delete(fp);
      return null;
    }

    try {
      return JSON.parse(row.output_json);
    } catch {
      return null;
    }
  }

  // ── WRITE ────────────────────────────────────────────────────────────────────

  set(
    promptType: GeminiPromptType,
    input: object,
    output: object,
    model: string,
    tokensUsed: number,
  ): void {
    const fp = GeminiCache.fingerprint(promptType, input);
    this.db.prepare(`
      INSERT OR REPLACE INTO gemini_cache
        (fingerprint, prompt_version, prompt_type, input_json, output_json, created_at, model, tokens_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fp,
      PROMPT_VERSIONS[promptType],
      promptType,
      JSON.stringify(input),
      JSON.stringify(output),
      Date.now(),
      model,
      tokensUsed,
    );
  }

  // ── DELETE ───────────────────────────────────────────────────────────────────

  delete(fingerprint: string): void {
    this.db.prepare('DELETE FROM gemini_cache WHERE fingerprint = ?').run(fingerprint);
  }

  // ── MAINTENANCE ──────────────────────────────────────────────────────────────

  /** Remove all entries older than their TTL */
  prune(): number {
    let deleted = 0;
    for (const [type, ttl] of Object.entries(CACHE_TTL) as [GeminiPromptType, number][]) {
      const cutoff = Date.now() - ttl;
      const result = this.db.prepare(
        'DELETE FROM gemini_cache WHERE prompt_type = ? AND created_at < ?'
      ).run(type, cutoff);
      deleted += result.changes;
    }
    return deleted;
  }

  /** Token usage stats */
  stats(): { totalRequests: number; totalTokens: number; oldestEntry: number | null } {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt, SUM(tokens_used) as tokens, MIN(created_at) as oldest FROM gemini_cache'
    ).get() as { cnt: number; tokens: number; oldest: number | null };
    return { totalRequests: row.cnt, totalTokens: row.tokens ?? 0, oldestEntry: row.oldest };
  }

  close(): void {
    this.db.close();
  }
}
