/**
 * Deterministic identity-confidence rules — never trusted from an LLM
 * guess, computed the SAME way for every discovery path that writes to
 * GroundingResearchResult (see that model's own header):
 *   - services/vertexGroundingDiscoveryService.js's search()/merge (Vertex +
 *     OpenAI public-web evidence, discoveryMode "public_web_evidence").
 *   - services/leadGenerationCoordinatorService.js's mergeIcpMatchCandidate()
 *     (Apollo/PDL structured ICP matches, discoveryMode "icp_match").
 *   - services/publicWebDiscoveryEngineService.js's mergeDiscoveryCandidate()
 *     (the high-volume search-family engine, discoveryMode
 *     "public_web_high_volume" — the engine every scheduled run and Jarvis
 *     chat's own lead search go through as of this session's consolidation).
 * Extracted into its own module specifically so the third path above can
 * reuse it without requiring vertexGroundingDiscoveryService.js itself,
 * which that file's own header explicitly documents as something it
 * deliberately never calls into (its orchestration, dedup, and freshness-
 * gate logic stay fully separate) — this is a pure, stateless, side-effect-
 * free scoring function, not orchestration, so sharing it doesn't violate
 * that boundary.
 *
 * Categories:
 *   - "conflict": providers disagree on a material identity field.
 *   - "high": strong identity agreement from multiple INDEPENDENT
 *     providers, or a verified contact/profile identifier that
 *     consistently matches name and company.
 *   - "medium": one provider with strong matching public evidence
 *     (independently-corroborated citations) or sufficiently complete
 *     matching identifiers (e.g. a LinkedIn profile plus organization).
 *   - "low": one uncorroborated structured record, or incomplete
 *     identifiers.
 * A row found by two independent providers — regardless of which two, AI
 * web search or structured people-data vendors — must never be left at the
 * schema's "low" default. A row that never runs through this function (or
 * whose providers/confidence/conflicts never change) simply never gets
 * upgraded, which is the exact bug this function exists to fix.
 */
function computeIdentityConfidence({ providers = [], confidence, conflicts = [], linkedinUrl = "", organizationName = "", verifiedIdentifier = false }) {
  if ((conflicts || []).length) return "conflict";
  const uniqueProviderCount = new Set(providers).size;
  const hasCompleteIdentifiers = Boolean(linkedinUrl) && Boolean(organizationName);
  if (uniqueProviderCount >= 2 || verifiedIdentifier) return "high";
  if (confidence === "corroborated" || hasCompleteIdentifiers) return "medium";
  return "low";
}

module.exports = { computeIdentityConfidence };
