import { API_KEY } from './lib/bedrock.mjs';
import { authenticate } from './middleware/auth.mjs';
import { sendJsonResponse, parseBody, parseEvent } from './utils/response.mjs';
import { handleHealth } from './routes/health.mjs';
import { handleModels, handleGetModel } from './routes/models.mjs';
import { handleEmbeddings } from './routes/embeddings.mjs';
import { handleChatMessages } from './routes/chat-messages.mjs';
import { handleChatCompletions } from './routes/chat-completions.mjs';

// Validate config at cold start
if (!API_KEY) {
  console.error('API_KEY environment variable is missing!');
  throw new Error('API_KEY environment variable is required');
}
console.log('Lambda function initialized successfully');

// ============================================================
// Streaming Lambda handler
// ============================================================
export const handler = awslambda.streamifyResponse(
  async (event, responseStream, _context) => {
    const { httpMethod, path, headers, body } = parseEvent(event);

    // CORS preflight
    if (httpMethod === 'OPTIONS') {
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version'
        }
      });
      responseStream.end();
      return;
    }

    try {
      // Health check (no auth)
      if (path === '/health' && httpMethod === 'GET') {
        return handleHealth(responseStream);
      }

      // Auth gate
      if (!authenticate(headers)) {
        return sendJsonResponse(responseStream, 401, {
          error: { message: 'Missing or invalid authorization header', type: 'authentication_error' }
        });
      }

      // Routes
      if (path === '/models' && (httpMethod === 'GET' || httpMethod === 'POST')) {
        return sendJsonResponse(responseStream, 200, await handleModels());
      }

      if (path.startsWith('/models/') && (httpMethod === 'GET' || httpMethod === 'POST')) {
        const result = await handleGetModel(path.split('/models/')[1]);
        return sendJsonResponse(responseStream, result.statusCode, result.body);
      }

      if (path === '/embeddings' && httpMethod === 'POST') {
        const result = await handleEmbeddings(parseBody(body));
        return sendJsonResponse(responseStream, result.statusCode, result.body);
      }

      if (path === '/chat/messages' && httpMethod === 'POST') {
        return await handleChatMessages(parseBody(body), responseStream);
      }

      if (path === '/chat/completions' && httpMethod === 'POST') {
        return await handleChatCompletions(parseBody(body), responseStream);
      }

      return sendJsonResponse(responseStream, 404, {
        error: { message: 'Not found', type: 'invalid_request_error' }
      });
    } catch (error) {
      console.error('Handler error:', error);
      return sendJsonResponse(responseStream, 500, {
        error: { message: error.message || 'Internal server error', type: 'internal_error' }
      });
    }
  }
);
