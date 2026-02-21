import { ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { bedrock, ENABLE_CROSS_REGION, ENABLE_APP_PROFILES } from '../lib/bedrock.mjs';

// Model ID patterns for non-text models to exclude from inference profiles
const NON_TEXT_MODEL_PATTERNS = [
  /^stability\./,       // Image generation (Stable Diffusion)
  /^amazon\.titan-image/,// Titan Image Generator
  /^amazon\.titan-embed/,// Titan Embeddings
  /^cohere\.embed/,      // Cohere Embeddings
  /^amazon\.nova-reel/,  // Video generation
  /^amazon\.nova-canvas/,// Image generation
];

function isTextModel(modelId) {
  return !NON_TEXT_MODEL_PATTERNS.some(p => p.test(modelId));
}

export async function handleModels() {
  const models = [];
  const currentTimestamp = Math.floor(Date.now() / 1000);

  // Only list TEXT output models that support ON_DEMAND inference
  const fmResponse = await bedrock.send(new ListFoundationModelsCommand({
    byOutputModality: 'TEXT',
    byInferenceType: 'ON_DEMAND',
  }));
  const textModelIds = new Set();
  for (const model of fmResponse.modelSummaries || []) {
    // Double-check: must have TEXT in output modalities and support streaming
    if (model.outputModalities?.includes('TEXT')) {
      textModelIds.add(model.modelId);
      models.push({ id: model.modelId, object: 'model', created: currentTimestamp, owned_by: model.providerName || 'bedrock' });
    }
  }

  if (ENABLE_CROSS_REGION || ENABLE_APP_PROFILES) {
    const ipResponse = await bedrock.send(new ListInferenceProfilesCommand({}));
    for (const profile of ipResponse.inferenceProfileSummaries || []) {
      const isAppProfile = profile.type === 'APPLICATION';
      const isCrossRegion = profile.type === 'SYSTEM_DEFINED';
      if ((!isAppProfile || !ENABLE_APP_PROFILES) && (!isCrossRegion || !ENABLE_CROSS_REGION)) continue;

      // Check if the profile's underlying model(s) are text models
      const profileModels = profile.models || [];
      const hasTextModel = profileModels.some(m => textModelIds.has(m.modelId) || isTextModel(m.modelId));
      if (!hasTextModel && profileModels.length > 0) continue;

      const id = isAppProfile ? profile.inferenceProfileArn : profile.inferenceProfileId;
      models.push({ id, object: 'model', created: currentTimestamp, owned_by: 'bedrock' });
    }
  }

  return { object: 'list', data: models };
}

export async function handleGetModel(modelId) {
  const created = Math.floor(Date.now() / 1000);

  const fmResponse = await bedrock.send(new ListFoundationModelsCommand({
    byOutputModality: 'TEXT',
    byInferenceType: 'ON_DEMAND',
  }));
  const textModelIds = new Set();
  for (const m of fmResponse.modelSummaries || []) {
    if (m.outputModalities?.includes('TEXT')) textModelIds.add(m.modelId);
  }

  const fmMatch = (fmResponse.modelSummaries || []).find(m => m.modelId === modelId && m.outputModalities?.includes('TEXT'));
  if (fmMatch) {
    return { statusCode: 200, body: { id: fmMatch.modelId, object: 'model', created, owned_by: fmMatch.providerName || 'bedrock' } };
  }

  const ipResponse = await bedrock.send(new ListInferenceProfilesCommand({}));
  const ipMatch = (ipResponse.inferenceProfileSummaries || []).find(
    p => p.inferenceProfileId === modelId || p.inferenceProfileArn === modelId
  );
  if (ipMatch) {
    // Verify the profile's underlying models are text models
    const profileModels = ipMatch.models || [];
    const hasTextModel = profileModels.some(m => textModelIds.has(m.modelId) || isTextModel(m.modelId));
    if (!hasTextModel && profileModels.length > 0) {
      return {
        statusCode: 404,
        body: { error: { message: `Model '${modelId}' is not a text model and cannot be used with this API`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }
      };
    }
    return {
      statusCode: 200,
      body: { id: ipMatch.type === 'APPLICATION' ? ipMatch.inferenceProfileArn : ipMatch.inferenceProfileId, object: 'model', created, owned_by: 'bedrock' }
    };
  }

  return {
    statusCode: 404,
    body: { error: { message: `Model '${modelId}' not found`, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }
  };
}
