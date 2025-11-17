/**
 * Bot context types
 */
import type {
  Bot,
  CallbackQueryContext,
  DeriveDefinitions,
  ErrorDefinitions,
  MessageContext,
} from "gramio";

/**
 * Helper to make specific properties required and non-nullable
 */
type Require<T, K extends keyof T> = Omit<T, K> & {
  [P in K]-?: NonNullable<T[P]>;
};

/**
 * Type alias for Bot instance
 */
type BotInstance = Bot<ErrorDefinitions, DeriveDefinitions>;

/**
 * Context types for different update handlers
 */
export type Ctx = {
  /**
   * Callback query context (inline keyboard buttons)
   */
  CallbackQuery: CallbackQueryContext<BotInstance>;

  /**
   * Message context (regular messages, commands)
   * Requires 'from' field to be present
   */
  Message: Require<MessageContext<BotInstance>, "from">;

  /**
   * Command context (same as Message, used for clarity)
   */
  Command: Require<MessageContext<BotInstance>, "from">;
};
