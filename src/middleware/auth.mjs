import { API_KEY } from '../lib/bedrock.mjs';

export function authenticate(headers) {
  if (!headers) return false;

  const headerKeys = Object.keys(headers);
  let authHeader = null;
  let anthropicKey = null;

  for (const key of headerKeys) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'authorization') authHeader = headers[key];
    else if (lowerKey === 'x-api-key') anthropicKey = headers[key];
  }

  let token = null;
  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
  } else if (anthropicKey) {
    token = anthropicKey;
  }

  if (!token) return false;
  return token.trim() === API_KEY.trim();
}
