import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte encryption key from the BYOK_ENCRYPTION_SECRET using HKDF (SHA-256).
 */
function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'nyx-salt', 'nyx-byok-encryption', 32));
}

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string;         // base64
}

/**
 * Encrypt a plaintext API key using AES-256-GCM.
 * Returns base64-encoded ciphertext (with appended auth tag) and IV.
 */
export function encrypt(plaintext: string, secret: string): EncryptedPayload {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Store ciphertext + authTag together
  const combined = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext: combined.toString('base64'),
    iv: iv.toString('base64'),
  };
}

/**
 * Decrypt a ciphertext that was encrypted with encrypt().
 * Throws if the auth tag is invalid (tampered data).
 */
export function decrypt(payload: EncryptedPayload, secret: string): string {
  const key = deriveKey(secret);
  const iv = Buffer.from(payload.iv, 'base64');
  const combined = Buffer.from(payload.ciphertext, 'base64');

  // Split ciphertext and auth tag
  const encrypted = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
