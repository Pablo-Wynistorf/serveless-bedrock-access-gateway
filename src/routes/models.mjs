import { ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { bedrock, ENABLE_CROSS_REGION, ENABLE_APP_PROFILES } from '../lib/bedrock.mjs';

export async function handleModels() {
  const models = [];
  const currentTimestamp = Math.floor(Date.now() / 1000);

  const fmResponse = await bedrock.send(new ListFoundationModelsCommand({}));
  for (const model of fmResponse.modelSummaries || []) {
    if (model.inferenceTypesSupported?.includes('ON_DEMAND')) {
      models.push({ id: model.modelId, object: 'model', created: currentTimestamp, owned_by: 'bedrock' });
    }
  }

  if (ENABLE_CROSS_REGION || ENABLE_APP_PROFILES) {
    const ipResponse = await bedrock.send(new ListInferenceProfilesCommand({}));
    for (const profile of ipResponse.inferenceProfileSummaries || []) {
      const isAppProfile = profile.type === 'APPLICATION';
      const isCrossRegion = profile.type === 'SYSTEM_DEFINED';
      if ((isAppProfile && ENABLE_APP_PROFILES) || (isCrossRegion && ENABLE_CROSS_REGION)) {
        const id = isAppProfile ? profile.inferenceProfileArn : profile.inferenceProfileId;
        models.push({ id, object: 'model', created: currentTimestamp, owned_by: 'bedrock' });
      }
    }
  }

  return { object: 'list', data: models };
}

export async function handleGetModel(modelId) {
  const created = Math.floor(Date.now() / 1000);

  const fmResponse = await bedrock.send(new ListFoundationModelsCommand({}));
  const fmMatch = (fmResponse.modelSummaries || []).find(m => m.modelId === modelId);
  if (fmMatch) {
    return { statusCode: 200, body: { id: fmMatch.modelId, object: 'model', created, owned_by: 'bedrock' } };
  }

  const ipResponse = await bedrock.send(new ListInferenceProfilesCommand({}));
  const ipMatch = (ipResponse.inferenceProfileSummaries || []).find(
    p => p.inferenceProfileId === modelId || p.inferenceProfileArn === modelId
  );
  if (ipMatch) {
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
