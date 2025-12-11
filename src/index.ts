import { gateway } from '@ai-sdk/gateway';
import { streamText, generateText, tool, type CoreMessage, type CoreTool } from 'ai';
import { z, ZodTypeAny, ZodObject, ZodRawShape } from 'zod';

// Types for Anthropic API format
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
  };
  cache_control?: {
    type: 'ephemeral';
  };
}

// JSON Schema property types
interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  anyOf?: JsonSchemaProperty[];
  oneOf?: JsonSchemaProperty[];
  allOf?: JsonSchemaProperty[];
  $ref?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  nullable?: boolean;
  [key: string]: unknown;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  metadata?: {
    user_id?: string;
  };
  // Extended thinking parameters
  thinking?: {
    type: 'enabled';
    budget_tokens: number;
  };
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface StreamEvent {
  type: string;
  message?: AnthropicResponse;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
    thinking?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface Env {
  VERCEL_AI_GATEWAY_URL: string;
  API_KEY?: string;
}

// Model mapping from Anthropic model names to AI Gateway model IDs
function mapModelToGateway(model: string): string {
  const modelMapping: Record<string, string> = {
    // Claude 4 models
    'claude-sonnet-4-20250514': 'anthropic/claude-sonnet-4-20250514',
    'claude-sonnet-4-0': 'anthropic/claude-sonnet-4-20250514',
    // Claude 3.5 models  
    'claude-3-5-sonnet-20241022': 'anthropic/claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-latest': 'anthropic/claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022': 'anthropic/claude-3-5-haiku-20241022',
    'claude-3-5-haiku-latest': 'anthropic/claude-3-5-haiku-20241022',
    // Claude 3 models
    'claude-3-opus-20240229': 'anthropic/claude-3-opus-20240229',
    'claude-3-opus-latest': 'anthropic/claude-3-opus-20240229',
    'claude-3-sonnet-20240229': 'anthropic/claude-3-sonnet-20240229',
    'claude-3-haiku-20240307': 'anthropic/claude-3-haiku-20240307',
  };
  return modelMapping[model] || `anthropic/${model}`;
}

// Convert JSON Schema property to Zod schema
function jsonSchemaPropertyToZod(prop: JsonSchemaProperty, isRequired: boolean = true): ZodTypeAny {
  let zodSchema: ZodTypeAny;

  // Handle type as string or array
  const propType = Array.isArray(prop.type) ? prop.type[0] : prop.type;

  switch (propType) {
    case 'string':
      let stringSchema = z.string();
      if (prop.description) {
        stringSchema = stringSchema.describe(prop.description);
      }
      zodSchema = stringSchema;
      break;

    case 'number':
    case 'integer':
      let numberSchema = z.number();
      if (prop.description) {
        numberSchema = numberSchema.describe(prop.description);
      }
      zodSchema = numberSchema;
      break;

    case 'boolean':
      let boolSchema = z.boolean();
      if (prop.description) {
        boolSchema = boolSchema.describe(prop.description);
      }
      zodSchema = boolSchema;
      break;

    case 'array':
      if (prop.items) {
        const itemSchema = jsonSchemaPropertyToZod(prop.items, true);
        let arraySchema = z.array(itemSchema);
        if (prop.description) {
          arraySchema = arraySchema.describe(prop.description);
        }
        zodSchema = arraySchema;
      } else {
        zodSchema = z.array(z.unknown());
      }
      break;

    case 'object':
      if (prop.properties) {
        const shape: ZodRawShape = {};
        const requiredFields = prop.required || [];
        for (const [key, value] of Object.entries(prop.properties)) {
          const isFieldRequired = requiredFields.includes(key);
          shape[key] = jsonSchemaPropertyToZod(value, isFieldRequired);
        }
        let objectSchema = z.object(shape);
        if (prop.description) {
          objectSchema = objectSchema.describe(prop.description);
        }
        zodSchema = objectSchema;
      } else {
        zodSchema = z.record(z.unknown());
      }
      break;

    case 'null':
      zodSchema = z.null();
      break;

    default:
      // Handle enum
      if (prop.enum && prop.enum.length > 0) {
        const enumValues = prop.enum as [string, ...string[]];
        let enumSchema = z.enum(enumValues);
        if (prop.description) {
          enumSchema = enumSchema.describe(prop.description);
        }
        zodSchema = enumSchema;
      } else if (prop.anyOf) {
        // Handle anyOf
        const anyOfSchemas = prop.anyOf.map(s => jsonSchemaPropertyToZod(s, true));
        zodSchema = z.union(anyOfSchemas as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
      } else if (prop.oneOf) {
        // Handle oneOf
        const oneOfSchemas = prop.oneOf.map(s => jsonSchemaPropertyToZod(s, true));
        zodSchema = z.union(oneOfSchemas as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
      } else {
        // Default to unknown
        zodSchema = z.unknown();
      }
  }

  // Handle nullable
  if (prop.nullable) {
    zodSchema = zodSchema.nullable();
  }

  // Make optional if not required
  if (!isRequired) {
    zodSchema = zodSchema.optional();
  }

  return zodSchema;
}

// Convert Anthropic tool input_schema to Zod schema
function inputSchemaToZod(inputSchema: AnthropicTool['input_schema']): ZodObject<ZodRawShape> {
  const shape: ZodRawShape = {};
  const requiredFields = inputSchema.required || [];

  if (inputSchema.properties) {
    for (const [key, value] of Object.entries(inputSchema.properties)) {
      const isRequired = requiredFields.includes(key);
      shape[key] = jsonSchemaPropertyToZod(value, isRequired);
    }
  }

  return z.object(shape);
}

// Convert Anthropic tools to AI SDK tools using tool() helper with Zod schemas
function convertTools(
  tools: AnthropicTool[] | undefined
): Record<string, CoreTool> | undefined {
  if (!tools || tools.length === 0) return undefined;

  const result: Record<string, CoreTool> = {};

  for (const anthropicTool of tools) {
    try {
      // Convert JSON Schema to Zod schema
      const zodSchema = inputSchemaToZod(anthropicTool.input_schema);

      // Use tool() helper to create proper AI SDK tool
      result[anthropicTool.name] = tool({
        description: anthropicTool.description || '',
        parameters: zodSchema,
      });

      console.log(`[Tools] Converted tool: ${anthropicTool.name}`);
    } catch (error) {
      console.error(`[Tools] Error converting tool ${anthropicTool.name}:`, error);
      // Fallback: create a tool with empty schema
      result[anthropicTool.name] = tool({
        description: anthropicTool.description || '',
        parameters: z.object({}),
      });
    }
  }

  return result;
}

// Convert Anthropic messages to AI SDK format
function convertMessages(messages: AnthropicMessage[]): CoreMessage[] {
  return messages.map((msg): CoreMessage => {
    if (typeof msg.content === 'string') {
      return {
        role: msg.role,
        content: msg.content,
      };
    }

    // Handle array content (including tool_use and tool_result)
    const parts: CoreMessage['content'] = [];
    
    // Check if this is a tool result message
    const hasToolResult = msg.content.some(block => block.type === 'tool_result');
    
    if (hasToolResult && msg.role === 'user') {
      // Convert tool_result blocks to AI SDK tool-result format
      const toolResults = msg.content
        .filter(block => block.type === 'tool_result')
        .map(block => ({
          type: 'tool-result' as const,
          toolCallId: block.tool_use_id || '',
          result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        }));
      
      return {
        role: 'tool' as const,
        content: toolResults,
      };
    }

    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        (parts as Array<{ type: 'text'; text: string }>).push({
          type: 'text',
          text: block.text,
        });
      } else if (block.type === 'image' && block.source) {
        (parts as Array<{ type: 'image'; image: string; mimeType?: string }>).push({
          type: 'image',
          image: block.source.data,
          mimeType: block.source.media_type,
        });
      } else if (block.type === 'tool_use') {
        (parts as Array<{ type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }>).push({
          type: 'tool-call',
          toolCallId: block.id || '',
          toolName: block.name || '',
          args: block.input || {},
        });
      }
    }

    return {
      role: msg.role,
      content: parts,
    } as CoreMessage;
  });
}

// Convert system prompt
function convertSystem(
  system: AnthropicRequest['system']
): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  return system.map(block => block.text).join('\n\n');
}

