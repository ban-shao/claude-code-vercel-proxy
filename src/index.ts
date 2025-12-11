import { createAnthropic } from '@ai-sdk/anthropic';
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

    // Main endpoint: /v1/messages
    if (url.pathname === '/v1/messages' && request.method === 'POST') {
      try {
        const body = (await request.json()) as AnthropicRequest;
        return await handleMessages(body, env);
      } catch (error: any) {
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

    return new Response('Not Found', { status: 404 });
  },
};

// ==================== Main Handler ====================

async function handleMessages(body: AnthropicRequest, env: Env): Promise<Response> {
  // Initialize Anthropic provider via Vercel AI Gateway
  const provider = createAnthropic({
    apiKey: env.VERCEL_AI_GATEWAY_KEY,
    baseURL: 'https://ai-gateway.vercel.sh/anthropic/v1',
  });

  // Convert messages
  const messages = convertMessages(body.messages);

  // Build provider options (for thinking, etc.)
  const providerOptions = buildProviderOptions(body);

  // Convert tools
  const tools = body.tools ? convertTools(body.tools) : undefined;

  // Handle system prompt
  const system =
    typeof body.system === 'string'
      ? body.system
      : body.system?.map((s) => s.text).join('\n');

  const modelId = normalizeModelId(body.model);

  const commonOptions = {
    model: provider(modelId),
    messages,
    system,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    stopSequences: body.stop_sequences,
    tools,
    toolChoice: body.tool_choice ? convertToolChoice(body.tool_choice) : undefined,
    providerOptions,
  };

  if (body.stream) {
    return handleStreamResponse(commonOptions, body.model);
  } else {
    return handleNonStreamResponse(commonOptions, body.model);
  }
}

// ==================== Message Conversion ====================

function convertMessages(messages: AnthropicMessage[]): CoreMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content === 'string') {
      return { role: msg.role, content: msg.content };
    }

    // Handle complex content blocks
    const parts: any[] = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          parts.push({ type: 'text', text: block.text! });
          break;

        case 'thinking':
          if (block.thinking) {
            parts.push({ type: 'text', text: block.thinking });
          }
          break;

        case 'image':
          if (block.source) {
            parts.push({
              type: 'image',
              image: `data:${block.source.media_type};base64,${block.source.data}`,
            });
          }
          break;

        case 'document':
          if (block.source) {
            parts.push({
              type: 'file',
              data: `data:${block.source.media_type};base64,${block.source.data}`,
              mimeType: block.source.media_type,
            });
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

    return { role: msg.role, content: parts };
  }) as CoreMessage[];
}

// ==================== Tool Conversion ====================

function convertTools(tools: AnthropicTool[]): Record<string, any> {
  const result: Record<string, any> = {};

  for (const t of tools) {
    result[t.name] = {
      description: t.description,
      parameters: convertJsonSchemaToZod(t.input_schema),
    };
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

// ==================== Provider Options ====================

function buildProviderOptions(body: AnthropicRequest): any {
  const options: any = { anthropic: {} };

  // Extended Thinking
  if (body.thinking?.type === 'enabled') {
    options.anthropic.thinking = {
      type: 'enabled',
      budgetTokens: body.thinking.budget_tokens || 10000,
    };
  }

  return options;
}

// ==================== Model ID ====================

function normalizeModelId(model: string): string {
  return model.replace('anthropic/', '');
}

// ==================== Stream Response ====================

async function handleStreamResponse(options: any, originalModel: string): Promise<Response> {
  const result = await streamText(options);

  const encoder = new TextEncoder();
  const messageId = `msg_${Date.now()}`;
  let contentBlockIndex = 0;

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
        // Start text content block
        controller.enqueue(
          encoder.encode(
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' },
            })}\n\n`
          )
        );

        // Stream text
        for await (const chunk of result.textStream) {
          controller.enqueue(
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: chunk },
              })}\n\n`
            )
          );
        }

        controller.enqueue(
          encoder.encode(
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex,
            })}\n\n`
          )
        );

        // Handle tool calls if any
        const toolCalls = await result.toolCalls;
        if (toolCalls && toolCalls.length > 0) {
          for (const toolCall of toolCalls) {
            contentBlockIndex++;
            controller.enqueue(
              encoder.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: toolCall.toolCallId,
                    name: toolCall.toolName,
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
                    partial_json: JSON.stringify(toolCall.args),
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
          }
        }

        // Get final usage
        const finalUsage = await result.usage;
        const outputTokens = finalUsage?.completionTokens || 0;

        // Send message_delta
        controller.enqueue(
          encoder.encode(
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: {
                stop_reason: toolCalls?.length ? 'tool_use' : 'end_turn',
                stop_sequence: null,
              },
              usage: { output_tokens: outputTokens },
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
      } catch (error: any) {
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

  // Add thinking if present
  if (result.reasoning) {
    content.push({
      type: 'thinking',
      thinking: result.reasoning,
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

  return Response.json(
    {
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
    },
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}
