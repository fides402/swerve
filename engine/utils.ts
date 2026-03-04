/**
 * Shared math utilities for the engine modules.
 */

import type { SwerveTrack, StyleEmbedding, ExposureHistory } from './types.js';

// ─── VECTOR MATH ─────────────────────────────────────────────────────────────

export function cosineSim(a: StyleEmbedding, b: StyleEmbedding): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function vecMean(vecs: StyleEmbedding[]): StyleEmbedding | null {
  if (!vecs.length) return null;
  const dim = vecs[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

export function l2Norm(v: StyleEmbedding): StyleEmbedding {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return mag === 0 ? v : v.map(x => x / mag);
}

// ─── QUALITY ─────────────────────────────────────────────────────────────────

const RARE_TAGS = new Set([
  'rare groove','library music','spiritual jazz','jazz-funk','soul-jazz',
  'bossa nova','afrobeat','afro soul','ethio-jazz','free jazz','avant-garde',
  'modal jazz','post-bop','film music','soundtrack','library','easy listening',
  'psych','psychedelic soul','deep funk','funk','giallo','spaghetti western',
  'krautrock','groove','rare soul','northern soul','acid jazz',
]);

/**
 * Composite quality score [0–1].
 * Falls back gracefully when qualitySignals are absent.
 */
export function curatedQuality(track: SwerveTrack): number {
  const qs = track.qualitySignals;
  if (!qs) {
    // Legacy fallback: rare tag heuristic only
    const rareCount = 0; // TODO: pass enrichCache if available
    return Math.min(0.3 + rareCount * 0.12, 1.0);
  }
  return (
    0.30 * Math.min(1, qs.rareTagCount * 0.15 + 0.1) +
    0.20 * qs.sceneCred              +
    0.20 * qs.labelCred              +
    0.20 * qs.coListenerScore        +
    0.10 * (qs.isOriginal ? 1 : 0)
  );
}

// ─── FRESHNESS ────────────────────────────────────────────────────────────────

/**
 * Freshness score [0–1] based on exposure history.
 * 1 = never seen, 0 = seen very recently.
 */
export function freshness(track: SwerveTrack, exposure: ExposureHistory): number {
  const artistKey = track.a?.toLowerCase().trim() ?? '';
  const artistExp = artistKey ? exposure.artists[artistKey] : null;
  if (!artistExp) return 1.0;

  // Artist cooldown: penalise linearly over 30d
  const age = Date.now() - artistExp.lastSeen;
  const thirtyDays = 30 * 24 * 3600 * 1000;
  if (age >= thirtyDays) return 1.0;
  return age / thirtyDays;
}

// ─── SHA256 FINGERPRINT (for Gemini cache keys) ───────────────────────────────

export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
