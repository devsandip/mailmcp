import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

/** Encrypts Google refresh tokens at rest. `context` binds a ciphertext to one account. */
export interface TokenCipher {
  encrypt(plaintext: string, context: string): Promise<string>;
  decrypt(ciphertext: string, context: string): Promise<string>;
}

export class KmsCipher implements TokenCipher {
  constructor(
    private keyId: string,
    private kms = new KMSClient({}),
  ) {}

  async encrypt(plaintext: string, context: string): Promise<string> {
    const res = await this.kms.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, 'utf8'),
        EncryptionContext: { account: context },
      }),
    );
    return Buffer.from(res.CiphertextBlob!).toString('base64');
  }

  async decrypt(ciphertext: string, context: string): Promise<string> {
    const res = await this.kms.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(ciphertext, 'base64'),
        EncryptionContext: { account: context },
      }),
    );
    return Buffer.from(res.Plaintext!).toString('utf8');
  }
}

/** AES-256-GCM with a local key. For development and tests only. */
export class LocalCipher implements TokenCipher {
  private key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }

  async encrypt(plaintext: string, context: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  async decrypt(ciphertext: string, context: string): Promise<string> {
    const raw = Buffer.from(ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
