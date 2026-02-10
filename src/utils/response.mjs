// Send a JSON response through the Lambda response stream
export function sendJsonResponse(responseStream, statusCode, body, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders
  };
  responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers });
  responseStream.write(JSON.stringify(body));
  responseStream.end();
}

// Parse JSON body from string or object
export function parseBody(body) {
  if (!body) return {};
  try {
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch (error) {
    throw new Error('Invalid JSON in request body');
  }
}

// Normalize API Gateway event into { httpMethod, path, headers, body }
export function parseEvent(event) {
  let httpMethod, path, headers, body;

  if (event.httpMethod) {
    httpMethod = event.httpMethod;
    path = event.path;
    headers = event.headers || {};
    body = event.body;
  } else if (event.requestContext) {
    httpMethod = event.requestContext.http?.method || event.requestContext.httpMethod;
    path = event.requestContext.http?.path || event.path || event.rawPath;
    headers = event.headers || {};
    body = event.body;
  } else {
    httpMethod = event.method || 'GET';
    path = event.path || '/';
    headers = event.headers || {};
    body = event.body;
  }

  if (path && path.startsWith('/v1')) path = path.substring(3);
  if (!path) path = '/';

  return { httpMethod, path, headers, body };
}

// Map Bedrock stop reasons to OpenAI finish reasons
export function mapFinishReason(bedrockReason) {
  const reasonMap = {
    'end_turn': 'stop',
    'max_tokens': 'length',
    'stop_sequence': 'stop',
    'tool_use': 'tool_calls',
    'content_filtered': 'content_filter'
  };
  return reasonMap[bedrockReason] || 'stop';
}

// SSE streaming headers
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'Access-Control-Allow-Origin': '*',
  'X-Accel-Buffering': 'no'
};
