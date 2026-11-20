/**
 * Bot API 10.1 rich messages (sendRichMessage), typed for the subset this bot sends: headings,
 * paragraphs and native tables. gramio 0.4 / @gramio/types 9.x predate the method, so the method
 * is added to gramio's APIMethods map; `bot.api.sendRichMessage` then runs through gramio's hooks
 * (rate limit, topic thread injection) like every other call.
 */
import type { TelegramMessage, TelegramParams } from '@gramio/types';

/** Inline formatting inside a rich block. Telegram also accepts a plain string or an array. */
export type RichText =
  | string
  | RichText[]
  | { type: 'bold' | 'italic' | 'strikethrough' | 'code'; text: RichText }
  | { type: 'url'; text: RichText; url: string };

export interface RichTableCell {
  text?: RichText;
  is_header?: true;
  /** Required by the Bot API on every cell. */
  align: 'left' | 'center' | 'right';
  /** Required by the Bot API on every cell. */
  valign: 'top' | 'middle' | 'bottom';
}

export type InputRichBlock =
  | { type: 'heading'; text: RichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: 'paragraph'; text: RichText }
  | {
      type: 'table';
      cells: RichTableCell[][];
      is_bordered?: true;
      is_striped?: true;
      is_compact?: true;
    };

/** InputRichMessage built from explicit blocks (the html/markdown variants are not used here). */
export interface InputRichMessage {
  blocks: InputRichBlock[];
}

export interface SendRichMessageParams
  extends Pick<
    TelegramParams.SendMessageParams,
    'chat_id' | 'message_thread_id' | 'disable_notification' | 'reply_markup'
  > {
  rich_message: InputRichMessage;
}

declare module '@gramio/types/methods' {
  interface APIMethods {
    /** https://core.telegram.org/bots/api#sendrichmessage */
    sendRichMessage: (params: SendRichMessageParams) => Promise<TelegramMessage>;
  }
}
