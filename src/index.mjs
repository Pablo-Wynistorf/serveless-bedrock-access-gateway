import { API_KEY } from './lib/bedrock.mjs';
import { authenticate } from './middleware/auth.mjs';
import { sendJsonResponse, parseBody, parseEvent } from './utils/response.mjs';
import { handleHealth } from './routes/health.mjs';
import { handleModels, handleGetModel } from './routes/models.mjs';
import { handleEmbeddings } from './routes/embeddings.mjs';
import { handleChatMessages } from './routes/chat-messages.mjs';
import { handleChatCompletions } from './routes/chat-completions.mjs';

// Stub for /v1/messages/count_tokens — returns an approximate token count
// Claude Code calls this to check context window usage before sending messages
function handleCountTokens(body, responseStream) {
  // Rough approximation: ~4 chars per token for English text
  let charCount = 0;
  if (body.system) {
    if (typeof body.system === 'string') charCount += body.system.length;
    else if (Array.isArray(body.system)) {
      for (const s of body.system) {
        if (s.text) charCount += s.text.length;
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        charCount += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.text) charCount += part.text.length;
          else if (part.type === 'tool_use') charCount += JSON.stringify(part.input || {}).length + (part.name?.length || 0);
          else if (part.type === 'tool_result') {
            if (typeof part.content === 'string') charCount += part.content.length;
            else if (Array.isArray(part.content)) {
              for (const c of part.content) { if (c.text) charCount += c.text.length; }
            }
          }
        }
      }
    }
  }
  if (Array.isArray(body.tools)) {
    charCount += JSON.stringify(body.tools).length;
  }
  const inputTokens = Math.ceil(charCount / 4);
  return sendJsonResponse(responseStream, 200, { input_tokens: inputTokens });
}

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
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, api-key, anthropic-version, anthropic-beta'
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
        // Use Anthropic error format for Anthropic endpoints
        if (path === '/chat/messages' || path === '/messages' || path === '/messages/count_tokens' || path === '/chat/messages/count_tokens') {
          return sendJsonResponse(responseStream, 401, {
            type: 'error', error: { type: 'authentication_error', message: 'Missing or invalid x-api-key header' }
          });
        }
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

      // Anthropic: /v1/messages/count_tokens (stub for Claude Code compatibility)
      if ((path === '/messages/count_tokens' || path === '/chat/messages/count_tokens') && httpMethod === 'POST') {
        return handleCountTokens(parseBody(body), responseStream);
      }

      // Anthropic: /v1/messages or /chat/messages
      if ((path === '/messages' || path === '/chat/messages') && httpMethod === 'POST') {
        return await handleChatMessages(parseBody(body), responseStream);
      }

      // OpenAI: /v1/chat/completions
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
