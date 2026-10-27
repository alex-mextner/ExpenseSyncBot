// Credential-entry step of the /bank setup wizard: consumes the user's text messages.
// Split out of ../bank.ts; the phases (mask → store → prompt next / finish) are separate
// functions so each stays small.
import { database } from '../../../database';
import type { BankConnection } from '../../../database/types';
import type { BankPlugin, CredentialField } from '../../../services/bank/registry';
import { lookupBank } from '../../../services/bank/registry';
import { activateNewConnection } from '../../../services/bank/sync-service';
import { sendMessage } from '../../../services/bank/telegram-sender';
import { decryptData, encryptData } from '../../../utils/crypto';
import { createLogger } from '../../../utils/logger.ts';
import type { BotInstance, Ctx } from '../../types';
import {
  buildConnectingText,
  buildFieldPromptText,
  rememberWizardPrompt,
  resolveFieldName,
  SECURITY_NOTE,
  wizardPromptMessages,
} from './wizard-prompts';

const logger = createLogger('bank-command');

function loadCollectedFields(connectionId: number): Record<string, string> {
  const credentials = database.bankCredentials.findByConnectionId(connectionId);
  return credentials
    ? (JSON.parse(decryptData(credentials.encrypted_data)) as Record<string, string>)
    : {};
}

function findUncollectedFields(
  fields: CredentialField[],
  collected: Record<string, string>,
): CredentialField[] {
  return fields.filter((f) => !collected[resolveFieldName(f)]);
}

/** Delete the user's answer to a sensitive prompt and replace the prompt with a masked line. */
async function maskSensitiveAnswer(
  ctx: Ctx['Message'],
  bot: BotInstance,
  chatId: number,
  prompt: { messageId: number; fieldPrompt: string },
  text: string,
): Promise<void> {
  try {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: ctx.id });
  } catch {
    // bot may lack delete permission or message already gone
  }
  try {
    await bot.api.editMessageText({
      chat_id: chatId,
      message_id: prompt.messageId,
      text: `🔒 ${prompt.fieldPrompt}: ${'•'.repeat(text.length)}${SECURITY_NOTE}`,
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // message may be too old or already edited
  }
}

async function promptForField(connectionId: number, field: CredentialField): Promise<void> {
  const sent = await sendMessage(buildFieldPromptText(field), {
    reply_markup: {
      inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'bank_wizard_cancel' }]],
    },
    link_preview_options: { is_disabled: true },
  });
  if (sent) {
    rememberWizardPrompt(connectionId, sent.message_id, field);
  }
}

/** Show the "connecting" panel and store its message ID so sync-service can update it. */
async function showConnectingPanel(
  ctx: Ctx['Message'],
  bot: BotInstance,
  setupConn: BankConnection,
  bankName: string,
  chatId: number,
): Promise<void> {
  const panelThreadId = (ctx.update?.message?.message_thread_id as number | undefined) ?? null;
  if (setupConn.panel_message_id) {
    // Reconnect path: edit the existing panel.
    await bot.api
      .editMessageText({
        chat_id: chatId,
        message_id: setupConn.panel_message_id,
        text: buildConnectingText(bankName),
      })
      .catch(() => {});
    return;
  }
  // Fresh connection: send a new panel message.
  const panelMsg = await sendMessage(buildConnectingText(bankName));
  if (panelMsg) {
    database.bankConnections.update(setupConn.id, {
      panel_message_id: panelMsg.message_id,
      panel_message_thread_id: panelThreadId,
    });
  }
}

/** All fields collected — merge auto-fill defaults, then activate the connection. */
async function completeWizard(
  ctx: Ctx['Message'],
  bot: BotInstance,
  setupConn: BankConnection,
  plugin: BankPlugin,
  collectedFields: Record<string, string>,
  chatId: number | undefined,
): Promise<void> {
  if (plugin.defaults && Object.keys(plugin.defaults).length > 0) {
    const merged = { ...plugin.defaults, ...collectedFields };
    database.bankCredentials.upsert(setupConn.id, encryptData(JSON.stringify(merged)));
  }

  wizardPromptMessages.delete(setupConn.id);
  database.bankConnections.update(setupConn.id, { status: 'active' });

  if (chatId) {
    await showConnectingPanel(ctx, bot, setupConn, plugin.name, chatId);
  }

  activateNewConnection(setupConn.id).catch((err) =>
    logger.error({ err, connectionId: setupConn.id }, 'Background activation failed'),
  );

  logger.info({ connectionId: setupConn.id, bank: setupConn.bank_name }, 'Bank wizard completed');
}

/**
 * Called from message.handler.ts when a message arrives and a setup wizard is active.
 * Returns true if the message was consumed by the wizard.
 */
export async function handleWizardInput(
  ctx: Ctx['Message'],
  groupId: number,
  text: string,
  bot: BotInstance,
): Promise<boolean> {
  const setupConn = database.bankConnections.findSetupByGroupId(groupId);

  if (!setupConn) return false;

  const bankFound = lookupBank(setupConn.bank_name);
  if (!bankFound) return false;
  const [, plugin] = bankFound;

  // Determine which credential field we're currently collecting
  const collectedFields = loadCollectedFields(setupConn.id);
  const remainingFields = findUncollectedFields(plugin.fields, collectedFields);

  if (remainingFields.length === 0) return false;

  const fieldName = resolveFieldName(remainingFields[0]);
  const chatId = ctx.chat?.id;

  // If this was a sensitive field, delete the user's message and mask the prompt
  const storedPrompt = wizardPromptMessages.get(setupConn.id);
  if (storedPrompt?.sensitive && chatId) {
    await maskSensitiveAnswer(ctx, bot, chatId, storedPrompt, text);
  }

  collectedFields[fieldName] = text;

  // Persist partial credentials
  database.bankCredentials.upsert(setupConn.id, encryptData(JSON.stringify(collectedFields)));

  const nextField = findUncollectedFields(plugin.fields, collectedFields)[0];
  if (nextField) {
    if (chatId) {
      await promptForField(setupConn.id, nextField);
    }
    return true;
  }

  await completeWizard(ctx, bot, setupConn, plugin, collectedFields, chatId);
  return true;
}
