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
  } else if (error.name === 'ValidationException' || error.message?.includes('model')) {
    statusCode = 400;
    const msg = `Model '${model}' not found or not accessible.`;
    body = format === 'anthropic'
      ? { type: 'error', error: { type: 'invalid_request_error', message: msg } }
      : { error: { message: msg, type: 'invalid_request_error', param: 'model', code: 'model_not_found' } };
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
    body = { error: { message: error.message || 'Internal server error', type: 'internal_error' } };
  }

  return sendJsonResponse(responseStream, statusCode, body);
}
