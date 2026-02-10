import { ConverseStreamCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { bedrockRuntime, DEFAULT_MODEL } from '../lib/bedrock.mjs';
import { sendJsonResponse, SSE_HEADERS } from '../utils/response.mjs';
import { normalizeMessages, toConverseMessages, buildConverseParams, extractSystemMessages } from '../utils/messages.mjs';
import { sendChatError } from './errors.mjs';

export async function handleChatMessages(requestBody, responseStream) {
  let model;
  try {
    let { messages, stream = true, max_tokens, temperature = 1.0, system } = requestBody;
    model = requestBody.model || DEFAULT_MODEL;
    messages = normalizeMessages(messages);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendJsonResponse(responseStream, 400, {
        type: 'error', error: { type: 'invalid_request_error', message: 'Messages array is required and cannot be empty' }
      });
    }

    if (max_tokens < 1) {
      return sendJsonResponse(responseStream, 400, {
        type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens must be greater than 0' }
      });
    }
    if (temperature < 0 || temperature > 1) {
      return sendJsonResponse(responseStream, 400, {
        type: 'error', error: { type: 'invalid_request_error', message: 'temperature must be between 0 and 1' }
      });
    }

    const systemMessages = extractSystemMessages(messages, system);
    const converseMessages = toConverseMessages(messages);
    const params = buildConverseParams(model, converseMessages, systemMessages, max_tokens, temperature);

    if (stream) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: SSE_HEADERS });

      const command = new ConverseStreamCommand(params);
      const response = await bedrockRuntime.send(command);
      const messageId = `msg_${randomUUID().replace(/-/g, '')}`;

      responseStream.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
      })}\n\n`);

      responseStream.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
      })}\n\n`);

      let outputTokens = 0;
      for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta?.text) {
          responseStream.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.contentBlockDelta.delta.text }
          })}\n\n`);
        }
        if (event.metadata?.usage) outputTokens = event.metadata.usage.outputTokens || 0;
        if (event.messageStop) {
          responseStream.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          responseStream.write(`event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta', delta: { stop_reason: event.messageStop.stopReason || 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens }
          })}\n\n`);
          responseStream.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        }
      }
      responseStream.end();
    } else {
      const command = new ConverseCommand(params);
      const response = await bedrockRuntime.send(command);
      const content = response.output?.message?.content?.[0]?.text || '';
      return sendJsonResponse(responseStream, 200, {
        id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant',
        content: [{ type: 'text', text: content }], model,
        stop_reason: response.stopReason || 'end_turn', stop_sequence: null,
        usage: { input_tokens: response.usage?.inputTokens || 0, output_tokens: response.usage?.outputTokens || 0 }
      });
    }
  } catch (error) {
    console.error('Chat messages error:', error);
    return sendChatError(responseStream, error, model, 'anthropic');
  }
}