// Generate a unique message ID
function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 15)}`;
}

// Convert AI SDK response to Anthropic format
function convertToAnthropicResponse(
  result: { text: string; usage?: { promptTokens?: number; completionTokens?: number }; toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> },
  model: string,
  hasToolUse: boolean = false
): AnthropicResponse {
  const content: AnthropicContentBlock[] = [];

  // Add tool calls if present
  if (result.toolCalls && result.toolCalls.length > 0) {
    for (const toolCall of result.toolCalls) {
      content.push({
        type: 'tool_use',
        id: toolCall.toolCallId,
        name: toolCall.toolName,
        input: toolCall.args as Record<string, unknown>,
      });
    }
  }

  // Add text content if present
  if (result.text) {
    content.push({
      type: 'text',
      text: result.text,
    });
  }

  // Determine stop reason
  let stopReason: AnthropicResponse['stop_reason'] = 'end_turn';
  if (hasToolUse || (result.toolCalls && result.toolCalls.length > 0)) {
    stopReason = 'tool_use';
  }

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.promptTokens || 0,
      output_tokens: result.usage?.completionTokens || 0,
    },
  };
}

// Handle streaming response
async function handleStreamingResponse(
  gatewayUrl: string,
  request: AnthropicRequest,
  signal?: AbortSignal
): Promise<Response> {
  const modelId = mapModelToGateway(request.model);
  const gatewayModel = gateway({
    baseURL: gatewayUrl,
  });

  // Build provider options for extended thinking
  const providerOptions: Record<string, unknown> = {};
  if (request.thinking?.type === 'enabled') {
    providerOptions['anthropic'] = {
      thinking: {
        type: 'enabled',
        budgetTokens: request.thinking.budget_tokens,
      },
    };
  }

  const result = streamText({
    model: gatewayModel(modelId),
    messages: convertMessages(request.messages),
    system: convertSystem(request.system),
    maxTokens: request.max_tokens,
    temperature: request.temperature,
    topP: request.top_p,
    topK: request.top_k,
    stopSequences: request.stop_sequences,
    tools: convertTools(request.tools),
    abortSignal: signal,
    providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
  });

  // Create a streaming response in Anthropic format
  const encoder = new TextEncoder();
  let inputTokens = 0;
  let outputTokens = 0;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send message_start event
        const messageStart: StreamEvent = {
          type: 'message_start',
          message: {
            id: generateMessageId(),
            type: 'message',
            role: 'assistant',
            content: [],
            model: request.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        };
        controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`));

        let currentBlockIndex = 0;
        let hasStartedTextBlock = false;
        let hasStartedThinkingBlock = false;
        let currentToolCallIndex = -1;
        const toolCallMap = new Map<string, number>(); // Map toolCallId to block index

        // Process the stream
        for await (const chunk of result.fullStream) {
          if (chunk.type === 'text-delta') {
            // Handle text delta
            if (!hasStartedTextBlock) {
              hasStartedTextBlock = true;
              const contentBlockStart: StreamEvent = {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'text',
                  text: '',
                },
              };
              controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`));
            }

            const contentBlockDelta: StreamEvent = {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: {
                type: 'text_delta',
                text: chunk.textDelta,
              },
            };
            controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(contentBlockDelta)}\n\n`));
          } else if (chunk.type === 'reasoning') {
            // Handle thinking/reasoning content (extended thinking)
            if (!hasStartedThinkingBlock) {
              hasStartedThinkingBlock = true;
              const thinkingBlockStart: StreamEvent = {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: {
                  type: 'thinking' as 'text',
                  thinking: '',
                } as AnthropicContentBlock,
              };
              controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(thinkingBlockStart)}\n\n`));
            }

            const thinkingDelta: StreamEvent = {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: {
                type: 'thinking_delta',
                thinking: chunk.textDelta,
              },
            };
            controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(thinkingDelta)}\n\n`));
          } else if (chunk.type === 'tool-call') {
            // Close text block if it was open
            if (hasStartedTextBlock) {
              const contentBlockStop: StreamEvent = {
                type: 'content_block_stop',
                index: currentBlockIndex,
              };
              controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`));
              currentBlockIndex++;
              hasStartedTextBlock = false;
            }

            // Start new tool_use block
            currentToolCallIndex++;
            toolCallMap.set(chunk.toolCallId, currentBlockIndex);
            
            const toolUseStart: StreamEvent = {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: chunk.toolCallId,
                name: chunk.toolName,
                input: {},
              },
            };
            controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(toolUseStart)}\n\n`));

            // Send the tool input as a delta
            const toolInputDelta: StreamEvent = {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(chunk.args),
              },
            };
            controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(toolInputDelta)}\n\n`));

            // Close tool_use block
            const toolUseStop: StreamEvent = {
              type: 'content_block_stop',
              index: currentBlockIndex,
            };
            controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(toolUseStop)}\n\n`));
            currentBlockIndex++;
          } else if (chunk.type === 'tool-call-streaming-start') {
            // Close text block if it was open
            if (hasStartedTextBlock) {
              const contentBlockStop: StreamEvent = {
                type: 'content_block_stop',
                index: currentBlockIndex,
              };
              controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`));
              currentBlockIndex++;
              hasStartedTextBlock = false;
            }

            // Start new tool_use block  
            currentToolCallIndex++;
            toolCallMap.set(chunk.toolCallId, currentBlockIndex);
            
            const toolUseStart: StreamEvent = {
              type: 'content_block_start',
              index: currentBlockIndex,
              content_block: {
                type: 'tool_use',
                id: chunk.toolCallId,
                name: chunk.toolName,
                input: {},
              },
            };
            controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(toolUseStart)}\n\n`));
          } else if (chunk.type === 'tool-call-delta') {
            // Stream tool input delta
            const blockIndex = toolCallMap.get(chunk.toolCallId) ?? currentBlockIndex;
            const toolInputDelta: StreamEvent = {
              type: 'content_block_delta',
              index: blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: chunk.argsTextDelta,
              },
            };
            controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(toolInputDelta)}\n\n`));
          } else if (chunk.type === 'finish') {
            // Close thinking block if it was open
            if (hasStartedThinkingBlock) {
              const thinkingBlockStop: StreamEvent = {
                type: 'content_block_stop',
                index: currentBlockIndex,
              };
              controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(thinkingBlockStop)}\n\n`));
              currentBlockIndex++;
              hasStartedThinkingBlock = false;
            }
            // Close text block if it was open
            if (hasStartedTextBlock) {
              const contentBlockStop: StreamEvent = {
                type: 'content_block_stop',
                index: currentBlockIndex,
              };
              controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`));
            }

            // Determine stop reason
            let stopReason: string = 'end_turn';
            if (chunk.finishReason === 'tool-calls') {
              stopReason = 'tool_use';
            } else if (chunk.finishReason === 'length') {
              stopReason = 'max_tokens';
            } else if (chunk.finishReason === 'stop') {
              stopReason = 'end_turn';
            }

            const messageDelta: StreamEvent = {
              type: 'message_delta',
              delta: {
                type: 'message_delta',
                stop_reason: stopReason,
              } as StreamEvent['delta'],
              usage: {
                output_tokens: outputTokens,
              },
            };
            controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`));
          } else if (chunk.type === 'step-finish') {
            // Update token usage
            if (chunk.usage) {
              inputTokens = chunk.usage.promptTokens || inputTokens;
              outputTokens = chunk.usage.completionTokens || outputTokens;
            }
          }
        }

        // Send message_stop event
        controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
        controller.close();
      } catch (error) {
        console.error('[Stream Error]', error);
        const errorEvent = {
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'Unknown error occurred',
          },
        };
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// Handle non-streaming response
async function handleNonStreamingResponse(
  gatewayUrl: string,
  request: AnthropicRequest
): Promise<Response> {
  const modelId = mapModelToGateway(request.model);
  const gatewayModel = gateway({
    baseURL: gatewayUrl,
  });

  // Build provider options for extended thinking
  const providerOptions: Record<string, unknown> = {};
  if (request.thinking?.type === 'enabled') {
    providerOptions['anthropic'] = {
      thinking: {
        type: 'enabled',
        budgetTokens: request.thinking.budget_tokens,
      },
    };
  }

  const result = await generateText({
    model: gatewayModel(modelId),
    messages: convertMessages(request.messages),
    system: convertSystem(request.system),
    maxTokens: request.max_tokens,
    temperature: request.temperature,
    topP: request.top_p,
    topK: request.top_k,
    stopSequences: request.stop_sequences,
    tools: convertTools(request.tools),
    providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
  });

  const hasToolUse = result.toolCalls && result.toolCalls.length > 0;
  const response = convertToAnthropicResponse(
    {
      text: result.text,
      usage: result.usage,
      toolCalls: result.toolCalls,
    },
    request.model,
    hasToolUse
  );

  return new Response(JSON.stringify(response), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

// Main handler
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/') {
      return new Response(JSON.stringify({ status: 'ok', version: '2.2.0' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only handle /v1/messages endpoint
    if (url.pathname !== '/v1/messages') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only accept POST requests
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const request = (await req.json()) as AnthropicRequest;

      // Validate required fields
      if (!request.model || !request.max_tokens || !request.messages) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Missing required fields: model, max_tokens, messages',
            },
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      const gatewayUrl = env.VERCEL_AI_GATEWAY_URL;
      if (!gatewayUrl) {
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'configuration_error',
              message: 'VERCEL_AI_GATEWAY_URL is not configured',
            },
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Handle streaming vs non-streaming
      if (request.stream) {
        return await handleStreamingResponse(gatewayUrl, request, req.signal);
      } else {
        return await handleNonStreamingResponse(gatewayUrl, request);
      }
    } catch (error) {
      console.error('[Error]', error);
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : 'Unknown error occurred',
          },
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }
  },
};
