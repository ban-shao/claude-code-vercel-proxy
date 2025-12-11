import { createGateway } from '@ai-sdk/gateway';
import type { AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { generateText, streamText, CoreMessage } from 'ai';
import { z } from 'zod';
import type {
  AnthropicRequest,
  AnthropicMessage,
  ContentBlock,
  AnthropicTool,
  Env,
  KeyStatus,
} from './types';

// ==================== Key Management ====================

// Disabled keys cache (populated only when we encounter quota errors)
// This is a lightweight in-memory set that persists within a single Worker instance
const disabledKeysCache = new Set<string>();

class KeyManager {
  private keys: string[];
  private currentIndex: number = 0;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    // Support both new multi-key and legacy single key
    const keysString = env.VERCEL_AI_GATEWAY_KEYS || env.VERCEL_AI_GATEWAY_KEY || '';
    this.keys = keysString
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (this.keys.length === 0) {
      throw new Error('No API keys configured');
    }

    console.log(`Loaded ${this.keys.length} API key(s)`);
  }

  // Get KV key for storing status
  private getKVKey(apiKey: string): string {
    const hash = this.simpleHash(apiKey);
    return `key_status_${hash}`;
  }

  // Simple hash function for key identification
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  // Check if we should reset disabled keys (15th of each month)
  private shouldResetKeys(): { shouldReset: boolean; currentMonth: number } {
    const now = new Date();
    const day = now.getUTCDate();
    const month = now.getUTCMonth() + 1;
    
    return {
      shouldReset: day >= 15,
      currentMonth: month,
    };
  }

  // Check if a key is known to be disabled (memory cache only - NO KV read)
  isKeyKnownDisabled(apiKey: string): boolean {
    const kvKey = this.getKVKey(apiKey);
    return disabledKeysCache.has(kvKey);
  }

  // Mark a key as disabled in memory cache
  private markKeyDisabledInCache(apiKey: string): void {
    const kvKey = this.getKVKey(apiKey);
    disabledKeysCache.add(kvKey);
  }

  // Mark a key as disabled due to quota exhaustion (writes to KV)
  async disableKey(apiKey: string, reason: string): Promise<void> {
    // First, mark in memory cache (immediate effect for this instance)
    this.markKeyDisabledInCache(apiKey);

    // Then persist to KV for cross-instance consistency
    try {
      const kvKey = this.getKVKey(apiKey);
      const { currentMonth } = this.shouldResetKeys();
      
      const status: KeyStatus = {
        disabledAt: Date.now(),
        reason: reason,
        lastResetMonth: currentMonth,
      };

      await this.env.KEY_STATUS.put(kvKey, JSON.stringify(status), {
        expirationTtl: 35 * 24 * 60 * 60, // 35 days
      });

      console.log(`Disabled key (hash: ${this.simpleHash(apiKey)}) - reason: ${reason}`);
    } catch (error) {
      console.error('Error persisting key status to KV:', error);
    }
  }

  // Check KV for disabled status (only called when needed)
  async isKeyDisabledInKV(apiKey: string): Promise<boolean> {
    try {
      const kvKey = this.getKVKey(apiKey);
      const statusJson = await this.env.KEY_STATUS.get(kvKey);
      
      if (!statusJson) {
        return false;
      }

      const status: KeyStatus = JSON.parse(statusJson);
      const { shouldReset, currentMonth } = this.shouldResetKeys();

      // If it's past the 15th and this key was disabled in a previous month, reset it
      if (shouldReset && status.lastResetMonth !== currentMonth) {
        console.log(`Resetting key (hash: ${this.simpleHash(apiKey)}) - new month reset`);
        await this.env.KEY_STATUS.delete(kvKey);
        return false;
      }

      // Key is disabled - also add to memory cache
      this.markKeyDisabledInCache(apiKey);
      return true;
    } catch (error) {
      console.error('Error checking key status in KV:', error);
      return false;
    }
  }

  // Check if error indicates quota exhaustion
  isQuotaError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || '';
    const errorType = error?.type?.toLowerCase() || '';
    
    const quotaKeywords = [
      'quota',
      'insufficient',
      'exceeded',
      'limit reached',
      'billing',
      'payment required',
      'credit',
      'balance',
      'usage limit',
      'spending limit',
    ];

    return quotaKeywords.some(
      (keyword) => errorMessage.includes(keyword) || errorType.includes(keyword)
    );
  }

  // Get next key using round-robin (NO KV read - optimistic approach)
  getNextKey(): string {
    const key = this.keys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return key;
  }

  // Get all keys in round-robin order, excluding known disabled ones (memory only)
  getKeysToTry(): string[] {
    const result: string[] = [];
    const startIndex = this.currentIndex;
    
    for (let i = 0; i < this.keys.length; i++) {
      const index = (startIndex + i) % this.keys.length;
      const key = this.keys[index];
      
      // Only skip if we KNOW it's disabled (from memory cache)
      if (!this.isKeyKnownDisabled(key)) {
        result.push(key);
      }
    }
    
    // Update current index for next request
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    
    return result;
  }

  // Get status summary (for health check only - this DOES read KV)
  async getStatus(): Promise<{ total: number; available: number; disabled: number }> {
    let disabled = 0;
    
    for (const key of this.keys) {
      if (await this.isKeyDisabledInKV(key)) {
        disabled++;
      }
    }

    return {
      total: this.keys.length,
      available: this.keys.length - disabled,
      disabled,
    };
  }

  // Get total key count (no KV needed)
  getTotalKeyCount(): number {
    return this.keys.length;
  }
}

