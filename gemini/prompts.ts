/**
 * Gemini Prompt Templates
 *
 * Each prompt is versioned. Bumping the version invalidates cached responses
 * for that prompt type.
 */

import type { GeminiPromptType } from '../engine/types.js';

export const PROMPT_VERSIONS: Record<GeminiPromptType, string> = {
  style_extraction:    'style_v1',
  scene_classification:'scene_v1',
  bridge_suggestion:   'bridge_v1',
  quality_assessment:  'quality_v1',
};

// ─── STYLE EXTRACTION ─────────────────────────────────────────────────────────

export interface StyleExtractionInput {
  title:    string;
  artist:   string;
  album?:   string;
  year?:    string | number;
  tags?:    string[];   // Last.fm tags
  similar?: string[];   // similar artists from LFM
}

export function buildStyleExtractionPrompt(input: StyleExtractionInput): string {
  return `You are a music metadata expert. Analyze the following track and return a JSON object with style attributes.

Track: "${input.title}" by ${input.artist}${input.album ? ` from the album "${input.album}"` : ''}${input.year ? ` (${input.year})` : ''}
${input.tags?.length ? `Known tags: ${input.tags.join(', ')}` : ''}
${input.similar?.length ? `Similar artists: ${input.similar.slice(0, 5).join(', ')}` : ''}

Return ONLY valid JSON matching this schema:
{
  "groove": <float 0-1, rhythmic density and swing feel>,
  "harmony": <float 0-1, harmonic complexity, 0=simple/folk, 1=complex/jazz>,
  "feel": <array of strings, e.g. ["warm", "melancholic", "intimate"]>,
  "instrumentation": <array of key instruments, e.g. ["acoustic guitar", "Rhodes", "upright bass"]>,
  "mood": <array of mood descriptors, e.g. ["contemplative", "nostalgic"]>,
  "era": <string, one of: "1950s","1960s","1970s","1980s","1990s","2000s","2010s","2020s">,
  "scene": <string, primary music scene, e.g. "bossa nova", "soul jazz", "afrobeat">,
  "tempo_feel": <string, one of: "laid-back", "mid-tempo", "driving">,
  "country": <string, ISO 3166-1 alpha-2 country code of origin, e.g. "BR","NG","JP">,
  "language": <string, BCP-47 language code if vocal, e.g. "pt-BR","yo","en", or "instrumental">,
  "label_type": <string, one of: "boutique-indie","major-indie","major","private-press","self-released","unknown">,
  "confidence": <float 0-1, your confidence in this extraction>
}

Rules:
- Be precise with country: use the artist's country of origin, not where they recorded.
- For "scene", use the most specific accurate label (e.g. "samba-soul" not just "samba").
- Do not hallucinate. If uncertain about a field, use null.
- Return ONLY the JSON, no explanation.`;
}

// ─── SCENE CLASSIFICATION ─────────────────────────────────────────────────────

export interface SceneClassificationInput {
  artist:      string;
  tags?:       string[];
  similar?:    string[];
  topTracks?:  string[];
  country?:    string;
}

export function buildSceneClassificationPrompt(input: SceneClassificationInput): string {
  return `You are a music historian and scene expert. Classify the following artist.

Artist: ${input.artist}
${input.country ? `Country: ${input.country}` : ''}
${input.tags?.length ? `Tags: ${input.tags.join(', ')}` : ''}
${input.similar?.length ? `Similar artists: ${input.similar.slice(0, 8).join(', ')}` : ''}
${input.topTracks?.length ? `Notable tracks: ${input.topTracks.slice(0, 5).join(', ')}` : ''}

Return ONLY valid JSON:
{
  "primary_scene": <string, most specific scene label>,
  "secondary_scenes": <array of strings, up to 3 other applicable scenes>,
  "country": <string, ISO 3166-1 alpha-2>,
  "region": <string, more specific region if relevant, e.g. "West Africa", "Rio de Janeiro">,
  "era": <string, primary era of activity>,
  "label_type": <string, one of: "boutique-indie","major-indie","major","private-press","self-released","unknown">,
  "scene_cred": <float 0-1, how well-regarded in their scene>,
  "influences": <array of strings, 2-4 key influences>,
  "confidence": <float 0-1>
}

Return ONLY the JSON.`;
}

