import { ConverseStreamCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { bedrockRuntime, DEFAULT_MODEL } from '../lib/bedrock.mjs';
import { sendJsonResponse, mapFinishReason, SSE_HEADERS } from '../utils/response.mjs';
import { normalizeMessages, toConverseMessages, buildConverseParams } from '../utils/messages.mjs';
import { sendChatError } from './errors.mjs';

export async function handleChatCompletions(requestBody, responseStream) {
  let model;
  try {
    let { messages, stream = true, max_tokens, temperature = 1.0 } = requestBody;
    model = requestBody.model || DEFAULT_MODEL;
    messages = normalizeMessages(messages);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendJsonResponse(responseStream, 400, {
        error: { message: 'Messages array is required and cannot be empty', type: 'invalid_request_error', param: 'messages', code: 'missing_required_parameter' }
      });
    }

    if (max_tokens < 1) {
      return sendJsonResponse(responseStream, 400, {
        error: { message: 'max_tokens must be greater than 0', type: 'invalid_request_error', param: 'max_tokens', code: 'invalid_value' }
      });
    }
    if (temperature < 0 || temperature > 1) {
      return sendJsonResponse(responseStream, 400, {
        error: { message: 'temperature must be between 0 and 1', type: 'invalid_request_error', param: 'temperature', code: 'invalid_value' }
      });
    }

    const systemMessages = messages.filter(msg => msg.role === 'system').map(msg => ({ text: msg.content }));
    const converseMessages = toConverseMessages(messages);
    const params = buildConverseParams(model, converseMessages, systemMessages, max_tokens, temperature);

    if (stream) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: SSE_HEADERS });

      const command = new ConverseStreamCommand(params);
      const response = await bedrockRuntime.send(command);
      const chatId = `chatcmpl-${randomUUID().substring(0, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      responseStream.write(`data: ${JSON.stringify({
        id: chatId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      })}\n\n`);

      for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta?.text) {
          responseStream.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { content: event.contentBlockDelta.delta.text }, finish_reason: null }]
          })}\n\n`);
        }
        if (event.messageStop) {
          responseStream.write(`data: ${JSON.stringify({
            id: chatId, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(event.messageStop.stopReason) }]
          })}\n\n`);
          break;
        }
      }

      responseStream.write('data: [DONE]\n\n');
      responseStream.end();
    } else {
      const command = new ConverseCommand(params);
      const response = await bedrockRuntime.send(command);
      const content = response.output?.message?.content?.[0]?.text || '';
      return sendJsonResponse(responseStream, 200, {
        id: `chatcmpl-${randomUUID().substring(0, 8)}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: mapFinishReason(response.stopReason) }],
        usage: { prompt_tokens: response.usage?.inputTokens || 0, completion_tokens: response.usage?.outputTokens || 0, total_tokens: response.usage?.totalTokens || 0 }
      });
    }
  } catch (error) {
    console.error('Chat completions error:', error);
    return sendChatError(responseStream, error, model, 'openai');
  }
}
