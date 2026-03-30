import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { config } from './config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = 'nyx-atlassian-token-encryption';
const HKDF_INFO = 'aes-256-gcm-key';

/**
 * Derive a 32-byte encryption key from the ENCRYPTION_SECRET using HKDF.
 * Uses SHA-256 as the underlying hash with a fixed salt and info string.
 */
function getKey(): Buffer {
  const secret = config.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error('ENCRYPTION_SECRET is not configured');
  }
  const derived = hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, 32);
  return Buffer.from(derived);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing: IV + ciphertext + auth tag.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: IV (12) + tag (16) + ciphertext
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext that was produced by `encrypt()`.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const packed = Buffer.from(ciphertext, 'base64');

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
