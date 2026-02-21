// Normalize messages from various client formats (Anthropic, OpenAI, etc.)
export function normalizeMessages(messages) {
  if (!messages || !Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (msg.author && !msg.role) {
      msg.role = msg.author;
      delete msg.author;
    }
    // Only flatten simple {text: "..."} objects, not content block arrays
    if (msg.content && typeof msg.content === 'object' && !Array.isArray(msg.content) && msg.content.text && !msg.content.type) {
      msg.content = msg.content.text;
    }
    return msg;
  });
}

// Convert messages to Bedrock Converse API format
// Handles: string content, OpenAI array (text + image_url), Anthropic array (text, tool_use, tool_result, thinking)
export function toConverseMessages(messages) {
  return messages
    .filter(msg => msg.role !== 'system')
    .map(msg => {
      if (!msg.role || msg.content == null) throw new Error('Invalid message: missing role or content');

      // Simple string content
      if (typeof msg.content === 'string') {
        const text = msg.content.trim();
        if (!text) return null;
        return { role: msg.role, content: [{ text }] };
      }

      // Array content — handle both OpenAI and Anthropic block formats
      if (Array.isArray(msg.content)) {
        const parts = [];
        for (const part of msg.content) {
          // Text block (both formats)
          if (part.type === 'text' && part.text?.trim()) {
            parts.push({ text: part.text.trim() });
          }
          // OpenAI image_url block
          else if (part.type === 'image_url' && part.image_url?.url) {
            const url = part.image_url.url;
            const match = url.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
            if (match) {
              parts.push({
                image: {
                  format: match[1] === 'jpg' ? 'jpeg' : match[1],
                  source: { bytes: Buffer.from(match[2], 'base64') }
                }
              });
            }
          }
          // Anthropic image block (source.type === 'base64')
          else if (part.type === 'image' && part.source?.type === 'base64') {
            parts.push({
              image: {
                format: (part.source.media_type || 'image/png').split('/')[1] || 'png',
                source: { bytes: Buffer.from(part.source.data, 'base64') }
              }
            });
          }
          // Anthropic tool_use block (in assistant messages)
          else if (part.type === 'tool_use') {
            parts.push({
              toolUse: {
                toolUseId: part.id,
                name: part.name,
                input: part.input || {}
              }
            });
          }
          // Anthropic tool_result block (in user messages)
          else if (part.type === 'tool_result') {
            const resultContent = [];
            if (typeof part.content === 'string') {
              resultContent.push({ text: part.content });
            } else if (Array.isArray(part.content)) {
              for (const c of part.content) {
                if (c.type === 'text') resultContent.push({ text: c.text });
              }
            }
            if (resultContent.length === 0) {
              resultContent.push({ text: part.is_error ? 'Tool error' : 'No output' });
            }
            parts.push({
              toolResult: {
                toolUseId: part.tool_use_id,
                content: resultContent,
                status: part.is_error ? 'error' : 'success'
              }
            });
          }
          // Anthropic thinking block — skip (Bedrock Converse doesn't support it)
          else if (part.type === 'thinking') {
            // Silently ignore thinking blocks
          }
        }
        if (!parts.length) return null;
        return { role: msg.role, content: parts };
      }

      // Object with .text
      if (msg.content?.text) {
        const text = msg.content.text.toString().trim();
        if (!text) return null;
        return { role: msg.role, content: [{ text }] };
      }

      const text = String(msg.content).trim();
      if (!text) return null;
      return { role: msg.role, content: [{ text }] };
    })
    .filter(Boolean);
}

// Build Bedrock ConverseStream / Converse params
export function buildConverseParams(model, converseMessages, systemMessages, maxTokens, temperature, { topP, stopSequences } = {}) {
  const inferenceConfig = { maxTokens, temperature };
  if (topP !== undefined) inferenceConfig.topP = topP;
  if (stopSequences?.length > 0) inferenceConfig.stopSequences = stopSequences;

  const params = {
    modelId: model,
    messages: converseMessages,
    inferenceConfig
  };
  if (systemMessages.length > 0) params.system = systemMessages;
  return params;
}

// Extract system messages from request body
// Handles: string system, array of {type: "text", text: "..."} (Anthropic format), or from messages array
export function extractSystemMessages(messages, system) {
  if (system) {
    if (typeof system === 'string') {
      return [{ text: system }];
    }
    if (Array.isArray(system)) {
      return system
        .filter(s => s.type === 'text' && s.text)
        .map(s => ({ text: s.text }));
    }
  }
  // Fall back to extracting from messages array
  const systemFromMessages = messages.filter(msg => msg.role === 'system');
  if (systemFromMessages.length > 0) {
    return systemFromMessages.map(msg => {
      if (typeof msg.content === 'string') return { text: msg.content };
      if (Array.isArray(msg.content)) {
        const texts = msg.content.filter(c => c.type === 'text').map(c => c.text);
        return { text: texts.join('\n') };
      }
      return { text: String(msg.content) };
    });
  }
  return [];
}

// Convert Anthropic-format tool definitions to Bedrock toolConfig
// Anthropic: { name, description, input_schema: { type, properties, required } }
// Bedrock:   { toolSpec: { name, description, inputSchema: { json: { type, properties, required } } } }
export function convertAnthropicTools(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return null;
  return tools.map(tool => ({
    toolSpec: {
      name: tool.name,
      description: tool.description || tool.name,
      inputSchema: {
        json: tool.input_schema || { type: 'object', properties: {}, required: [] }
      }
    }
  }));
}

// Convert Anthropic tool_choice to Bedrock toolConfig.toolChoice
// Anthropic: { type: "auto" | "any" | "tool", name?: string }
// Bedrock:   { auto: {} } | { any: {} } | { tool: { name: string } }
export function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (toolChoice.type === 'auto') return { auto: {} };
  if (toolChoice.type === 'any') return { any: {} };
  if (toolChoice.type === 'tool' && toolChoice.name) return { tool: { name: toolChoice.name } };
  return undefined;
}
