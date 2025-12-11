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
}

export interface SystemContent {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
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
  };
}

export interface AnthropicError {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}

// ==================== Environment ====================

export interface Env {
  VERCEL_AI_GATEWAY_KEY: string;
}
