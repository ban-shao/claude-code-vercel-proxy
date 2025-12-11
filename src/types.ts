// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | SystemContent[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  thinking?: {
    type: 'enabled' | 'disabled';
    budget_tokens?: number;
  };
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface CacheControl {
  type: 'ephemeral';
  ttl?: string;
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'document';
  text?: string;
  thinking?: string;
  source?: {
    type: string;
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  cache_control?: CacheControl;
}

export interface SystemContent {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  cache_control?: CacheControl;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, any>;
  required?: string[];
  description?: string;
}

export type AnthropicToolChoice =
  | 'auto'
  | 'none'
  | { type: 'any' }
  | { type: 'tool'; name: string };

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface AnthropicError {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

// ==================== Key Status ====================

export interface KeyStatus {
  disabledAt: number;      // Timestamp when key was disabled
  reason: string;          // Reason for disabling
  lastResetMonth: number;  // Month when last reset happened (1-12)
}

// ==================== Environment ====================

export interface Env {
  // Multiple keys separated by commas
  VERCEL_AI_GATEWAY_KEYS: string;
  // Legacy single key support (fallback)
  VERCEL_AI_GATEWAY_KEY?: string;
  // KV namespace for storing key status
  KEY_STATUS: KVNamespace;
}
