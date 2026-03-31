/** /ping command handler — responds with pong and current timestamp */
import { sendToChat } from '../send';

/**
 * /ping command handler
 */
export async function handlePingCommand(): Promise<void> {
  const timestamp = new Date().toISOString();
  await sendToChat(`pong\n${timestamp}`);
}