// ==================== Main Export ====================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS handling
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version, x-api-key',
        },
      });
    }

    // Initialize key manager
    let keyManager: KeyManager;
    try {
      keyManager = new KeyManager(env);
    } catch (error: any) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'configuration_error',
            message: error.message,
          },
        },
        { status: 500 }
      );
    }

    // Health check with key status (this endpoint DOES read KV for accurate status)
    if (url.pathname === '/' || url.pathname === '/health') {
      const status = await keyManager.getStatus();
      return Response.json({
        status: 'ok',
        message: 'Claude Code Vercel Proxy is running',
        keys: status,
        nextReset: getNextResetDate(),
      });
    }

    // Main endpoint: /v1/messages
    if (url.pathname === '/v1/messages' && request.method === 'POST') {
      try {
        const body = (await request.json()) as AnthropicRequest;
        return await handleMessagesWithRetry(body, keyManager);
      } catch (error: any) {
        console.error('Error:', error);
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'api_error',
              message: error.message || 'Internal server error',
            },
          },
          { status: 500 }
        );
      }
    }

    return Response.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Not Found',
        },
      },
      { status: 404 }
    );
  },
};

// Get next reset date (15th of current or next month)
function getNextResetDate(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  let resetDate: Date;
  if (day < 15) {
    resetDate = new Date(Date.UTC(year, month, 15, 0, 0, 0));
  } else {
    resetDate = new Date(Date.UTC(year, month + 1, 15, 0, 0, 0));
  }

  return resetDate.toISOString();
}

// ==================== Main Handler with Retry ====================

async function handleMessagesWithRetry(
  body: AnthropicRequest,
  keyManager: KeyManager
): Promise<Response> {
  // Get keys to try (uses memory cache only - NO KV reads)
  const keysToTry = keyManager.getKeysToTry();

  if (keysToTry.length === 0) {
    // All keys are known to be disabled in memory cache
    // This is rare - only happens if all keys hit quota in this Worker instance
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'quota_exhausted',
          message: 'All API keys have exhausted their quota. Keys will reset on the 15th of each month.',
          nextReset: getNextResetDate(),
        },
      },
      { status: 429 }
    );
  }

  let lastError: any = null;

  for (const apiKey of keysToTry) {
    try {
      console.log(`Trying key (hash: ...${apiKey.slice(-8)})`);
      const response = await handleMessages(body, apiKey);
      
      // Check if response is an error
      if (!response.ok) {
        const errorBody = await response.clone().json().catch(() => null);
        
        // Check if it's a quota error (429 or quota-related message)
        if (response.status === 429 || (errorBody?.error && keyManager.isQuotaError(errorBody.error))) {
          console.log(`Key quota exhausted, disabling and trying next...`);
          // This is the ONLY place we write to KV
          await keyManager.disableKey(apiKey, errorBody?.error?.message || 'Quota exhausted');
          lastError = errorBody?.error;
          continue; // Try next key
        }
        
        // For non-quota errors, return the response as-is
        return response;
      }

      // Success!
      return response;
    } catch (error: any) {
      console.error(`Error with key:`, error.message);
      
      // Check if it's a quota error
      if (keyManager.isQuotaError(error)) {
        await keyManager.disableKey(apiKey, error.message || 'Quota exhausted');
        lastError = error;
        continue; // Try next key
      }

      // For non-quota errors, throw immediately
      throw error;
    }
  }

  // All keys failed with quota errors
  return Response.json(
    {
      type: 'error',
      error: {
        type: 'quota_exhausted',
        message: lastError?.message || 'All API keys have exhausted their quota.',
        nextReset: getNextResetDate(),
      },
    },
    { status: 429 }
  );
}

