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

// In-memory cache for key status (reduces KV reads)
interface CachedKeyStatus {
  isDisabled: boolean;
  cachedAt: number;
}

const keyStatusCache = new Map<string, CachedKeyStatus>();
const CACHE_TTL_MS = 60 * 1000; // Cache for 60 seconds

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
    // Use hash of the key to avoid storing actual key
    const hash = this.simpleHash(apiKey);
    return `key_status_${hash}`;
  }

  // Simple hash function for key identification
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  // Check if we should reset disabled keys (15th of each month)
  private shouldResetKeys(): { shouldReset: boolean; currentMonth: number } {
    const now = new Date();
    const day = now.getUTCDate();
    const month = now.getUTCMonth() + 1; // 1-12
    
    // Reset on or after the 15th of each month
    return {
      shouldReset: day >= 15,
      currentMonth: month,
    };
  }

  // Check cache first, then KV if needed
  private getCachedStatus(apiKey: string): CachedKeyStatus | null {
    const kvKey = this.getKVKey(apiKey);
    const cached = keyStatusCache.get(kvKey);
    
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
      return cached;
    }
    
    return null;
  }

  // Update cache
  private setCachedStatus(apiKey: string, isDisabled: boolean): void {
    const kvKey = this.getKVKey(apiKey);
    keyStatusCache.set(kvKey, {
      isDisabled,
      cachedAt: Date.now(),
    });
  }

  // Clear cache for a key (when status changes)
  private clearCachedStatus(apiKey: string): void {
    const kvKey = this.getKVKey(apiKey);
    keyStatusCache.delete(kvKey);
  }

  // Check if a key is disabled (with caching)
  async isKeyDisabled(apiKey: string): Promise<boolean> {
    // Check memory cache first
    const cached = this.getCachedStatus(apiKey);
    if (cached !== null) {
      return cached.isDisabled;
    }

    // Cache miss - check KV
    try {
      const kvKey = this.getKVKey(apiKey);
      const statusJson = await this.env.KEY_STATUS.get(kvKey);
      
      if (!statusJson) {
        this.setCachedStatus(apiKey, false);
        return false;
      }

      const status: KeyStatus = JSON.parse(statusJson);
      const { shouldReset, currentMonth } = this.shouldResetKeys();

      // If it's past the 15th and this key was disabled in a previous month, reset it
      if (shouldReset && status.lastResetMonth !== currentMonth) {
        console.log(`Resetting key (hash: ${this.simpleHash(apiKey)}) - new month reset`);
        await this.env.KEY_STATUS.delete(kvKey);
        this.setCachedStatus(apiKey, false);
        return false;
      }

      this.setCachedStatus(apiKey, true);
      return true;
    } catch (error) {
      console.error('Error checking key status:', error);
      return false; // Assume key is valid if KV fails
    }
  }

  // Mark a key as disabled due to quota exhaustion
  async disableKey(apiKey: string, reason: string): Promise<void> {
    try {
      const kvKey = this.getKVKey(apiKey);
      const { currentMonth } = this.shouldResetKeys();
      
      const status: KeyStatus = {
        disabledAt: Date.now(),
        reason: reason,
        lastResetMonth: currentMonth,
      };

      // Store with expiration of 35 days (ensures it lasts until next reset)
      await this.env.KEY_STATUS.put(kvKey, JSON.stringify(status), {
        expirationTtl: 35 * 24 * 60 * 60, // 35 days in seconds
      });

      // Update cache immediately
      this.setCachedStatus(apiKey, true);

      console.log(`Disabled key (hash: ${this.simpleHash(apiKey)}) - reason: ${reason}`);
    } catch (error) {
      console.error('Error disabling key:', error);
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

  // Get next available key (optimized: try keys directly, only check KV on error)
  async getNextAvailableKey(): Promise<string | null> {
    const totalKeys = this.keys.length;
    let attempts = 0;

    while (attempts < totalKeys) {
      const key = this.keys[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % totalKeys;

      if (!(await this.isKeyDisabled(key))) {
        return key;
      }

      attempts++;
    }

    return null; // All keys are disabled
  }

  // Get all available keys (uses cache to minimize KV reads)
  async getAvailableKeys(): Promise<string[]> {
    const available: string[] = [];
    
    for (const key of this.keys) {
      if (!(await this.isKeyDisabled(key))) {
        available.push(key);
      }
    }

    // Rotate starting point for load balancing
    if (available.length > 1) {
      const rotateCount = this.currentIndex % available.length;
      return [...available.slice(rotateCount), ...available.slice(0, rotateCount)];
    }

    return available;
  }

  // Get status summary (for health check - can skip cache for accurate status)
  async getStatus(useCache: boolean = true): Promise<{ total: number; available: number; disabled: number }> {
    let disabled = 0;
    
    for (const key of this.keys) {
      if (useCache) {
        if (await this.isKeyDisabled(key)) {
          disabled++;
        }
      } else {
        // Force KV check for health endpoint (bypass cache)
        const kvKey = this.getKVKey(key);
        const statusJson = await this.env.KEY_STATUS.get(kvKey);
        if (statusJson) {
          const status: KeyStatus = JSON.parse(statusJson);
          const { shouldReset, currentMonth } = this.shouldResetKeys();
          if (!(shouldReset && status.lastResetMonth !== currentMonth)) {
            disabled++;
          }
        }
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

    // Health check with key status (bypass cache for accurate status)
    if (url.pathname === '/' || url.pathname === '/health') {
      const status = await keyManager.getStatus(false); // false = bypass cache
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
    // Reset is this month on the 15th
    resetDate = new Date(Date.UTC(year, month, 15, 0, 0, 0));
  } else {
    // Reset is next month on the 15th
    resetDate = new Date(Date.UTC(year, month + 1, 15, 0, 0, 0));
  }

  return resetDate.toISOString();
}

// ==================== Main Handler with Retry ====================

async function handleMessagesWithRetry(
  body: AnthropicRequest,
  keyManager: KeyManager
): Promise<Response> {
  const availableKeys = await keyManager.getAvailableKeys();

  if (availableKeys.length === 0) {
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

  for (const apiKey of availableKeys) {
    try {
      console.log(`Trying key (hash: ${apiKey.slice(-8)}...)`);
      const response = await handleMessages(body, apiKey);
      
      // Check if response is an error
      if (!response.ok) {
        const errorBody = await response.clone().json().catch(() => null);
        
        // Check if it's a quota error
        if (errorBody?.error && keyManager.isQuotaError(errorBody.error)) {
          console.log(`Key quota exhausted, disabling and trying next...`);
          await keyManager.disableKey(apiKey, errorBody.error.message || 'Quota exhausted');
          lastError = errorBody.error;
          continue; // Try next key
        }
        
        // For non-quota errors, return the response as-is
        return response;
      }

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
          // Add cache control if present
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
          // Include thinking as text for context
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
            // Add cache control if present
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
          // Handle PDF documents
          if (block.source) {
            const docPart: any = {
              type: 'file',
              data: block.source.data,
              mimeType: block.source.media_type,
            };
            // Add cache control if present
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

  // Handle array of system content blocks with cache control
  return system.map((block) => {
    const content: any = {
      type: 'text',
      text: block.text,
    };

    // Add cache control if present
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

    // Add cache control if present on tool
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
  // Remove any existing prefix and add anthropic/ prefix for gateway
  const cleanModel = model.replace('anthropic/', '');
  return `anthropic/${cleanModel}`;
}

// ==================== Stream Response ====================

async function handleStreamResponse(options: any, originalModel: string): Promise<Response> {
  const result = streamText(options);

  const encoder = new TextEncoder();
  const messageId = `msg_${Date.now()}`;
  let contentBlockIndex = 0;
  let hasStartedTextBlock = false;
  let hasThinkingBlock = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Send message_start
      controller.enqueue(
        encoder.encode(
          `event: message_start\ndata: ${JSON.stringify({
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
          })}\n\n`
        )
      );

      try {
        // Process the stream using fullStream
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'reasoning':
              // Handle reasoning/thinking blocks
              if (!hasThinkingBlock) {
                // Start thinking block
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'thinking', thinking: '' },
                    })}\n\n`
                  )
                );
                hasThinkingBlock = true;
              }
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: { type: 'thinking_delta', thinking: part.textDelta },
                  })}\n\n`
                )
              );
              break;

            case 'text-delta':
              // If we were in thinking mode, close it first
              if (hasThinkingBlock && !hasStartedTextBlock) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: contentBlockIndex,
                    })}\n\n`
                  )
                );
                contentBlockIndex++;
                hasThinkingBlock = false;
              }

              // Start text block if not started
              if (!hasStartedTextBlock) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'text', text: '' },
                    })}\n\n`
                  )
                );
                hasStartedTextBlock = true;
              }

              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: { type: 'text_delta', text: part.textDelta },
                  })}\n\n`
                )
              );
              break;

            case 'tool-call':
              // Close any open block first
              if (hasStartedTextBlock || hasThinkingBlock) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: contentBlockIndex,
                    })}\n\n`
                  )
                );
                contentBlockIndex++;
                hasStartedTextBlock = false;
                hasThinkingBlock = false;
              }

              // Start tool use block
              controller.enqueue(
                encoder.encode(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: contentBlockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: part.toolCallId,
                      name: part.toolName,
                      input: {},
                    },
                  })}\n\n`
                )
              );

              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: JSON.stringify(part.args),
                    },
                  })}\n\n`
                )
              );

              controller.enqueue(
                encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: contentBlockIndex,
                  })}\n\n`
                )
              );
              contentBlockIndex++;
              break;

            case 'finish':
              // Close any open block
              if (hasStartedTextBlock || hasThinkingBlock) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: contentBlockIndex,
                    })}\n\n`
                  )
                );
              }

              // Get usage from finish event
              const usage = part.usage || { promptTokens: 0, completionTokens: 0 };

              // Send message_delta
              controller.enqueue(
                encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: 'message_delta',
                    delta: {
                      stop_reason: part.finishReason === 'tool-calls' ? 'tool_use' : 'end_turn',
                      stop_sequence: null,
                    },
                    usage: { output_tokens: usage.completionTokens || 0 },
                  })}\n\n`
                )
              );

              // Send message_stop
              controller.enqueue(
                encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify({
                    type: 'message_stop',
                  })}\n\n`
                )
              );
              break;
          }
        }
      } catch (error: any) {
        console.error('Stream error:', error);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: error.message },
            })}\n\n`
          )
        );
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

  // Build Anthropic format response
  const content: ContentBlock[] = [];

  // Add thinking if present (check multiple possible properties)
  const thinkingContent = (result as any).reasoning || (result as any).reasoningText;
  if (thinkingContent) {
    content.push({
      type: 'thinking',
      thinking: thinkingContent,
    });
  }

  // Add text
  if (result.text) {
    content.push({
      type: 'text',
      text: result.text,
    });
  }

  // Add tool calls
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

  // Build response with cache metadata if available
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

  // Add cache usage if available from provider metadata
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
