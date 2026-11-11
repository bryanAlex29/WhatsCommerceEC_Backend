import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Principal } from './crypto.js';
import { AuthError } from './errors.js';
import { uuid } from './input.js';

interface Position { createdAt: string; id: string }
export class CompanyCursor {
  constructor(private readonly key: Uint8Array, private readonly now = () => Date.now(),
    private readonly scope = 'me-companies') {
    if (key.byteLength !== 32) throw new Error('Configuración de cursor inválida');
  }
  encode(position: Position, principal: Principal): string {
    this.position(position);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`whatscommerceec:${this.scope}:v1`));
    const iat = this.now();
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ ...position, ...principal, iat, exp: iat + 900000 })), cipher.final()]);
    return ['v1', nonce.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }
  decode(cursor: string, principal: Principal): Position {
    try {
      if (cursor.length > 2048 || !/^[\x21-\x7e]+$/.test(cursor)) throw new Error();
      const parts = cursor.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error();
      const decode = (part: string) => {
        if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error();
        const value = Buffer.from(part, 'base64url');
        if (value.toString('base64url') !== part) throw new Error();
        return value;
      };
      const nonce = decode(parts[1] ?? '');
      const ciphertext = decode(parts[2] ?? '');
      const tag = decode(parts[3] ?? '');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(Buffer.from(`whatscommerceec:${this.scope}:v1`));
      decipher.setAuthTag(tag);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([decipher.update(ciphertext), decipher.final()])));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const item = value as Record<string, unknown>;
      if (item.userId !== principal.userId || item.sessionId !== principal.sessionId
        || typeof item.iat !== 'number' || typeof item.exp !== 'number'
        || !Number.isSafeInteger(item.iat) || !Number.isSafeInteger(item.exp)
        || item.iat > this.now() || item.exp <= this.now() || item.exp - item.iat !== 900000
        || typeof item.createdAt !== 'string' || typeof item.id !== 'string') throw new Error();
      const position = { createdAt: item.createdAt, id: item.id };
      this.position(position);
      return position;
    } catch { throw new AuthError(400, 'INVALID_CURSOR', 'Cursor inválido'); }
  }
  private position(position: Position): void {
    const date = new Date(position.createdAt);
    if (!uuid.test(position.id) || !Number.isFinite(date.getTime()) || date.toISOString() !== position.createdAt) {
      throw new AuthError(400, 'INVALID_CURSOR', 'Cursor inválido');
    }
  }
}