// ─── BRIDGE SUGGESTION ────────────────────────────────────────────────────────

export interface BridgeSuggestionInput {
  styleSummary:   string;  // e.g. "warm, rhythmic, harmonic complexity 0.7, groove 0.8"
  topScenes:      string[];
  topCountries:   string[];
  topArtists:     string[];
  avoidCountries: string[];
  avoidScenes:    string[];
}

export function buildBridgeSuggestionPrompt(input: BridgeSuggestionInput): string {
  return `You are a world music curator specializing in cross-cultural discovery.

User's music profile:
- Aesthetic: ${input.styleSummary}
- Favourite scenes: ${input.topScenes.join(', ')}
- Favourite countries: ${input.topCountries.join(', ')}
- Liked artists (sample): ${input.topArtists.slice(0, 6).join(', ')}

The user wants to discover music that:
1. Matches their AESTHETIC (same groove, harmony, feel, mood)
2. Comes from DIFFERENT countries/scenes/eras than what they already know
3. Should NOT be from: ${input.avoidCountries.join(', ')} (countries) or ${input.avoidScenes.join(', ')} (scenes)

Suggest exactly 8 artist/scene combinations as bridges. Each must be genuinely different from the user's current taste geographically or scenically, but aesthetically parallel.

Return ONLY valid JSON array:
[
  {
    "artist": <string, real artist name>,
    "scene": <string, their music scene>,
    "country": <string, ISO 3166-1 alpha-2>,
    "era": <string>,
    "why_bridge": <string, 1-sentence explanation of aesthetic parallel>,
    "confidence": <float 0-1>
  },
  ...
]

Examples of good bridges for a "bossa nova / soul jazz / Brazil" profile:
- Mulatu Astatke (ethio-jazz, ET) — same contemplative groove, different continent
- Hedi Jouini (Mediterranean soul, TN) — same warmth and harmony, North Africa
- Hailu Mergia (ET) — groove and keys, completely different geography

Return ONLY the JSON array.`;
}

// ─── QUALITY ASSESSMENT ───────────────────────────────────────────────────────

export interface QualityAssessmentInput {
  artist:  string;
  title:   string;
  label?:  string;
  year?:   string | number;
  scene?:  string;
}

export function buildQualityAssessmentPrompt(input: QualityAssessmentInput): string {
  return `Assess the cultural/scene credibility of this track for a discerning music listener.

Track: "${input.title}" by ${input.artist}
${input.label ? `Label: ${input.label}` : ''}
${input.year ? `Year: ${input.year}` : ''}
${input.scene ? `Scene: ${input.scene}` : ''}

Return ONLY valid JSON:
{
  "scene_cred": <float 0-1, how respected in its scene>,
  "label_cred": <float 0-1, label prestige (1=boutique/revered, 0=major/commercial)>,
  "is_essential": <boolean, canonical track for the scene>,
  "obscurity": <float 0-1, how under-known (1=very obscure, 0=mainstream)>,
  "notes": <string, brief 1-sentence note>,
  "confidence": <float 0-1>
}

Return ONLY the JSON.`;
}

// ─── PROMPT BUILDER (dispatcher) ─────────────────────────────────────────────

export function buildPrompt(type: GeminiPromptType, input: unknown): string {
  switch (type) {
    case 'style_extraction':    return buildStyleExtractionPrompt(input as StyleExtractionInput);
    case 'scene_classification':return buildSceneClassificationPrompt(input as SceneClassificationInput);
    case 'bridge_suggestion':   return buildBridgeSuggestionPrompt(input as BridgeSuggestionInput);
    case 'quality_assessment':  return buildQualityAssessmentPrompt(input as QualityAssessmentInput);
  }
}
