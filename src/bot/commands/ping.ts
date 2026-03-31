/** /ping command handler — responds with pong and current timestamp */
import { sendMessage } from '../../services/bank/telegram-sender';

/**
 * /ping command handler
 */
export async function handlePingCommand(): Promise<void> {
  const timestamp = new Date().toISOString();
  await sendMessage(`pong\n${timestamp}`);
}
