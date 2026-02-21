import { API_KEY } from '../lib/bedrock.mjs';

export function authenticate(headers) {
  if (!headers) return false;

  const headerKeys = Object.keys(headers);
  let authHeader = null;
  let anthropicKey = null;
  let azureKey = null;

  for (const key of headerKeys) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'authorization') authHeader = headers[key];
    else if (lowerKey === 'x-api-key') anthropicKey = headers[key];
    else if (lowerKey === 'api-key') azureKey = headers[key];
  }

  // Priority: Authorization > x-api-key (Anthropic) > api-key (Azure OpenAI)
  let token = null;
  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  } else if (anthropicKey) {
    token = anthropicKey;
  } else if (azureKey) {
    token = azureKey;
  }

  if (!token) return false;
  return token.trim() === API_KEY.trim();
}
