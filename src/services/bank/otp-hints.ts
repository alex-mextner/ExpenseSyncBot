// Bank-specific OTP prompt hints shown alongside the plugin's own prompt text.
// Add entries per bank to guide users through each authentication step.

type OtpHint = {
  pattern: RegExp;
  hint: string;
};

const BANK_OTP_HINTS: Record<string, OtpHint[]> = {
  'tbc-ge': [
    {
      pattern: /Enter the code from SMS$/i,
      hint: 'TBC отправил 4-значный код на привязанный номер телефона. Введи именно этот код — не токен из ссылки.',
    },
    {
      pattern: /trust the device/i,
      hint: 'TBC просит подтвердить доверие устройству — это одноразовая операция. Введи 4-значный числовой код из SMS (не токен из ссылки вроде "xKFVduDh43e").',
    },
  ],
};

/**
 * Returns our additional hint for the given bank/prompt pair, or null if none configured.
 * bankName matches bank_connections.bank_name (e.g. 'tbc-ge').
 */
export function getOtpHint(bankName: string, prompt: string): string | null {
  const hints = BANK_OTP_HINTS[bankName];
  if (!hints) return null;
  return hints.find((h) => h.pattern.test(prompt))?.hint ?? null;
}
