import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module before importing encryption
vi.mock('../config.js', () => ({
  config: {
    ENCRYPTION_SECRET: 'test-encryption-secret-for-vitest-32chars!',
  },
}));

import { encrypt, decrypt } from '../encryption.js';

describe('encryption', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('encrypts and decrypts a short string', () => {
      const plaintext = 'hello-world';
      const ciphertext = encrypt(plaintext);
      expect(ciphertext).not.toBe(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('encrypts and decrypts a long token', () => {
      const plaintext = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.long-oauth-access-token-value-here.signature';
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('encrypts and decrypts empty string', () => {
      const plaintext = '';
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });

    it('encrypts and decrypts unicode content', () => {
      const plaintext = 'Token with unicode: \u00e9\u00e8\u00ea\u00eb \u{1f680}';
      const ciphertext = encrypt(plaintext);
      expect(decrypt(ciphertext)).toBe(plaintext);
    });
  });

  describe('encryption properties', () => {
    it('produces different ciphertext for same plaintext (unique IV)', () => {
      const plaintext = 'same-input';
      const c1 = encrypt(plaintext);
      const c2 = encrypt(plaintext);
      expect(c1).not.toBe(c2);
      // Both still decrypt to the same value
      expect(decrypt(c1)).toBe(plaintext);
      expect(decrypt(c2)).toBe(plaintext);
    });

    it('produces base64-encoded output', () => {
      const ciphertext = encrypt('test');
      // Should be valid base64
      expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
    });
  });

  describe('decryption error handling', () => {
    it('throws on tampered ciphertext', () => {
      const ciphertext = encrypt('secret');
      const tampered = ciphertext.slice(0, -4) + 'XXXX';
      expect(() => decrypt(tampered)).toThrow();
    });

    it('throws on completely invalid input', () => {
      expect(() => decrypt('not-a-valid-ciphertext')).toThrow();
    });
  });
});
