// Shared state and text builders of the /bank setup wizard.
// Split out of ../bank.ts so the wizard input handler, the wizard callbacks and the
// /bank command all use one prompt-tracking map without importing each other.
import type { CredentialField } from '../../../services/bank/registry';

// ─── Wizard prompt tracking ───────────────────────────────────────────────────
// Maps connectionId → last sent prompt info so we can mask sensitive inputs.

type WizardPromptEntry = {
  messageId: number;
  sensitive: boolean; // whether this prompt was for a sensitive field
  fieldPrompt: string; // prompt label, e.g. "Пароль TBC"
};
export const wizardPromptMessages = new Map<number, WizardPromptEntry>();

export function resolveFieldName(field: CredentialField | undefined): string {
  if (!field) return '';
  return typeof field === 'string' ? field : field.name;
}

export function resolveFieldPrompt(field: CredentialField | undefined): string {
  if (!field) return '';
  if (typeof field === 'string') return field;
  return field.prompt ?? field.name;
}

export function isPasswordField(field: CredentialField | undefined): boolean {
  return (
    typeof field !== 'string' && !!field && (field.type === 'password' || field.type === 'otp')
  );
}

/** Remember which message prompts for `field` so the user's answer can be masked later. */
export function rememberWizardPrompt(
  connectionId: number,
  messageId: number,
  field: CredentialField | undefined,
): void {
  wizardPromptMessages.set(connectionId, {
    messageId,
    sensitive: isPasswordField(field),
    fieldPrompt: resolveFieldPrompt(field),
  });
}

export const SECURITY_NOTE =
  '\n\n🔒 Пароль шифруется алгоритмом AES-256-GCM и хранится только на сервере бота — никуда не передаётся. Транзакции получаем через открытую библиотеку ZenPlugins: github.com/zenmoney/ZenPlugins';

export function buildFieldPromptText(field: CredentialField | undefined): string {
  const prompt = resolveFieldPrompt(field);
  return `${prompt}:${isPasswordField(field) ? SECURITY_NOTE : ''}`;
}

export function buildWizardInfoText(bankName: string): string {
  return (
    `🏦 ${bankName}\n\n` +
    `После подключения бот будет автоматически синхронизировать баланс каждые 30 минут.\n\n` +
    `Синхронизация транзакций и карточки в чате (предложить категорию через ИИ, дождаться ` +
    `твоего подтверждения и записать расход в Google Sheets) по умолчанию выключены — ` +
    `включи их в /settings, когда будешь готов.\n\n` +
    `Транзакции получаем через ZenPlugins — open-source: github.com/zenmoney/ZenPlugins`
  );
}

export function buildWizardStartText(
  bankName: string,
  firstField: CredentialField | undefined,
): string {
  return `🏦 ${bankName} — данные для входа\n\n${buildFieldPromptText(firstField)}`;
}

export function buildConnectingText(bankName: string): string {
  return `⏳ ${bankName} — подключаем...\n\nПервая синхронизация запущена. Статус появится здесь.`;
}
