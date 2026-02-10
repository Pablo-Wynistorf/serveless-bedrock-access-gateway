// Normalize messages from various client formats (Anthropic, OpenAI, etc.)
export function normalizeMessages(messages) {
  if (!messages || !Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (msg.author && !msg.role) {
      msg.role = msg.author;
      delete msg.author;
    }
    if (msg.content && typeof msg.content === 'object' && msg.content.text) {
      msg.content = msg.content.text;
    }
    return msg;
  });
}

// Convert messages to Bedrock Converse API format
export function toConverseMessages(messages) {
  return messages
    .filter(msg => msg.role !== 'system')
    .map(msg => {
      if (!msg.role || msg.content == null) throw new Error('Invalid message: missing role or content');
      let textContent;
      if (typeof msg.content === 'string') textContent = msg.content;
      else if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(part => part.type === 'text');
        textContent = textPart ? textPart.text : '';
      } else if (msg.content?.text) textContent = msg.content.text;
      else textContent = String(msg.content);

      if (textContent == null) throw new Error('Invalid message: null content');
      textContent = textContent.toString().trim();
      return { role: msg.role, content: [{ text: textContent }], _empty: textContent === '' };
    })
    .filter(msg => !msg._empty)
    .map(({ role, content }) => ({ role, content }));
}

// Build Bedrock ConverseStream / Converse params
export function buildConverseParams(model, converseMessages, systemMessages, maxTokens, temperature) {
  const params = {
    modelId: model,
    messages: converseMessages,
    inferenceConfig: { maxTokens, temperature }
  };
  if (systemMessages.length > 0) params.system = systemMessages;
  return params;
}

// Extract system messages from request body
export function extractSystemMessages(messages, system) {
  let systemMessages = system ? [{ text: system }] : [];
  const systemFromMessages = messages.filter(msg => msg.role === 'system');
  if (systemFromMessages.length > 0 && !system) {
    systemMessages = systemFromMessages.map(msg => ({ text: msg.content }));
  }
  return systemMessages;
}
