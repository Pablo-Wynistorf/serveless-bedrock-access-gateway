# AWS Bedrock Access Gateway

OpenAI and Anthropic compatible API for Amazon Bedrock with true response streaming via API Gateway REST API.

## Features

- **True Response Streaming** — API Gateway `ResponseTransferMode: STREAM` with `awslambda.streamifyResponse()`
- **OpenAI API compatible** — Works with ChatGPT clients, Raycast, Continue, Cursor, etc.
- **Anthropic API compatible** — Works with Claude Desktop and Anthropic SDKs
- **Zero runtime dependencies** — Uses Node.js 20 built-ins and Lambda-provided AWS SDK
- **All Bedrock models** — Foundation models, cross-region inference profiles, application profiles
- **15-minute streaming timeout** — Long conversations fully supported
- **Dual auth** — `Authorization: Bearer` and `x-api-key` headers

## Quick Deploy

**Prerequisites:**
- AWS CLI configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

```bash
./deploy.sh
```

The script will prompt for an API key on first run, then build and deploy.

## API Endpoints

Base URL: `https://{api-id}.execute-api.{region}.amazonaws.com/v1`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| GET/POST | `/models` | List available models |
| GET | `/models/{id}` | Get specific model |
| POST | `/embeddings` | Text embeddings |
| POST | `/chat/completions` | OpenAI format (streaming) |
| POST | `/chat/messages` | Anthropic format (streaming) |
| POST | `/messages` | Anthropic format — Claude Code (streaming) |
| POST | `/messages/count_tokens` | Token counting stub (Claude Code) |

### OpenAI Format
```bash
curl -N https://your-api-url/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":1024,"stream":true}'
```

### Anthropic Format
```bash
curl -N https://your-api-url/v1/chat/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello"}],"max_tokens":1024,"stream":true}'
```

## Configuration

Edit `samconfig.toml` after first deploy:

```toml
parameter_overrides = [
    "ApiKey=your-secret-api-key",
    "DefaultModelId=global.anthropic.claude-opus-4-6-v1",
    "DefaultEmbeddingModel=cohere.embed-multilingual-v3"
]
```

Default model is `global.anthropic.claude-opus-4-6-v1` (global cross-region inference profile).

## Project Structure

```
src/
  index.mjs              — Lambda handler + router
  lib/
    bedrock.mjs          — AWS SDK clients + config
  middleware/
    auth.mjs             — API key authentication
  routes/
    health.mjs           — GET /health
    models.mjs           — /models endpoints
    embeddings.mjs       — POST /embeddings
    chat-messages.mjs    — POST /chat/messages (Anthropic)
    chat-completions.mjs — POST /chat/completions (OpenAI)
    errors.mjs           — Chat error formatting
  utils/
    response.mjs         — Response helpers, event parsing
    messages.mjs         — Message normalization, Bedrock conversion
template.yaml            — SAM/CloudFormation template
samconfig.toml           — Deployment configuration
deploy.sh                — One-command deploy script
```

## Architecture

```
Client (Raycast, Cursor, OpenAI SDK, etc.)
  ↓
API Gateway REST API (ResponseTransferMode: STREAM)
  ↓ InvokeWithResponseStream
Lambda (awslambda.streamifyResponse, Node.js 20, arm64)
  ↓ ConverseStream / Converse
Amazon Bedrock
```

## Use with AI Tools

### Raycast AI
```yaml
providers:
  - id: bedrock
    name: AWS Bedrock
    base_url: https://your-api-url/v1
    api_keys:
      openai: YOUR_API_KEY
    models:
      - id: global.anthropic.claude-opus-4-6-v1
        name: Claude Opus 4.6
        provider: openai
```

### OpenAI SDK
```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-api-url/v1',
  apiKey: 'YOUR_API_KEY'
});

const stream = await client.chat.completions.create({
  model: 'global.anthropic.claude-opus-4-6-v1',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Claude Code CLI
```bash
export ANTHROPIC_BASE_URL=https://your-api-url/v1
export ANTHROPIC_AUTH_TOKEN=YOUR_API_KEY
export ANTHROPIC_API_KEY=""
claude
```

`ANTHROPIC_API_KEY` must be set to an empty string — Claude Code requires it to be defined but the gateway uses `ANTHROPIC_AUTH_TOKEN` (sent as `x-api-key`).

The gateway maps Anthropic model names (like `claude-sonnet-4-20250514`) to their Bedrock equivalents automatically. You can also use any Bedrock model by setting the alias env vars:

```bash
# Use Nova Pro as the "sonnet" model in Claude Code
export ANTHROPIC_DEFAULT_SONNET_MODEL=amazon.nova-pro-v1:0

# Use Nova Lite as the "haiku" model
export ANTHROPIC_DEFAULT_HAIKU_MODEL=amazon.nova-lite-v1:0

# Or pass any Bedrock model ID directly
claude --model us.amazon.nova-premier-v1:0
```

## Troubleshooting

- **401 Unauthorized** — Check API key in `samconfig.toml`
- **Model not found** — Enable model access in the Bedrock console
- **No streaming** — Use `curl -N` flag to disable output buffering
- **Logs** — Check CloudWatch: `/aws/lambda/{stack-name}-function`
