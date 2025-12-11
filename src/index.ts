/**
 * Claude Code Vercel Proxy
 * 
 * A Cloudflare Worker that proxies Anthropic API requests through Vercel AI Gateway.
 * Supports all Claude models with full feature compatibility.
 * 
 * Features:
 * - All Claude models (including Claude 4, Opus 4.5)
 * - Extended Thinking
 * - Streaming & Non-streaming responses
 * - Tool calling
 * - Image & PDF input
 * - Cache control (prompt caching)
 * - Full Anthropic API format compatibility
 */

import { createGateway } from '@ai-sdk/gateway';
import { streamText, generateText, type CoreMessage, type CoreTool } from 'ai';
import type {
  Env,
  AnthropicRequest,
  AnthropicMessage,
  ContentBlock,
  SystemContentBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicResponse,
  ResponseContentBlock,
  StopReason,
  Usage,
} from './types';

// ============================================================================
// Constants
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta',
  'Access-Control-Max-Age': '86400',
} as const;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
  return `msg_${Date.now()}${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Normalize model ID for Vercel AI Gateway
 * Converts any model name to anthropic/model-name format
 */
function normalizeModelId(model: string): string {
  const cleanModel = model.replace(/^anthropic\//, '');
  return `anthropic/${cleanModel}`;
}

/**
 * Create JSON response with CORS headers
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Create error response in Anthropic format
 */
function errorResponse(message: string, type = 'api_error', status = 500): Response {
  return jsonResponse(
    {
      type: 'error',
      error: { type, message },
    },
    status
  );
}

// ============================================================================
// Message Conversion
// ============================================================================

/**
 * Convert Anthropic messages to AI SDK format
 */
function convertMessages(messages: AnthropicMessage[]): CoreMessage[] {
  return messages.map((msg): CoreMessage => {
    // Simple text content
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    // Complex content blocks
    const parts: any[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text': {
          const textPart: any = { type: 'text', text: block.text };
          if (block.cache_control) {
            textPart.providerOptions = {
              anthropic: { cacheControl: block.cache_control },
            };
          }
          parts.push(textPart);
          break;
        }

        case 'image': {
          const imagePart: any = {
            type: 'image',
            image: `data:${block.source.media_type};base64,${block.source.data}`,
          };
          if (block.cache_control) {
            imagePart.providerOptions = {
              anthropic: { cacheControl: block.cache_control },
            };
          }
          parts.push(imagePart);
          break;
        }

        case 'document': {
          const docPart: any = {
            type: 'file',
            data: block.source.data,
            mimeType: block.source.media_type,
          };
          if (block.cache_control) {
            docPart.providerOptions = {
              anthropic: { cacheControl: block.cache_control },
            };
          }
          parts.push(docPart);
          break;
        }

        case 'tool_use': {
          parts.push({
            type: 'tool-call',
            toolCallId: block.id,
            toolName: block.name,
            args: block.input,
          });
          break;
        }

        case 'tool_result': {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          parts.push({
            type: 'tool-result',
            toolCallId: block.tool_use_id,
            result: resultContent,
            isError: block.is_error,
          });
          break;
        }

        case 'thinking': {
          // Thinking blocks in input are passed as text
          parts.push({ type: 'text', text: `[Thinking]: ${block.thinking}` });
          break;
        }
      }
    }

    return { role: msg.role, content: parts };
  });
}

// ============================================================================
// System Prompt Conversion
// ============================================================================

/**
 * Convert system prompt to AI SDK format with cache control support
 */
function convertSystemPrompt(
  system: string | SystemContentBlock[] | undefined
): string | Array<{ type: 'text'; text: string; providerOptions?: any }> | undefined {
  if (!system) return undefined;

  // Simple string
  if (typeof system === 'string') {
    return system;
  }

  // Array of content blocks with potential cache control
  return system.map((block) => {
    const result: any = { type: 'text', text: block.text };
    if (block.cache_control) {
      result.providerOptions = {
        anthropic: { cacheControl: block.cache_control },
      };
    }
    return result;
  });
}

// ============================================================================
// Tool Conversion
// ============================================================================

/**
 * Convert Anthropic tools to AI SDK format
 */
function convertTools(
  tools: AnthropicTool[] | undefined
): Record<string, CoreTool> | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: Record<string, CoreTool> = {};

  for (const tool of tools) {
    const toolDef: any = {
      description: tool.description,
      parameters: tool.input_schema,
    };

    if (tool.cache_control) {
      toolDef.providerOptions = {
        anthropic: { cacheControl: tool.cache_control },
      };
    }

    result[tool.name] = toolDef;
  }

  return result;
}

/**
 * Convert Anthropic tool choice to AI SDK format
 */
function convertToolChoice(
  toolChoice: AnthropicToolChoice | undefined
): 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string } | undefined {
  if (!toolChoice) return undefined;

  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'tool', toolName: toolChoice.name };
    default:
      return undefined;
  }
}

// ============================================================================
// Response Building
// ============================================================================

/**
 * Build Anthropic-format response from AI SDK result
 */
function buildResponse(
  result: any,
  model: string,
  messageId: string
): AnthropicResponse {
  const content: ResponseContentBlock[] = [];

  // Add thinking block if present
  if (result.reasoning) {
    content.push({
      type: 'thinking',
      thinking: [
        {
          type: 'reasoning',
          text: result.reasoning,
          providerMetadata: result.providerMetadata?.anthropic
            ? { anthropic: { signature: result.providerMetadata.anthropic.thinking?.signature } }
            : undefined,
        },
      ],
    });
  }

  // Add text block if present
  if (result.text) {
    content.push({ type: 'text', text: result.text });
  }

  // Add tool calls if present
  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const toolCall of result.toolCalls) {
      content.push({
        type: 'tool_use',
        id: toolCall.toolCallId,
        name: toolCall.toolName,
        input: toolCall.args,
      });
    }
  }

  // Determine stop reason
  let stopReason: StopReason = 'end_turn';
  if (result.finishReason === 'tool-calls') {
    stopReason = 'tool_use';
  } else if (result.finishReason === 'length') {
    stopReason = 'max_tokens';
  } else if (result.finishReason === 'stop') {
    stopReason = result.stopSequence ? 'stop_sequence' : 'end_turn';
  }

  // Build usage
  const usage: Usage = {
    input_tokens: result.usage?.promptTokens || 0,
    output_tokens: result.usage?.completionTokens || 0,
  };

  // Add cache usage if available
  const cacheInfo = result.providerMetadata?.anthropic?.cacheCreationInputTokens;
  const cacheReadInfo = result.providerMetadata?.anthropic?.cacheReadInputTokens;
  if (cacheInfo !== undefined) {
    usage.cache_creation_input_tokens = cacheInfo;
  }
  if (cacheReadInfo !== undefined) {
    usage.cache_read_input_tokens = cacheReadInfo;
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// ============================================================================
// Streaming Response Handler
// ============================================================================

/**
 * Handle streaming response
 * Updated for AI SDK v5 fullStream event format
 */
async function handleStreamingResponse(
  result: any,
  model: string,
  messageId: string
): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Helper to send SSE event
      const sendEvent = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Send message_start
      sendEvent('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let contentIndex = 0;
      let currentBlockType: string | null = null;
      let thinkingStarted = false;
      let textStarted = false;
      let toolCallsMap = new Map<string, { index: number; name: string; inputJson: string }>();
      let finalUsage = { input_tokens: 0, output_tokens: 0 };
      let stopReason: StopReason = 'end_turn';

      try {
        for await (const event of result.fullStream) {
          // AI SDK v5: Extract text content from different event formats
          // The event structure may vary, so we check multiple possible properties
          const getTextContent = (evt: any): string | undefined => {
            // Try different property names used in AI SDK v5
            return evt.text ?? evt.textDelta ?? evt.delta?.text ?? evt.delta?.textDelta;
          };

          switch (event.type) {
            case 'reasoning':
            case 'reasoning-delta': {
              // Start thinking block if not started
              if (!thinkingStarted) {
                sendEvent('content_block_start', {
                  type: 'content_block_start',
                  index: contentIndex,
                  content_block: { type: 'thinking', thinking: '' },
                });
                currentBlockType = 'thinking';
                thinkingStarted = true;
              }

              // Get reasoning text - AI SDK v5 uses textDelta for reasoning events
              const reasoningText = event.textDelta ?? event.text ?? '';
              if (reasoningText) {
                sendEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: contentIndex,
                  delta: { type: 'thinking_delta', thinking: reasoningText },
                });
              }
              break;
            }

            case 'reasoning-signature': {
              // Close thinking block with signature
              if (thinkingStarted) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentIndex,
                });
                contentIndex++;
                thinkingStarted = false;
                currentBlockType = null;
              }
              break;
            }

            case 'text-delta': {
              // Close thinking block if still open
              if (thinkingStarted) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentIndex,
                });
                contentIndex++;
                thinkingStarted = false;
              }

              // Start text block if not started
              if (!textStarted) {
                sendEvent('content_block_start', {
                  type: 'content_block_start',
                  index: contentIndex,
                  content_block: { type: 'text', text: '' },
                });
                currentBlockType = 'text';
                textStarted = true;
              }

              // AI SDK v5: text-delta uses 'textDelta' property
              const textContent = event.textDelta ?? event.text ?? '';
              if (textContent) {
                sendEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: contentIndex,
                  delta: { type: 'text_delta', text: textContent },
                });
              }
              break;
            }

            case 'tool-call': {
              // Close text block if still open
              if (textStarted) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentIndex,
                });
                contentIndex++;
                textStarted = false;
              }

              // Send tool call as a complete block
              sendEvent('content_block_start', {
                type: 'content_block_start',
                index: contentIndex,
                content_block: {
                  type: 'tool_use',
                  id: event.toolCallId,
                  name: event.toolName,
                  input: {},
                },
              });

              // Send input as JSON delta
              const inputJson = JSON.stringify(event.args);
              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: contentIndex,
                delta: { type: 'input_json_delta', partial_json: inputJson },
              });

              sendEvent('content_block_stop', {
                type: 'content_block_stop',
                index: contentIndex,
              });
              contentIndex++;

              stopReason = 'tool_use';
              break;
            }

            case 'tool-call-streaming-start': {
              // Close text block if still open
              if (textStarted) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentIndex,
                });
                contentIndex++;
                textStarted = false;
              }

              sendEvent('content_block_start', {
                type: 'content_block_start',
                index: contentIndex,
                content_block: {
                  type: 'tool_use',
                  id: event.toolCallId,
                  name: event.toolName,
                  input: {},
                },
              });

              toolCallsMap.set(event.toolCallId, {
                index: contentIndex,
                name: event.toolName,
                inputJson: '',
              });
              break;
            }

            case 'tool-call-delta': {
              const toolInfo = toolCallsMap.get(event.toolCallId);
              if (toolInfo) {
                sendEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: toolInfo.index,
                  delta: { type: 'input_json_delta', partial_json: event.argsTextDelta },
                });
              }
              break;
            }

            case 'finish': {
              // Close any open blocks
              if (textStarted) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentIndex,
                });
              }

              // Close any open tool calls
              for (const [toolId, toolInfo] of toolCallsMap) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: toolInfo.index,
                });
              }

              // Update stop reason
              if (event.finishReason === 'tool-calls') {
                stopReason = 'tool_use';
              } else if (event.finishReason === 'length') {
                stopReason = 'max_tokens';
              }

              // Update usage
              finalUsage = {
                input_tokens: event.usage?.promptTokens || 0,
                output_tokens: event.usage?.completionTokens || 0,
              };
              break;
            }

            case 'error': {
              sendEvent('error', {
                type: 'error',
                error: { type: 'api_error', message: String(event.error) },
              });
              break;
            }
          }
        }

        // Send message_delta with final stop reason
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: finalUsage.output_tokens },
        });

        // Send message_stop
        sendEvent('message_stop', { type: 'message_stop' });

      } catch (error) {
        sendEvent('error', {
          type: 'error',
          error: { type: 'api_error', message: String(error) },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

// ============================================================================
// Main Request Handler
// ============================================================================

/**
 * Handle /v1/messages endpoint
 */
async function handleMessages(request: Request, env: Env): Promise<Response> {
  // Parse request body
  let body: AnthropicRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON in request body', 'invalid_request_error', 400);
  }

  // Validate required fields
  if (!body.model || !body.messages || !body.max_tokens) {
    return errorResponse(
      'Missing required fields: model, messages, max_tokens',
      'invalid_request_error',
      400
    );
  }

  // Create gateway instance
  const gateway = createGateway({
    apiKey: env.VERCEL_AI_GATEWAY_KEY,
  });

  // Normalize model ID for gateway
  const modelId = normalizeModelId(body.model);
  const model = gateway(modelId);
  const messageId = generateMessageId();

  // Build common options
  const commonOptions: any = {
    model,
    messages: convertMessages(body.messages),
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    stopSequences: body.stop_sequences,
  };

  // Add system prompt if present
  const system = convertSystemPrompt(body.system);
  if (system) {
    commonOptions.system = system;
  }

  // Add tools if present
  const tools = convertTools(body.tools);
  if (tools) {
    commonOptions.tools = tools;
    commonOptions.toolChoice = convertToolChoice(body.tool_choice);
  }

  // Add thinking configuration if enabled
  if (body.thinking?.type === 'enabled') {
    commonOptions.providerOptions = {
      anthropic: {
        thinking: {
          type: 'enabled',
          budgetTokens: body.thinking.budget_tokens || 10000,
        },
      },
    };
  }

  try {
    if (body.stream) {
      // Streaming response
      const result = streamText(commonOptions);
      return handleStreamingResponse(result, body.model, messageId);
    } else {
      // Non-streaming response
      const result = await generateText(commonOptions);
      return jsonResponse(buildResponse(result, body.model, messageId));
    }
  } catch (error) {
    console.error('API Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(message);
  }
}

// ============================================================================
// Worker Entry Point
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check endpoints
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({
        status: 'ok',
        service: 'claude-code-vercel-proxy',
        version: '2.0.1',
        timestamp: new Date().toISOString(),
      });
    }

    // API key validation (optional, if PROXY_API_KEY is set)
    if (env.PROXY_API_KEY) {
      const apiKey = request.headers.get('x-api-key');
      if (apiKey !== env.PROXY_API_KEY) {
        return errorResponse('Invalid API key', 'authentication_error', 401);
      }
    }

    // Main messages endpoint
    if (url.pathname === '/v1/messages' && request.method === 'POST') {
      return handleMessages(request, env);
    }

    // 404 for unknown routes
    return errorResponse('Not Found', 'not_found', 404);
  },
};
