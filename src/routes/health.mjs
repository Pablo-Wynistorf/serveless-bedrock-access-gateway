import { sendJsonResponse } from '../utils/response.mjs';

export function handleHealth(responseStream) {
  return sendJsonResponse(responseStream, 200, {
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: {
      DEFAULT_MODEL: process.env.DEFAULT_MODEL,
      AWS_REGION: process.env.AWS_REGION
    }
  });
}
