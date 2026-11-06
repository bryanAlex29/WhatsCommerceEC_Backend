import { createHash, randomBytes } from 'node:crypto';
import { argon2id, hash, verify } from 'argon2';
import { SignJWT, compactVerify } from 'jose';
import { AuthError } from './errors.js';
import { uuid } from './input.js';

export const passwordOptions = { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 } as const;
export const hashPassword = (password: string): Promise<string> => hash(password, { ...passwordOptions, salt: randomBytes(16) });
export const verifyPassword = (phc: string, password: string): Promise<boolean> => verify(phc, password);
export const randomRefresh = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string => createHash('sha256').update('refresh\0').update(token).digest('hex');
export interface Principal { userId: string; sessionId: string }
export class AccessTokens {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength < 32) throw new Error('Configuración JWT inválida');
  }
  issue(principal: Principal): Promise<string> {
    return new SignJWT({ sid: principal.sessionId }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(principal.userId).setIssuer('whatscommerceec-api').setAudience('whatscommerceec-clients')
      .setIssuedAt().setExpirationTime('15m').sign(this.key);
  }
  async verify(token: string): Promise<Principal> {
    if (token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new AuthError(401, 'UNAUTHENTICATED');
    try {
      // Verify signature first; classify expiry only after all other claims are valid.
      const verified = await compactVerify(token, this.key, { algorithms: ['HS256'] });
      const payload: Record<string, unknown> = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload)) as Record<string, unknown>;
      if (verified.protectedHeader.typ !== 'JWT' || payload.iss !== 'whatscommerceec-api' ||
          payload.aud !== 'whatscommerceec-clients') throw new Error('claims');
      if (typeof payload.sub !== 'string' || !uuid.test(payload.sub) || typeof payload.sid !== 'string' ||
          !uuid.test(payload.sid) || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
          !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || 'nbf' in payload ||
          payload.iat > Math.floor(Date.now() / 1000) || payload.exp - payload.iat !== 900) throw new Error('claims');
      if (payload.exp <= Math.floor(Date.now() / 1000)) throw new AuthError(401, 'ACCESS_TOKEN_EXPIRED');
      return { userId: payload.sub, sessionId: payload.sid };
    } catch (error) {
      if (error instanceof AuthError && error.code === 'ACCESS_TOKEN_EXPIRED') throw error;
      throw new AuthError(401, 'UNAUTHENTICATED');
    }
  }
}
