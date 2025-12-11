import { createGateway } from '@ai-sdk/gateway';
import { generateText, streamText, CoreMessage } from 'ai';
import { z } from 'zod';
import type {
  AnthropicRequest,
  AnthropicMessage,
  ContentBlock,
  AnthropicTool,
  Env,
} from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS handling
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version, x-api-key',
        },
      });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({ status: 'ok', message: 'Claude Code Vercel Proxy is running' });
    }

    // Main endpoint: /v1/messages
    if (url.pathname === '/v1/messages' && request.method === 'POST') {
      try {
        const body = (await request.json()) as AnthropicRequest;
        return await handleMessages(body, env);
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
          type: 'not_found',
          message: `Not Found: ${url.pathname}`,
        },
      },
      { status: 404 }
    );
  },
};

// ==================== Main Handler ====================

async function handleMessages(body: AnthropicRequest, env: Env): Promise<Response> {
  // Initialize Gateway provider for Vercel AI Gateway
  const gateway = createGateway({
    apiKey: env.VERCEL_AI_GATEWAY_KEY,
  });

  // Build model ID with anthropic prefix for Vercel AI Gateway
  const modelId = `anthropic/${normalizeModelId(body.model)}`;

  // Convert messages from Anthropic format to AI SDK format (with cache control)
  const messages = convertMessagesToAISDK(body.messages);

  // Handle system prompt (with cache control support)
  const systemMessages = buildSystemMessages(body.system);
  if (systemMessages.length > 0) {
    messages.unshift(...systemMessages);
  }

  // Build provider options for Anthropic
  const providerOptions: Record<string, any> = {};

  // Configure Anthropic-specific options
  const anthropicOptions: Record<string, any> = {};

  // Extended Thinking support
  if (body.thinking?.type === 'enabled') {
    anthropicOptions.thinking = {
      type: 'enabled',
      budgetTokens: body.thinking.budget_tokens || 10000,
    };
  }

  if (Object.keys(anthropicOptions).length > 0) {
    providerOptions.anthropic = anthropicOptions;
  }

  // Build common options
  const commonOptions: any = {
    model: gateway(modelId),
    messages,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
  };

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

function buildSystemMessages(
  system: string | Array<{ type: string; text: string; cache_control?: { type: string } }> | undefined
): CoreMessage[] {
  if (!system) return [];

  if (typeof system === 'string') {
    return [{ role: 'system', content: system }];
  }

  // Handle array of system content blocks with cache control
  const systemMessages: CoreMessage[] = [];

  for (const block of system) {
    const message: any = {
      role: 'system',
      content: block.text,
    };

    // Add cache control if present
    if (block.cache_control) {
      message.providerOptions = {
        anthropic: {
          cacheControl: block.cache_control,
        },
      };
    }

    systemMessages.push(message);
  }

  return systemMessages;
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
  // Remove any existing prefix and normalize
  return model.replace('anthropic/', '');
}

// ==================== Stream Response ====================

async function handleStreamResponse(options: any, originalModel: string): Promise<Response> {
  const result = streamText(options);

  const encoder = new TextEncoder();
  const messageId = `msg_${Date.now()}`;
  let contentBlockIndex = 0;
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
        // Check if we have reasoning/thinking in the result
        const resultPromise = result;

        // Process the stream
        for await (const part of resultPromise.fullStream) {
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
              if (hasThinkingBlock) {
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

                // Start text block
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'text', text: '' },
                    })}\n\n`
                  )
                );
              } else if (contentBlockIndex === 0) {
                // First text block
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: contentBlockIndex,
                      content_block: { type: 'text', text: '' },
                    })}\n\n`
                  )
                );
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
              // Close any open block
              if (contentBlockIndex >= 0) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: contentBlockIndex,
                    })}\n\n`
                  )
                );
              }
              contentBlockIndex++;

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
              break;

            case 'finish':
              // Close any open block
              controller.enqueue(
                encoder.encode(
                  `event: content_block_stop\ndata: ${JSON.stringify({
                    type: 'content_block_stop',
                    index: contentBlockIndex,
                  })}\n\n`
                )
              );

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

  // Add thinking if present (from reasoning)
  if (result.reasoning) {
    content.push({
      type: 'thinking',
      thinking: result.reasoning,
    });
  }

  // Also check reasoningText
  if (result.reasoningText) {
    content.push({
      type: 'thinking',
      thinking: result.reasoningText,
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
  const anthropicMetadata = result.providerMetadata?.anthropic as any;
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
