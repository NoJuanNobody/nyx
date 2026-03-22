import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../services/encryption.service.js';

const TEST_SECRET = 'test-byok-encryption-secret-32chars!';

describe('Encryption Service', () => {
  it('round-trips: encrypt then decrypt returns original plaintext', () => {
    const plaintext = 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx';
    const payload = encrypt(plaintext, TEST_SECRET);
    const result = decrypt(payload, TEST_SECRET);
    expect(result).toBe(plaintext);
  });

  it('produces different ciphertext on each call (unique IV)', () => {
    const plaintext = 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx';
    const a = encrypt(plaintext, TEST_SECRET);
    const b = encrypt(plaintext, TEST_SECRET);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('decryption with wrong secret throws', () => {
    const plaintext = 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx';
    const payload = encrypt(plaintext, TEST_SECRET);
    expect(() => decrypt(payload, 'wrong-secret-that-is-at-least-long')).toThrow();
  });

  it('decryption with tampered ciphertext throws', () => {
    const plaintext = 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx';
    const payload = encrypt(plaintext, TEST_SECRET);
    // Flip a character in the ciphertext
    const tampered = payload.ciphertext.slice(0, -2) + 'AA';
    expect(() => decrypt({ ciphertext: tampered, iv: payload.iv }, TEST_SECRET)).toThrow();
  });

  it('handles empty string', () => {
    const payload = encrypt('', TEST_SECRET);
    const result = decrypt(payload, TEST_SECRET);
    expect(result).toBe('');
  });

  it('handles long keys', () => {
    const longKey = 'sk-ant-' + 'x'.repeat(200);
    const payload = encrypt(longKey, TEST_SECRET);
    const result = decrypt(payload, TEST_SECRET);
    expect(result).toBe(longKey);
  });
});