// ==================== Main Handler ====================

async function handleMessages(body: AnthropicRequest, apiKey: string): Promise<Response> {
  // Normalize model ID to gateway format (anthropic/model-name)
  const modelId = normalizeModelId(body.model);

  // Convert messages from Anthropic format to AI SDK format (with cache control)
  const messages = convertMessagesToAISDK(body.messages);

  // Handle system prompt (with cache control support)
  const systemContent = buildSystemContent(body.system);

  // Build provider options for Anthropic
  const providerOptions: Record<string, any> = {};
  const anthropicOptions: Record<string, any> = {};

  // Extended Thinking support
  if (body.thinking?.type === 'enabled') {
    anthropicOptions.thinking = {
      type: 'enabled',
      budgetTokens: body.thinking.budget_tokens || 10000,
    };
  }

  if (Object.keys(anthropicOptions).length > 0) {
    providerOptions.anthropic = anthropicOptions satisfies AnthropicProviderOptions;
  }

  // Create gateway instance with API key using createGateway
  const gateway = createGateway({
    apiKey: apiKey,
  });

  // Get model from gateway
  const model = gateway(modelId);

  // Build common options
  const commonOptions: any = {
    model,
    messages,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
  };

  // Add system content if present
  if (systemContent) {
    commonOptions.system = systemContent;
  }

  // Add provider options if any
  if (Object.keys(providerOptions).length > 0) {
    commonOptions.providerOptions = providerOptions;
  }

  // Add tools if present
  if (body.tools && body.tools.length > 0) {
    commonOptions.tools = convertToolsToAISDK(body.tools);
    if (body.tool_choice) {
      commonOptions.toolChoice = convertToolChoice(body.tool_choice);
    }
  }

  if (body.stream) {
    return handleStreamResponse(commonOptions, body.model);
  } else {
    return handleNonStreamResponse(commonOptions, body.model);
  }
}

// ==================== Message Conversion (Anthropic -> AI SDK with Cache Control) ====================

function convertMessagesToAISDK(messages: AnthropicMessage[]): CoreMessage[] {
  const result: CoreMessage[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Handle complex content blocks
    const parts: any[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          const textPart: any = { type: 'text', text: block.text! };
          if (block.cache_control) {
            textPart.providerOptions = {
              anthropic: {
                cacheControl: block.cache_control,
              },
            };
          }
          parts.push(textPart);
          break;

        case 'thinking':
          if (block.thinking) {
            parts.push({ type: 'text', text: `<thinking>${block.thinking}</thinking>` });
          }
          break;

        case 'image':
          if (block.source) {
            const imagePart: any = {
              type: 'image',
              image: `data:${block.source.media_type};base64,${block.source.data}`,
            };
            if (block.cache_control) {
              imagePart.providerOptions = {
                anthropic: {
                  cacheControl: block.cache_control,
                },
              };
            }
            parts.push(imagePart);
          }
          break;

        case 'document':
          if (block.source) {
            const docPart: any = {
              type: 'file',
              data: block.source.data,
              mimeType: block.source.media_type,
            };
            if (block.cache_control) {
              docPart.providerOptions = {
                anthropic: {
                  cacheControl: block.cache_control,
                },
              };
            }
            parts.push(docPart);
          }
          break;

        case 'tool_use':
          parts.push({
            type: 'tool-call',
            toolCallId: block.id!,
            toolName: block.name!,
            args: block.input,
          });
          break;

        case 'tool_result':
          const resultContent =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
          parts.push({
            type: 'tool-result',
            toolCallId: block.tool_use_id!,
            result: resultContent,
          });
          break;
      }
    }

    if (parts.length === 1 && parts[0].type === 'text' && !parts[0].providerOptions) {
      result.push({ role: msg.role, content: parts[0].text });
    } else if (parts.length > 0) {
      result.push({ role: msg.role, content: parts });
    }
  }

  return result;
}

