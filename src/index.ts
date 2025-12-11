import { createOpenAI } from '@ai-sdk/openai';
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
  // Initialize OpenAI-compatible provider for Vercel AI Gateway
  const gateway = createOpenAI({
    apiKey: env.VERCEL_AI_GATEWAY_KEY,
    baseURL: 'https://ai-gateway.vercel.sh/v1',
  });

  // Convert messages from Anthropic format to OpenAI format
  const messages = convertMessagesToOpenAI(body.messages);

  // Build model ID with anthropic prefix for Vercel AI Gateway
  const modelId = `anthropic/${normalizeModelId(body.model)}`;

  // Convert tools to OpenAI format
  const tools = body.tools ? convertToolsToOpenAI(body.tools) : undefined;

  // Handle system prompt
  const systemMessage = buildSystemMessage(body.system);
  if (systemMessage) {
    messages.unshift(systemMessage);
  }

  // Build options - Vercel AI Gateway uses 'reasoning' parameter
  const extraBody: any = {};
  if (body.thinking?.type === 'enabled') {
    extraBody.reasoning = {
      effort: 'high',
      budget_tokens: body.thinking.budget_tokens || 10000,
    };
  }

  const commonOptions: any = {
    model: gateway(modelId),
    messages,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
  };

  // Add tools if present
  if (tools && tools.length > 0) {
    commonOptions.tools = convertToolsToAISDK(body.tools!);
    if (body.tool_choice) {
      commonOptions.toolChoice = convertToolChoice(body.tool_choice);
    }
  }

  // Add extra body for reasoning
  if (Object.keys(extraBody).length > 0) {
    commonOptions.experimental_providerMetadata = {
      openai: extraBody,
    };
  }

  if (body.stream) {
    return handleStreamResponse(commonOptions, body.model);
  } else {
    return handleNonStreamResponse(commonOptions, body.model);
  }
}

// ==================== Message Conversion (Anthropic -> OpenAI) ====================

function convertMessagesToOpenAI(messages: AnthropicMessage[]): CoreMessage[] {
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
          parts.push({ type: 'text', text: block.text! });
          break;

        case 'thinking':
          // Include thinking as text for context
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

    if (parts.length === 1 && parts[0].type === 'text') {
      result.push({ role: msg.role, content: parts[0].text });
    } else if (parts.length > 0) {
      result.push({ role: msg.role, content: parts });
    }
  }

  return result;
}

function buildSystemMessage(system: string | Array<{ type: string; text: string }> | undefined): CoreMessage | null {
  if (!system) return null;

  const text = typeof system === 'string'
    ? system
    : system.map((s) => s.text).join('\n');

  return { role: 'system', content: text };
}

// ==================== Tool Conversion ====================

function convertToolsToOpenAI(tools: AnthropicTool[]): any[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function convertToolsToAISDK(tools: AnthropicTool[]): Record<string, any> {
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

// ==================== Model ID ====================

function normalizeModelId(model: string): string {
  // Remove any existing prefix and normalize
  return model
    .replace('anthropic/', '')
    .replace('claude-', 'claude-');
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
