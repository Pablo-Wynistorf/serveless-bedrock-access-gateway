import { ConverseStreamCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { bedrockRuntime, resolveModel } from '../lib/bedrock.mjs';
import { sendJsonResponse, mapFinishReason, SSE_HEADERS } from '../utils/response.mjs';
import { normalizeMessages, toConverseMessages, buildConverseParams } from '../utils/messages.mjs';
import { getToolConfig, createToolExecutor, CITATION_SYSTEM_PROMPT } from '../lib/tools.mjs';
import { initMcpServers } from '../lib/mcp-client.mjs';
import { sendChatError } from './errors.mjs';

const MAX_TOOL_ROUNDS = 10;
const SYSTEM_FINGERPRINT = 'fp_bedrock_gateway';

export async function handleChatCompletions(requestBody, responseStream) {
  let model;
  try {
    let {
      messages, stream = true,
      max_tokens, max_completion_tokens,
      temperature = 1.0, top_p,
      stop, n,
      frequency_penalty, presence_penalty,
      stream_options,
    } = requestBody;

    if (max_completion_tokens !== undefined && max_tokens === undefined) {
      max_tokens = max_completion_tokens;
    }

    const mcpServers = requestBody.mcp_servers || [];
    model = await resolveModel(requestBody.model);
    messages = normalizeMessages(messages);

    if (n !== undefined && n > 1) {
      console.warn(`n=${n} requested but only n=1 is supported; returning single choice`);
    }
    if (frequency_penalty) console.warn('frequency_penalty is not supported by Bedrock, ignoring');
    if (presence_penalty) console.warn('presence_penalty is not supported by Bedrock, ignoring');

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
        error: { message: 'temperature must be between 0 and 1 (Bedrock constraint)', type: 'invalid_request_error', param: 'temperature', code: 'invalid_value' }
      });
    }
    if (top_p !== undefined && (top_p < 0 || top_p > 1)) {
      return sendJsonResponse(responseStream, 400, {
        error: { message: 'top_p must be between 0 and 1', type: 'invalid_request_error', param: 'top_p', code: 'invalid_value' }
      });
    }

    let stopSequences;
    if (stop !== undefined && stop !== null) {
      stopSequences = Array.isArray(stop) ? stop : [stop];
      stopSequences = stopSequences.filter(s => typeof s === 'string' && s.length > 0);
      if (stopSequences.length === 0) stopSequences = undefined;
    }

    const includeUsage = stream_options?.include_usage === true;
    const systemMessages = messages.filter(msg => msg.role === 'system').map(msg => ({ text: msg.content }));
    systemMessages.push(CITATION_SYSTEM_PROMPT);
    const converseMessages = toConverseMessages(messages);
    const converseOpts = { topP: top_p, stopSequences };

    if (stream) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: SSE_HEADERS });
      const chatId = `chatcmpl-${randomUUID().substring(0, 8)}`;
      const created = Math.floor(Date.now() / 1000);

      const chunk = (delta, finish_reason = null) => {
        responseStream.write(`data: ${JSON.stringify({
          id: chatId, object: 'chat.completion.chunk', created, model, system_fingerprint: SYSTEM_FINGERPRINT,
          choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`);
      };

      chunk({ role: 'assistant' });

      // Initialize MCP servers
      let mcpTools = [];
      let mcpExecutor = null;
      if (mcpServers.length > 0) {
        try {
          const mcp = await initMcpServers(mcpServers);
          mcpTools = mcp.tools;
          mcpExecutor = mcp.executor;
        } catch (err) {
          console.error('MCP initialization error:', err.message);
        }
      }

      const toolConfig = getToolConfig(mcpTools);
      const toolExecutor = createToolExecutor(mcpExecutor);

      let currentMessages = [...converseMessages];
      let toolRound = 0;
      let lastStopReason = 'end_turn';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      while (toolRound < MAX_TOOL_ROUNDS) {
        const params = buildConverseParams(model, currentMessages, systemMessages, max_tokens, temperature, converseOpts);
        if (toolConfig) params.toolConfig = toolConfig;

        const command = new ConverseStreamCommand(params);
        const response = await bedrockRuntime.send(command);

        let stopReason = 'end_turn';
        let currentToolUse = null;
        let toolUseBlocks = [];
        let toolCallIndex = 0;

        for await (const event of response.stream) {
          if (event.contentBlockStart?.start?.toolUse) {
            currentToolUse = { ...event.contentBlockStart.start.toolUse, rawInput: '' };
            // Stream tool call start in OpenAI format
            const callId = `call_${currentToolUse.toolUseId}`;
            chunk({
              tool_calls: [{
                index: toolCallIndex,
                id: callId,
                type: 'function',
                function: { name: currentToolUse.name, arguments: '' }
              }]
            });
          } else if (event.contentBlockDelta?.delta?.toolUse) {
            if (currentToolUse) {
              const argChunk = event.contentBlockDelta.delta.toolUse.input || '';
              currentToolUse.rawInput += argChunk;
              // Stream argument deltas
              if (argChunk) {
                chunk({
                  tool_calls: [{
                    index: toolCallIndex,
                    function: { arguments: argChunk }
                  }]
                });
              }
            }
          } else if (event.contentBlockDelta?.delta?.text) {
            chunk({ content: event.contentBlockDelta.delta.text });
          }
          if (event.contentBlockStop && currentToolUse) {
            toolUseBlocks.push(currentToolUse);
            currentToolUse = null;
            toolCallIndex++;
          }
          if (event.metadata?.usage) {
            totalInputTokens = event.metadata.usage.inputTokens || 0;
            totalOutputTokens += event.metadata.usage.outputTokens || 0;
          }
          if (event.messageStop) stopReason = event.messageStop.stopReason || 'end_turn';
        }

        lastStopReason = stopReason;

        if (stopReason === 'tool_use' && toolUseBlocks.length > 0) {
          // Send finish_reason: tool_calls for this assistant turn
          chunk({}, 'tool_calls');

          const assistantContent = [];
          const toolResults = [];

          for (const block of toolUseBlocks) {
            let parsedInput;
            try {
              parsedInput = typeof block.rawInput === 'string' ? JSON.parse(block.rawInput) : block.rawInput;
            } catch { parsedInput = { query: block.rawInput }; }

            console.log(`Tool call [${toolRound + 1}/${MAX_TOOL_ROUNDS}]: ${block.name}(${JSON.stringify(parsedInput)})`);

            let toolResult;
            try {
              toolResult = await toolExecutor.run(block.name, parsedInput);
            } catch (toolErr) {
              console.error(`Tool execution error: ${toolErr.message}`);
              toolResult = { text: `Tool error: ${toolErr.message}. Please continue without this result.` };
            }

            assistantContent.push({ toolUse: { toolUseId: block.toolUseId, name: block.name, input: parsedInput } });
            toolResults.push({ toolResult: { toolUseId: block.toolUseId, content: [toolResult] } });
          }

          currentMessages.push({ role: 'assistant', content: assistantContent });
          currentMessages.push({ role: 'user', content: toolResults });

          // Start a new assistant turn for the next round
          chunk({ role: 'assistant' });

          toolRound++;
          continue;
        }

        break;
      }

      // If tool rounds exhausted, make one final call
      if (lastStopReason === 'tool_use') {
        console.log('Tool rounds exhausted, making final generation call');
        currentMessages.push({
          role: 'user',
          content: [{ text: 'You have used all available tool calls. Now please provide your final answer based on the information you have gathered so far. Do not attempt to use any more tools.' }]
        });
        const finalParams = buildConverseParams(model, currentMessages, systemMessages, max_tokens, temperature, converseOpts);
        if (toolConfig) finalParams.toolConfig = toolConfig;
        const finalCommand = new ConverseStreamCommand(finalParams);
        const finalResponse = await bedrockRuntime.send(finalCommand);

        for await (const event of finalResponse.stream) {
          if (event.contentBlockDelta?.delta?.text) {
            chunk({ content: event.contentBlockDelta.delta.text });
          }
          if (event.metadata?.usage) {
            totalInputTokens = event.metadata.usage.inputTokens || 0;
            totalOutputTokens += event.metadata.usage.outputTokens || 0;
          }
        }
      }

      // Final chunk with finish_reason
      const finalChunk = {
        id: chatId, object: 'chat.completion.chunk', created, model, system_fingerprint: SYSTEM_FINGERPRINT,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
      };
      if (includeUsage) {
        finalChunk.usage = {
          prompt_tokens: totalInputTokens,
          completion_tokens: totalOutputTokens,
          total_tokens: totalInputTokens + totalOutputTokens
        };
      }
      responseStream.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      responseStream.write('data: [DONE]\n\n');
      responseStream.end();

    } else {
      // Non-streaming
      let mcpTools = [];
      let mcpExecutor = null;
      if (mcpServers.length > 0) {
        try {
          const mcp = await initMcpServers(mcpServers);
          mcpTools = mcp.tools;
          mcpExecutor = mcp.executor;
        } catch (err) {
          console.error('MCP initialization error:', err.message);
        }
      }

      const toolConfig = getToolConfig(mcpTools);
      const toolExecutor = createToolExecutor(mcpExecutor);

      let currentMessages = [...converseMessages];
      let toolRound = 0;
      let response;

      while (toolRound < MAX_TOOL_ROUNDS) {
        const params = buildConverseParams(model, currentMessages, systemMessages, max_tokens, temperature, converseOpts);
        if (toolConfig) params.toolConfig = toolConfig;

        const command = new ConverseCommand(params);
        response = await bedrockRuntime.send(command);

        if (response.stopReason === 'tool_use') {
          const toolBlocks = (response.output?.message?.content || []).filter(c => c.toolUse);
          if (!toolBlocks.length) break;

          const toolResults = [];
          for (const block of toolBlocks) {
            const { toolUseId, name, input } = block.toolUse;
            console.log(`Tool call [${toolRound + 1}/${MAX_TOOL_ROUNDS}]: ${name}(${JSON.stringify(input)})`);

            let toolResult;
            try {
              toolResult = await toolExecutor.run(name, input);
            } catch (toolErr) {
              console.error(`Tool execution error: ${toolErr.message}`);
              toolResult = { text: `Tool error: ${toolErr.message}. Please continue without this result.` };
            }
            toolResults.push({ toolResult: { toolUseId, content: [toolResult] } });
          }

          currentMessages.push({ role: 'assistant', content: response.output.message.content });
          currentMessages.push({ role: 'user', content: toolResults });
          toolRound++;
          continue;
        }
        break;
      }

      if (response.stopReason === 'tool_use') {
        console.log('Tool rounds exhausted, making final generation call');
        currentMessages.push({
          role: 'user',
          content: [{ text: 'You have used all available tool calls. Now please provide your final answer based on the information you have gathered so far. Do not attempt to use any more tools.' }]
        });
        const finalParams = buildConverseParams(model, currentMessages, systemMessages, max_tokens, temperature, converseOpts);
        if (toolConfig) finalParams.toolConfig = toolConfig;
        const finalCommand = new ConverseCommand(finalParams);
        response = await bedrockRuntime.send(finalCommand);
      }

      const content = response.output?.message?.content?.[0]?.text || '';
      return sendJsonResponse(responseStream, 200, {
        id: `chatcmpl-${randomUUID().substring(0, 8)}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        system_fingerprint: SYSTEM_FINGERPRINT,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: mapFinishReason(response.stopReason) }],
        usage: { prompt_tokens: response.usage?.inputTokens || 0, completion_tokens: response.usage?.outputTokens || 0, total_tokens: response.usage?.totalTokens || 0 }
      });
    }
  } catch (error) {
    console.error('Chat completions error:', error);
    let errorMessage = error.message || 'Internal server error';
    if (error.name === 'ValidationException' && (error.message?.includes('prompt is too long') || error.message?.includes('tokens'))) {
      const tokenMatch = error.message?.match(/(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/);
      errorMessage = tokenMatch
        ? `Context window exceeded: ${tokenMatch[1]} tokens used, but the model supports a maximum of ${tokenMatch[2]} tokens. Try reducing the number of MCP servers, simplifying your request, or shortening the conversation history.`
        : `Context window exceeded. Try reducing the number of MCP servers, simplifying your request, or shortening the conversation history.`;
    }
    try {
      responseStream.write(`data: ${JSON.stringify({ error: { message: errorMessage, type: error.name === 'ValidationException' ? 'invalid_request_error' : 'internal_error', code: error.message?.includes('tokens') ? 'context_length_exceeded' : undefined } })}\n\n`);
      responseStream.write('data: [DONE]\n\n');
      responseStream.end();
    } catch {
      return sendChatError(responseStream, error, model, 'openai');
    }
  }
}