function buildSystemContent(
  system: string | Array<{ type: string; text: string; cache_control?: { type: string } }> | undefined
): string | Array<any> | undefined {
  if (!system) return undefined;

  if (typeof system === 'string') {
    return system;
  }

  return system.map((block) => {
    const content: any = {
      type: 'text',
      text: block.text,
    };

    if (block.cache_control) {
      content.providerOptions = {
        anthropic: {
          cacheControl: block.cache_control,
        },
      };
    }

    return content;
  });
}

// ==================== Tool Conversion ====================

function convertToolsToAISDK(tools: AnthropicTool[]): Record<string, any> {
  const result: Record<string, any> = {};

  for (const t of tools) {
    const toolDef: any = {
      description: t.description,
      parameters: convertJsonSchemaToZod(t.input_schema),
    };

    if (t.cache_control) {
      toolDef.providerOptions = {
        anthropic: {
          cacheControl: t.cache_control,
        },
      };
    }

    result[t.name] = toolDef;
  }

  return result;
}

function convertJsonSchemaToZod(schema: any): z.ZodType<any> {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return z.object({}).passthrough();
  }

  const shape: Record<string, z.ZodType<any>> = {};

  for (const [key, value] of Object.entries(schema.properties as Record<string, any>)) {
    let zodType: z.ZodType<any>;

    switch (value.type) {
      case 'string':
        zodType = value.enum ? z.enum(value.enum) : z.string();
        break;
      case 'number':
      case 'integer':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.any());
        break;
      case 'object':
        zodType = z.object({}).passthrough();
        break;
      default:
        zodType = z.any();
    }

    if (value.description) {
      zodType = zodType.describe(value.description);
    }

    if (!schema.required?.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return z.object(shape);
}

function convertToolChoice(toolChoice: any): any {
  if (toolChoice === 'auto') return 'auto';
  if (toolChoice === 'none') return 'none';
  if (toolChoice?.type === 'any') return 'required';
  if (toolChoice?.type === 'tool') {
    return { type: 'tool', toolName: toolChoice.name };
  }
  return 'auto';
}

// ==================== Model ID ====================

function normalizeModelId(model: string): string {
  const cleanModel = model.replace('anthropic/', '');
  return `anthropic/${cleanModel}`;
}

// ==================== Stream Response ====================

// Helper to extract text from various possible property names in stream parts
function extractTextDelta(part: any): string {
  // Try various possible property names
  return part.textDelta || part.text || part.delta?.text || part.content || '';
}

