import { BedrockClient } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

export const bedrock = new BedrockClient({});
export const bedrockRuntime = new BedrockRuntimeClient({});

export const API_KEY = process.env.API_KEY;
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL;
export const DEFAULT_EMBEDDING_MODEL = process.env.DEFAULT_EMBEDDING_MODEL || 'cohere.embed-multilingual-v3';
export const ENABLE_CROSS_REGION = process.env.ENABLE_CROSS_REGION_INFERENCE !== 'false';
export const ENABLE_APP_PROFILES = process.env.ENABLE_APPLICATION_INFERENCE_PROFILES !== 'false';

// Pattern-based mapping from Anthropic model names to Bedrock base model IDs.
const MODEL_PATTERNS = [
  // Claude 4.6
  { pattern: /^claude-opus-4-6/,              bedrock: 'anthropic.claude-opus-4-6-v1' },
  { pattern: /^claude-sonnet-4-6/,            bedrock: 'anthropic.claude-sonnet-4-6-v1' },
  // Claude 4.5
  { pattern: /^claude-(?:sonnet-)?4-5/,       bedrock: 'anthropic.claude-sonnet-4-5-v2:0' },
  { pattern: /^claude-haiku-4-5/,             bedrock: 'anthropic.claude-3-5-haiku-20241022-v1:0' },
  // Claude 4
  { pattern: /^claude-opus-4(?:-0)?(?:-|$)/,  bedrock: 'anthropic.claude-opus-4-0-v1:0' },
  { pattern: /^claude-sonnet-4(?:-0)?(?:-|$)/,bedrock: 'anthropic.claude-sonnet-4-v1:0' },
  // Claude 3.5
  { pattern: /^claude-3-5-sonnet/,            bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
  { pattern: /^claude-3-5-haiku/,             bedrock: 'anthropic.claude-3-5-haiku-20241022-v1:0' },
  // Claude 3
  { pattern: /^claude-3-opus/,                bedrock: 'anthropic.claude-3-opus-20240229-v1:0' },
  { pattern: /^claude-3-sonnet/,              bedrock: 'anthropic.claude-3-sonnet-20240229-v1:0' },
  { pattern: /^claude-3-haiku/,               bedrock: 'anthropic.claude-3-haiku-20240307-v1:0' },
];

// Runtime cache: base model ID → best available inference profile ID
// Built lazily on first resolveModel() call by querying ListInferenceProfiles
let _profileMap = null;

async function buildProfileMap() {
  if (_profileMap) return _profileMap;
  const { ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock');
  try {
    const response = await bedrock.send(new ListInferenceProfilesCommand({}));
    const map = new Map();
    for (const profile of response.inferenceProfileSummaries || []) {
      if (profile.type !== 'SYSTEM_DEFINED') continue;
      for (const model of profile.models || []) {
        const baseId = model.modelId;
        const existing = map.get(baseId);
        // Prefer global > us > eu > ap (broader routing = better availability)
        if (!existing || profile.inferenceProfileId.startsWith('global.')) {
          map.set(baseId, profile.inferenceProfileId);
        } else if (!existing.startsWith('global.') && profile.inferenceProfileId.startsWith('us.')) {
          map.set(baseId, profile.inferenceProfileId);
        }
      }
    }
    console.log(`Built inference profile map: ${map.size} models mapped`);
    _profileMap = map;
    return map;
  } catch (err) {
    console.error('Failed to load inference profiles:', err.message);
    _profileMap = new Map();
    return _profileMap;
  }
}

// Resolve model identifier to a valid Bedrock model/inference profile ID
// Supports: Bedrock IDs, ARNs, cross-region profiles, Anthropic model names (pattern-matched)
export async function resolveModel(requestedModel) {
  if (!requestedModel) return DEFAULT_MODEL;

  // Already a Bedrock inference profile, model ID with vendor prefix, or ARN — pass through
  if (requestedModel.includes('.') || requestedModel.startsWith('arn:')) {
    return requestedModel;
  }

  // Strip [1m] suffix that Claude Code appends for extended context
  const cleanName = requestedModel.replace(/\[1m\]$/, '');

  // Pattern match against known Anthropic model families
  for (const { pattern, bedrock: baseModelId } of MODEL_PATTERNS) {
    if (pattern.test(cleanName)) {
      // Look up the best inference profile for this base model
      const profileMap = await buildProfileMap();
      const profileId = profileMap.get(baseModelId);
      if (profileId) {
        console.log(`Mapped model "${requestedModel}" → ${profileId}`);
        return profileId;
      }
      // No inference profile found — model may not be enabled, fall back to DEFAULT_MODEL
      console.warn(`No inference profile found for "${baseModelId}" (from "${requestedModel}"), using default: ${DEFAULT_MODEL}`);
      return DEFAULT_MODEL;
    }
  }

  // Unknown non-Bedrock name — fall back to default
  console.log(`Model "${requestedModel}" is not a known model, using default: ${DEFAULT_MODEL}`);
  return DEFAULT_MODEL;
}
