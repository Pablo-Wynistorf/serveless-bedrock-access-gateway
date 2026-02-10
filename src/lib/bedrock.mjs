import { BedrockClient } from '@aws-sdk/client-bedrock';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

export const bedrock = new BedrockClient({});
export const bedrockRuntime = new BedrockRuntimeClient({});

export const API_KEY = process.env.API_KEY;
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL;
export const DEFAULT_EMBEDDING_MODEL = process.env.DEFAULT_EMBEDDING_MODEL || 'cohere.embed-multilingual-v3';
export const ENABLE_CROSS_REGION = process.env.ENABLE_CROSS_REGION_INFERENCE !== 'false';
export const ENABLE_APP_PROFILES = process.env.ENABLE_APPLICATION_INFERENCE_PROFILES !== 'false';
