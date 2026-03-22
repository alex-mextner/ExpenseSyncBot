// src/errors.ts
// Typed error classes for external service failures

export class AnthropicError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AnthropicError';
  }
}

export class NetworkError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}
