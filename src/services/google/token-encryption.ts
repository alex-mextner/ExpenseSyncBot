// AES-256-GCM encryption/decryption for Google OAuth refresh tokens
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Validate that the key is a 32-byte hex string (64 hex chars).
 * Throws if invalid.
 */
function validateHexKey(hexKey: string): Buffer {
  if (hexKey.length !== 64) {
    throw new Error(`Encryption key must be 64 hex characters (32 bytes), got ${hexKey.length}`);
  }
  const keyBuffer = Buffer.from(hexKey, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error('Encryption key contains invalid hex characters');
  }
  // Verify round-trip: if the hex contained invalid chars, Buffer.from silently ignores them
  if (keyBuffer.toString('hex') !== hexKey.toLowerCase()) {
    throw new Error('Encryption key contains invalid hex characters');
  }
  return keyBuffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns format: `iv:authTag:ciphertext` (all hex-encoded).
 */
export function encryptToken(plaintext: string, hexKey: string): string {
  const key = validateHexKey(hexKey);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a token encrypted with encryptToken().
 * Input format: `iv:authTag:ciphertext` (all hex-encoded).
 */
export function decryptToken(encrypted: string, hexKey: string): string {
  const key = validateHexKey(hexKey);

  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid encrypted token format: expected 3 colon-separated parts, got ${parts.length}`,
    );
  }

  // Safe to assert after length check above
  const ivHex = parts[0] as string;
  const authTagHex = parts[1] as string;
  const ciphertextHex = parts[2] as string;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes, got ${iv.length}`);
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error(
      `Invalid auth tag length: expected ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`,
    );
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Check if a stored token looks encrypted (has the iv:authTag:ciphertext format).
 * Plaintext Google refresh tokens never contain colons.
 */
export function isEncryptedToken(token: string): boolean {
  const parts = token.split(':');
  if (parts.length !== 3) return false;
  // Safe to assert after length check above
  const ivPart = parts[0] as string;
  const tagPart = parts[1] as string;
  const ctPart = parts[2] as string;
  // IV = 24 hex chars, auth tag = 32 hex chars, ciphertext is non-empty
  return ivPart.length === 24 && tagPart.length === 32 && ctPart.length > 0;
}
