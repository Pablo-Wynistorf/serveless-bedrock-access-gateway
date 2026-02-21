import { ConverseStreamCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';
import { bedrockRuntime, resolveModel } from '../lib/bedrock.mjs';
import { sendJsonResponse, SSE_HEADERS } from '../utils/response.mjs';
import { normalizeMessages, toConverseMessages, buildConverseParams, extractSystemMessages, convertAnthropicTools, convertToolChoice } from '../utils/messages.mjs';
import { getToolConfig, createToolExecutor, CITATION_SYSTEM_PROMPT } from '../lib/tools.mjs';
import { initMcpServers } from '../lib/mcp-client.mjs';
import { sendChatError } from './errors.mjs';

const MAX_TOOL_ROUNDS = 10;
const PING_INTERVAL_MS = 10_000;

export async function handleChatMessages(requestBody, responseStream) {
  let model;
  try {
    let {
      messages, stream = true,
      max_tokens, temperature = 1.0,
      system, top_p, top_k,
      stop_sequences, metadata,
      tools: clientTools, tool_choice,
      thinking,
    } = requestBody;

    const mcpServers = requestBody.mcp_servers || [];
    model = await resolveModel(requestBody.model);
    messages = normalizeMessages(messages);

    if (metadata?.user_id) {
      console.log(`Request from user_id: ${metadata.user_id}`);
    }

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
        type: 'error', error: { type: 'invalid_request_error', message: 'temperature must be between 0 and 1 (Bedrock constraint)' }
      });
    }
    if (top_p !== undefined && (top_p < 0 || top_p > 1)) {
      return sendJsonResponse(responseStream, 400, {
        type: 'error', error: { type: 'invalid_request_error', message: 'top_p must be between 0 and 1' }
      });
    }
    if (top_k !== undefined) {
      console.warn(`top_k=${top_k} requested but Bedrock Converse API does not support top_k, ignoring`);
    }

    if (stop_sequences?.length > 0) {
      stop_sequences = stop_sequences.filter(s => typeof s === 'string' && s.length > 0);
      if (stop_sequences.length === 0) stop_sequences = undefined;
    } else {
      stop_sequences = undefined;
    }

    // Log thinking config (Bedrock Converse doesn't support extended thinking natively)
    if (thinking?.type === 'enabled') {
      console.warn('Extended thinking requested but not supported by Bedrock Converse API, ignoring');
    }

    const systemMessages = extractSystemMessages(messages, system);
    systemMessages.push(CITATION_SYSTEM_PROMPT);
    const converseMessages = toConverseMessages(messages);
    const converseOpts = { topP: top_p, stopSequences: stop_sequences };

    // Convert client-provided Anthropic tools to Bedrock format
    const bedrockClientTools = convertAnthropicTools(clientTools);
    const bedrockToolChoice = convertToolChoice(tool_choice);

    if (stream) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: SSE_HEADERS });
      const messageId = `msg_${randomUUID().replace(/-/g, '')}`;

      // Periodic ping to keep connection alive
      const pingTimer = setInterval(() => {
        try {
          responseStream.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
        } catch { /* stream closed */ }
      }, PING_INTERVAL_MS);

      try {
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
        // Merge client-provided tools (from Claude Code) with server tools
        if (bedrockClientTools) {
          toolConfig.tools.push(...bedrockClientTools);
        }
        if (bedrockToolChoice) {
          toolConfig.toolChoice = bedrockToolChoice;
        }
        const toolExecutor = createToolExecutor(mcpExecutor);

        let outputTokens = 0;
        let inputTokens = 0;
        let currentMessages = [...converseMessages];
        let toolRound = 0;
        let lastStopReason = 'end_turn';
        // Track content block index across the entire message (Anthropic uses a global index)
        let blockIndex = 0;

        responseStream.write(`event: message_start\ndata: ${JSON.stringify({
          type: 'message_start',
          message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
        })}\n\n`);

        // Open the first text block
        responseStream.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' }
        })}\n\n`);

        while (toolRound < MAX_TOOL_ROUNDS) {
          const params = buildConverseParams(model, currentMessages, systemMessages, max_tokens, temperature, converseOpts);
          if (toolConfig) params.toolConfig = toolConfig;

          const command = new ConverseStreamCommand(params);
          const response = await bedrockRuntime.send(command);

          let stopReason = 'end_turn';
          let currentToolUse = null;
          let toolUseBlocks = [];

          for await (const event of response.stream) {
            if (event.contentBlockStart?.start?.toolUse) {
              currentToolUse = { ...event.contentBlockStart.start.toolUse, rawInput: '' };
              // Close the current text block, then open a tool_use block
              responseStream.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
              blockIndex++;
              responseStream.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start', index: blockIndex,
                content_block: { type: 'tool_use', id: currentToolUse.toolUseId, name: currentToolUse.name, input: {} }
              })}\n\n`);
            } else if (event.contentBlockDelta?.delta?.toolUse) {
              if (currentToolUse) {
                const argChunk = event.contentBlockDelta.delta.toolUse.input || '';
                currentToolUse.rawInput += argChunk;
                if (argChunk) {
                  responseStream.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta', index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: argChunk }
                  })}\n\n`);
                }
              }
            } else if (event.contentBlockDelta?.delta?.text) {
              responseStream.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'text_delta', text: event.contentBlockDelta.delta.text }
              })}\n\n`);
            }
            if (event.contentBlockStop && currentToolUse) {
              // Close the tool_use block
              responseStream.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
              toolUseBlocks.push(currentToolUse);
              currentToolUse = null;
            }
            if (event.metadata?.usage) {
              inputTokens = event.metadata.usage.inputTokens || inputTokens;
              outputTokens += event.metadata.usage.outputTokens || 0;
            }
            if (event.messageStop) stopReason = event.messageStop.stopReason || 'end_turn';
          }

          lastStopReason = stopReason;

          if (stopReason === 'tool_use' && toolUseBlocks.length > 0) {
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

            // Open a new text block for the next round's text output
            blockIndex++;
            responseStream.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' }
            })}\n\n`);

            toolRound++;
            continue;
          }

          break;
        }

        // If tool rounds exhausted, make a final call
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
              responseStream.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: blockIndex,
                delta: { type: 'text_delta', text: event.contentBlockDelta.delta.text }
              })}\n\n`);
            }
            if (event.metadata?.usage) {
              inputTokens = event.metadata.usage.inputTokens || inputTokens;
              outputTokens += event.metadata.usage.outputTokens || 0;
            }
          }
        }

        // Close the final text block
        responseStream.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
        responseStream.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens }
        })}\n\n`);
        responseStream.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        responseStream.end();
      } finally {
        clearInterval(pingTimer);
      }

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
      // Merge client-provided tools with server tools
      if (bedrockClientTools) {
        toolConfig.tools.push(...bedrockClientTools);
      }
      if (bedrockToolChoice) {
        toolConfig.toolChoice = bedrockToolChoice;
      }
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
        id: `msg_${randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant',
        content: [{ type: 'text', text: content }], model,
        stop_reason: response.stopReason || 'end_turn', stop_sequence: null,
        usage: { input_tokens: response.usage?.inputTokens || 0, output_tokens: response.usage?.outputTokens || 0 }
      });
    }
  } catch (error) {
    console.error('Chat messages error:', error);
    let errorMessage = error.message || 'Internal server error';
    if (error.name === 'ValidationException' && (error.message?.includes('prompt is too long') || error.message?.includes('tokens'))) {
      const tokenMatch = error.message?.match(/(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/);
      errorMessage = tokenMatch
        ? `Context window exceeded: ${tokenMatch[1]} tokens used, but the model supports a maximum of ${tokenMatch[2]} tokens. Try reducing the number of MCP servers, simplifying your request, or shortening the conversation history.`
        : `Context window exceeded. Try reducing the number of MCP servers, simplifying your request, or shortening the conversation history.`;
    }
    try {
      responseStream.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: errorMessage } })}\n\n`);
      responseStream.end();
    } catch {
      return sendChatError(responseStream, error, model, 'anthropic');
    }
  }
}
