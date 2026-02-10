import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockRuntime, DEFAULT_EMBEDDING_MODEL } from '../lib/bedrock.mjs';

export async function handleEmbeddings(body) {
  const { input, model = DEFAULT_EMBEDDING_MODEL } = body;
  const texts = Array.isArray(input) ? input : [input];
  const embeddings = [];

  for (const text of texts) {
    const command = new InvokeModelCommand({
      modelId: model,
      body: JSON.stringify({ texts: [text], input_type: 'search_document' }),
      contentType: 'application/json',
      accept: 'application/json'
    });
    const response = await bedrockRuntime.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    embeddings.push({ object: 'embedding', embedding: result.embeddings[0], index: embeddings.length });
  }

  return {
    statusCode: 200,
    body: {
      object: 'list', data: embeddings, model,
      usage: {
        prompt_tokens: texts.reduce((sum, t) => sum + t.length, 0),
        total_tokens: texts.reduce((sum, t) => sum + t.length, 0)
      }
    }
  };
}
