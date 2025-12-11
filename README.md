# Claude Code Vercel Proxy

A Cloudflare Worker that proxies Anthropic Claude API requests through Vercel AI Gateway.

## Features

- ✅ **All Claude Models** - Support for Claude 4, Opus 4.5, Sonnet 4, and all previous versions
- ✅ **Extended Thinking** - Full support for Claude's thinking/reasoning capability
- ✅ **Streaming** - Real-time streaming responses with SSE
- ✅ **Tool Calling** - Complete tool/function calling support
- ✅ **Vision** - Image input support (base64)
- ✅ **PDF Documents** - PDF file input support
- ✅ **Cache Control** - Prompt caching for cost optimization
- ✅ **Full API Compatibility** - 100% compatible with Anthropic API format

## Supported Models

| Model | API ID |
|-------|--------|
| Claude Opus 4.5 | `claude-opus-4-5-20251101` |
| Claude Opus 4 | `claude-opus-4-20250514` |
| Claude Sonnet 4 | `claude-sonnet-4-20250514` |
| Claude 3.7 Sonnet | `claude-3-7-sonnet-20250219` |
| Claude 3.5 Sonnet | `claude-3-5-sonnet-20241022` |
| Claude 3.5 Haiku | `claude-3-5-haiku-20241022` |
| Claude 3 Opus | `claude-3-opus-20240229` |
| Claude 3 Sonnet | `claude-3-sonnet-20240229` |
| Claude 3 Haiku | `claude-3-haiku-20240307` |

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/ban-shao/claude-code-vercel-proxy.git
cd claude-code-vercel-proxy
npm install
```

### 2. Configure Secrets

```bash
# Set your Vercel AI Gateway API key
npx wrangler secret put VERCEL_AI_GATEWAY_KEY

# Optional: Set a custom API key for your proxy
npx wrangler secret put PROXY_API_KEY
```

### 3. Deploy

```bash
npm run deploy
```

## Usage Examples

### Basic Request

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello, Claude!"}
    ]
  }'
```

### Extended Thinking

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 16000,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 10000
    },
    "messages": [
      {"role": "user", "content": "Solve this step by step: What is 15 * 37?"}
    ]
  }'
```

### Streaming

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Write a short poem about coding."}
    ]
  }'
```

### Tool Calling

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name"
            }
          },
          "required": ["location"]
        }
      }
    ],
    "messages": [
      {"role": "user", "content": "What is the weather in Tokyo?"}
    ]
  }'
```

### Image Input

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": "image/png",
              "data": "<base64-encoded-image>"
            }
          },
          {
            "type": "text",
            "text": "What is in this image?"
          }
        ]
      }
    ]
  }'
```

### Cache Control

```bash
curl https://your-worker.workers.dev/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-proxy-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 1024,
    "system": [
      {
        "type": "text",
        "text": "You are a helpful assistant with extensive knowledge.",
        "cache_control": {"type": "ephemeral"}
      }
    ],
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

## Development

```bash
# Run locally
npm run dev

# Type check
npm run lint

# Deploy
npm run deploy
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VERCEL_AI_GATEWAY_KEY` | Yes | Your Vercel AI Gateway API key |
| `PROXY_API_KEY` | No | Optional API key to protect your proxy |

## API Compatibility

This proxy is fully compatible with the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages). You can use it as a drop-in replacement by changing the base URL.

## License

MIT