async function handleStreamResponse(options: any, originalModel: string): Promise<Response> {
  const result = streamText(options);

  const encoder = new TextEncoder();
  const messageId = `msg_${Date.now()}`;
  let contentBlockIndex = 0;
  let hasStartedTextBlock = false;
  let hasThinkingBlock = false;
  let hasAnyContent = false;
  let streamError: any = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Helper function to send SSE event
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
          model: originalModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      try {
        for await (const part of result.fullStream) {
          // Debug logging - helps identify what events are being received
          console.log('Stream part type:', part.type, JSON.stringify(part).substring(0, 200));

          switch (part.type) {
            case 'error':
              // Handle error events from the stream
              streamError = part.error;
              console.error('Stream error event:', part.error);
              sendEvent('error', {
                type: 'error',
                error: { 
                  type: 'api_error', 
                  message: part.error?.message || 'Unknown stream error' 
                },
              });
              break;

            case 'reasoning':
              hasAnyContent = true;
              if (!hasThinkingBlock) {
                sendEvent('content_block_start', {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'thinking', thinking: '' },
                });
                hasThinkingBlock = true;
              }
              const thinkingText = extractTextDelta(part);
              if (thinkingText) {
                sendEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'thinking_delta', thinking: thinkingText },
                });
              }
              break;

            case 'text-delta':
              hasAnyContent = true;
              if (hasThinkingBlock && !hasStartedTextBlock) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentBlockIndex,
                });
                contentBlockIndex++;
                hasThinkingBlock = false;
              }

              if (!hasStartedTextBlock) {
                sendEvent('content_block_start', {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                });
                hasStartedTextBlock = true;
              }

              const textContent = extractTextDelta(part);
              if (textContent) {
                sendEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'text_delta', text: textContent },
                });
              }
              break;

            case 'tool-call':
              hasAnyContent = true;
              if (hasStartedTextBlock || hasThinkingBlock) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentBlockIndex,
                });
                contentBlockIndex++;
                hasStartedTextBlock = false;
                hasThinkingBlock = false;
              }

              sendEvent('content_block_start', {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: part.toolCallId,
                  name: part.toolName,
                  input: {},
                },
              });

              sendEvent('content_block_delta', {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify(part.args),
                },
              });

              sendEvent('content_block_stop', {
                type: 'content_block_stop',
                index: contentBlockIndex,
              });
              contentBlockIndex++;
              break;

            case 'finish':
              if (hasStartedTextBlock || hasThinkingBlock) {
                sendEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentBlockIndex,
                });
              }

              const usage = part.usage || { promptTokens: 0, completionTokens: 0 };

              sendEvent('message_delta', {
                type: 'message_delta',
                delta: {
                  stop_reason: part.finishReason === 'tool-calls' ? 'tool_use' : 'end_turn',
                  stop_sequence: null,
                },
                usage: { output_tokens: usage.completionTokens || 0 },
              });

              sendEvent('message_stop', {
                type: 'message_stop',
              });
              hasAnyContent = true; // Mark as having content to prevent error message
              break;

            // Handle other event types that might come through
            case 'step-start':
            case 'step-finish':
              // These are informational, no action needed
              console.log('Informational event:', part.type);
              break;

            default:
              // Log unknown event types for debugging
              console.log('Unknown stream part type:', part.type, part);
              break;
          }
        }

        // If we got here without any content and no explicit error, something went wrong
        if (!hasAnyContent && !streamError) {
          console.error('Stream ended without any content');
          sendEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          sendEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '[Error: No response received from API]' },
          });
          sendEvent('content_block_stop', {
            type: 'content_block_stop',
            index: 0,
          });
          sendEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          sendEvent('message_stop', { type: 'message_stop' });
        }
      } catch (error: any) {
        console.error('Stream iteration error:', error);
        
        // Send error event
        sendEvent('error', {
          type: 'error',
          error: { type: 'api_error', message: error.message || 'Stream processing error' },
        });

        // Close any open blocks
        if (hasStartedTextBlock || hasThinkingBlock) {
          sendEvent('content_block_stop', {
            type: 'content_block_stop',
            index: contentBlockIndex,
          });
        }

        // Send proper closing events
        sendEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'error', stop_sequence: null },
          usage: { output_tokens: 0 },
        });
        sendEvent('message_stop', { type: 'message_stop' });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ==================== Non-Stream Response ====================

async function handleNonStreamResponse(options: any, originalModel: string): Promise<Response> {
  const result = await generateText(options);

  const content: ContentBlock[] = [];

  const thinkingContent = (result as any).reasoning || (result as any).reasoningText;
  if (thinkingContent) {
    content.push({
      type: 'thinking',
      thinking: thinkingContent,
    });
  }

  if (result.text) {
    content.push({
      type: 'text',
      text: result.text,
    });
  }

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

  const response: any = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: originalModel,
    stop_reason: result.toolCalls?.length ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.promptTokens || 0,
      output_tokens: result.usage?.completionTokens || 0,
    },
  };

  const anthropicMetadata = (result as any).providerMetadata?.anthropic;
  if (anthropicMetadata) {
    if (anthropicMetadata.cacheCreationInputTokens !== undefined) {
      response.usage.cache_creation_input_tokens = anthropicMetadata.cacheCreationInputTokens;
    }
    if (anthropicMetadata.cacheReadInputTokens !== undefined) {
      response.usage.cache_read_input_tokens = anthropicMetadata.cacheReadInputTokens;
    }
  }

  return Response.json(response, {
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  });
}
