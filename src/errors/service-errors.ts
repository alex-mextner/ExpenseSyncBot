// Typed error classes for external service failures

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class GoogleSheetsError extends AppError {}
// Used for HuggingFace Inference API (OCR, receipt AI services)
export class HuggingFaceError extends AppError {}
// Used for Anthropic SDK (main AI agent in src/services/ai/agent.ts)
export class AnthropicError extends AppError {}
export class NetworkError extends AppError {}
export class OAuthError extends AppError {}

/** AI agent error — user-facing message already sent to Telegram, no further action needed */
export class AgentError extends AppError {
  constructor(public readonly userMessage: string) {
    super(userMessage, 'AGENT_ERROR');
  }
}
