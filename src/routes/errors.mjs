import { sendJsonResponse } from '../utils/response.mjs';

export function sendChatError(responseStream, error, model, format = 'anthropic') {
  let statusCode = 500;
  let body;

  if (error.name === 'SerializationException') {
    statusCode = 400;
    body = format === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request format.' } }
      : { error: { message: 'Invalid request format.', type: 'invalid_request_error', param: 'messages', code: 'invalid_format' } };
  } else if (error.message?.includes('Invalid message')) {
    statusCode = 400;
    body = format === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message: error.message } }
      : { error: { message: error.message, type: 'invalid_request_error', param: 'messages', code: 'invalid_content' } };
  } else if (error.name === 'ValidationException') {
    statusCode = 400;
    // Detect token limit exceeded
    const isTokenLimit = error.message?.includes('prompt is too long') || error.message?.includes('tokens');
    const tokenMatch = error.message?.match(/(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/);
    if (isTokenLimit) {
      const msg = tokenMatch
        ? `Context window exceeded: ${tokenMatch[1]} tokens used, but the model supports a maximum of ${tokenMatch[2]} tokens. This can happen when tool results (MCP servers, web fetches) return large amounts of data. Try reducing the number of MCP servers, simplifying your request, or shortening the conversation history.`
        : `Context window exceeded: the conversation plus tool results exceeded the model's maximum token limit. Try reducing the number of MCP servers, simplifying your request, or shortening the conversation history.`;
      body = format === 'anthropic'
        ? { type: 'error', error: { type: 'invalid_request_error', message: msg } }
        : { error: { message: msg, type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } };
    } else {
      body = format === 'anthropic'
        ? { type: 'error', error: { type: 'invalid_request_error', message: error.message } }
        : { error: { message: error.message, type: 'invalid_request_error', param: 'model', code: 'validation_error' } };
    }
  } else if (error.name === 'ResourceNotFoundException') {
    statusCode = 404;
    const msg = `Model '${model}' does not exist. Use the /models endpoint to see available models.`;
    body = format === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message: msg } }
      : { error: { message: msg, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } };
  } else if (error.name === 'AccessDeniedException') {
    statusCode = 403;
    const msg = `Access denied to model '${model}'.`;
    body = format === 'anthropic'
      ? { type: 'error', error: { type: 'permission_error', message: msg } }
      : { error: { message: msg, type: 'invalid_request_error', param: 'model', code: 'insufficient_permissions' } };
  } else {
    body = format === 'anthropic'
      ? { type: 'error', error: { type: 'api_error', message: error.message || 'Internal server error' } }
      : { error: { message: error.message || 'Internal server error', type: 'internal_error' } };
  }

  return sendJsonResponse(responseStream, statusCode, body);
}
