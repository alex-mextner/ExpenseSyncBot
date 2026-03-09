/**
 * Types for the Anthropic AI agent
 */

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface ToolCallResult {
  id: string;
  result: ToolResult;
}

export interface AgentContext {
  groupId: number;
  userId: number;
  chatId: number;
  userName: string;
  userFullName: string;
  customPrompt: string | null;
  telegramGroupId: number;
}
