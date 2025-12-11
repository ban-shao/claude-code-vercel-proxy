/**
 * Anthropic API Type Definitions
 * Complete type definitions for Claude API compatibility
 */

// ============================================================================
// Environment
// ============================================================================

export interface Env {
  VERCEL_AI_GATEWAY_KEY: string;
  PROXY_API_KEY?: string;
}

// ============================================================================
// Request Types
// ============================================================================

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | SystemContentBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: ThinkingConfig;
  metadata?: RequestMetadata;
}

export interface ThinkingConfig {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
}

export interface RequestMetadata {
  user_id?: string;
}

// ============================================================================
// Message Types
// ============================================================================

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  source: ImageSource;
  cache_control?: CacheControl;
}

export interface ImageSource {
  type: 'base64';
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
}

export interface DocumentBlock {
  type: 'document';
  source: DocumentSource;
  cache_control?: CacheControl;
}

export interface DocumentSource {
  type: 'base64';
  media_type: 'application/pdf';
  data: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

// ============================================================================
// System Content Types
// ============================================================================

export interface SystemContentBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface CacheControl {
  type: 'ephemeral';
}

// ============================================================================
// Tool Types
// ============================================================================

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: JsonSchema;
  cache_control?: CacheControl;
}

export interface JsonSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
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

export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

// ============================================================================
// Response Types
// ============================================================================

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ResponseContentBlock[];
  model: string;
  stop_reason: StopReason;
  stop_sequence: string | null;
  usage: Usage;
}

export type ResponseContentBlock =
  | ResponseTextBlock
  | ResponseToolUseBlock
  | ResponseThinkingBlock;

export interface ResponseTextBlock {
  type: 'text';
  text: string;
}

export interface ResponseToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ResponseThinkingBlock {
  type: 'thinking';
  thinking: ThinkingContent[];
}

export interface ThinkingContent {
  type: 'reasoning';
  text: string;
  providerMetadata?: {
    anthropic?: {
      signature?: string;
    };
  };
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ============================================================================
// Streaming Event Types
// ============================================================================

export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | ErrorEvent;

export interface MessageStartEvent {
  type: 'message_start';
  message: Omit<AnthropicResponse, 'content'> & { content: [] };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlockStart;
}

export type ContentBlockStart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string };

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentBlockDelta;
}

export type ContentBlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string };

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: StopReason;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export interface PingEvent {
  type: 'ping';
}

export interface ErrorEvent {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}
