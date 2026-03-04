/**
 * SceneGraph
 *
 * Lightweight adjacency graph of music scenes.
 * Populated from:
 *   1. Hardcoded seed graph (below)
 *   2. GeminiEnricher responses (scene_classification output)
 *   3. EveryNoise co-genre relationships (TODO)
 *
 * Used by:
 *   - BridgePath: find adjacent scenes in different countries
 *   - PortfolioReranker: adjacent_score
 *   - _passesGenreFilter context
 */

import type { SceneNode, CountryCode } from './types.js';

// ─── SEED GRAPH ───────────────────────────────────────────────────────────────
// Hand-curated adjacency for common discovery zones.
// Each scene knows its neighbors, typical countries, and eras.

const SEED_GRAPH: SceneNode[] = [
  {
    name: 'bossa nova',
    adjacent: ['samba', 'samba-soul', 'mpb', 'cool jazz', 'soul jazz', 'afro bossa'],
    countries: ['BR'],
    eras: ['1960s', '1970s'],
    cred: 0.95,
  },
  {
    name: 'samba-soul',
    adjacent: ['bossa nova', 'soul jazz', 'funk', 'afrobeat', 'mpb', 'deep funk'],
    countries: ['BR'],
    eras: ['1970s', '1980s'],
    cred: 0.90,
  },
  {
    name: 'afrobeat',
    adjacent: ['afro soul', 'highlife', 'funk', 'soul jazz', 'samba-soul', 'afro jazz'],
    countries: ['NG', 'GH', 'SN'],
    eras: ['1970s', '1980s'],
    cred: 0.92,
  },
  {
    name: 'ethio-jazz',
    adjacent: ['afrobeat', 'soul jazz', 'modal jazz', 'afro bossa', 'cumbia'],
    countries: ['ET'],
    eras: ['1960s', '1970s'],
    cred: 0.93,
  },
  {
    name: 'soul jazz',
    adjacent: ['hard bop', 'funk', 'bossa nova', 'afrobeat', 'blue note', 'gospel jazz'],
    countries: ['US'],
    eras: ['1960s', '1970s'],
    cred: 0.91,
  },
  {
    name: 'library music',
    adjacent: ['soundtrack', 'easy listening', 'lounge', 'exotica', 'krautrock', 'giallo'],
    countries: ['IT', 'FR', 'GB', 'DE'],
    eras: ['1960s', '1970s'],
    cred: 0.88,
  },
  {
    name: 'cumbia',
    adjacent: ['salsa', 'vallenato', 'chicha', 'latin soul', 'tropical'],
    countries: ['CO', 'MX', 'PE', 'AR'],
    eras: ['1960s', '1970s', '1980s'],
    cred: 0.87,
  },
  {
    name: 'spiritual jazz',
    adjacent: ['modal jazz', 'free jazz', 'post-bop', 'avant-garde', 'soul jazz'],
    countries: ['US'],
    eras: ['1960s', '1970s'],
    cred: 0.94,
  },
  {
    name: 'highlife',
    adjacent: ['afrobeat', 'palm wine', 'jùjú', 'afro soul', 'calypso'],
    countries: ['GH', 'NG'],
    eras: ['1950s', '1960s', '1970s'],
    cred: 0.85,
  },
  {
    name: 'tropicália',
    adjacent: ['mpb', 'bossa nova', 'psychedelic', 'folk', 'samba'],
    countries: ['BR'],
    eras: ['1960s', '1970s'],
    cred: 0.93,
  },
  {
    name: 'krautrock',
    adjacent: ['kosmische', 'electronic', 'ambient', 'prog', 'library music'],
    countries: ['DE'],
    eras: ['1970s'],
    cred: 0.91,
  },
  {
    name: 'balearic',
    adjacent: ['ambient', 'new age', 'world', 'lounge', 'acid jazz', 'cosmic disco'],
    countries: ['ES', 'GB', 'IT'],
    eras: ['1980s', '1990s'],
    cred: 0.82,
  },
];

// ─── SCENE GRAPH ─────────────────────────────────────────────────────────────

export class SceneGraph {
  private nodes: Map<string, SceneNode>;

  constructor(extraNodes: SceneNode[] = []) {
    this.nodes = new Map();
    for (const n of [...SEED_GRAPH, ...extraNodes]) {
      this.nodes.set(n.name, n);
    }
  }

  /** Add or update a node (called when GeminiEnricher returns scene data) */
  upsert(node: SceneNode): void {
    const existing = this.nodes.get(node.name);
    if (existing) {
      // Merge adjacency lists
      const adj = new Set([...existing.adjacent, ...node.adjacent]);
      this.nodes.set(node.name, { ...existing, ...node, adjacent: [...adj] });
    } else {
      this.nodes.set(node.name, node);
    }
  }

  /** Top N adjacent scenes, sorted by cred descending */
  adjacent(scene: string, n = 5): SceneNode[] {
    const node = this.nodes.get(scene);
    if (!node) return [];
    return node.adjacent
      .map(name => this.nodes.get(name))
      .filter((n): n is SceneNode => n != null)
      .sort((a, b) => b.cred - a.cred)
      .slice(0, n);
  }

  /**
   * Graph distance [0–1] between two scenes.
   * 0 = same scene, 0.5 = 1 hop, 1 = no path (or >3 hops).
   */
  distance(sceneA: string, sceneB: string): number {
    if (sceneA === sceneB) return 0;
    const nodeA = this.nodes.get(sceneA);
    if (!nodeA) return 1;
    if (nodeA.adjacent.includes(sceneB)) return 0.5;
    // 2-hop check
    for (const adj of nodeA.adjacent) {
      const nodeAdj = this.nodes.get(adj);
      if (nodeAdj?.adjacent.includes(sceneB)) return 0.75;
    }
    return 1;
  }

  /** Typical countries for a scene */
  countries(scene: string): CountryCode[] {
    return this.nodes.get(scene)?.countries ?? [];
  }

  /** Scene credibility prior (0–1) */
  cred(scene: string): number {
    return this.nodes.get(scene)?.cred ?? 0.5;
  }

  /**
   * Given a list of user's top scenes, find adjacent scenes in DIFFERENT countries.
   * These are ideal bridge targets.
   */
  bridgeScenes(topScenes: string[], topCountries: CountryCode[], n = 8): SceneNode[] {
    const dominatedCountries = new Set(topCountries);
    const seen = new Set(topScenes);
    const candidates: SceneNode[] = [];

    for (const scene of topScenes) {
      for (const adj of this.adjacent(scene, 10)) {
        if (seen.has(adj.name)) continue;
        // Must include at least one country not in the user's dominant set
        const hasForeignCountry = adj.countries.some(c => !dominatedCountries.has(c));
        if (hasForeignCountry) {
          candidates.push(adj);
          seen.add(adj.name);
        }
      }
    }

    return candidates.sort((a, b) => b.cred - a.cred).slice(0, n);
  }
}
