/** /ping command handler — responds with pong and current timestamp */
import type { Ctx } from '../types';

/**
 * /ping command handler
 */
export async function handlePingCommand(ctx: Ctx['Command']): Promise<void> {
  const timestamp = new Date().toISOString();
  await ctx.send(`pong\n${timestamp}`);
}
