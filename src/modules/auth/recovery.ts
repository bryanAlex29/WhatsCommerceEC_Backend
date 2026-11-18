import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { hashPassword } from './crypto.js';
import { AuthError } from './errors.js';
import { canonicalEmail, newPasswordValid } from './input.js';
import type { RateLimitPort } from './ports.js';

export const recoveryMessage = 'Si el correo está registrado, recibirás un código de recuperación.';
export interface SealedRecovery { payload: string; nonce: string; tag: string }
export interface RecoveryPort {
  request(email: string, id: string, mac: string, sealed: SealedRecovery): Promise<void>;
  reset(email: string, mac: string, passwordHash: string): Promise<boolean>;
}
export interface RecoveryDeliveryPort {
  pending(): Promise<string[]>;
  claim(id: string, lease: string): Promise<SealedRecovery | null>;
  finish(id: string, lease: string, accepted: boolean): Promise<void>;
}
export class RecoveryCrypto {
  constructor(private readonly macKey: Buffer, private readonly encryptionKey: Buffer) {
    if (macKey.length !== 32 || encryptionKey.length !== 32 || macKey.equals(encryptionKey)) throw new Error('Configuración de recuperación inválida');
  }
  code(): string { return String(randomInt(100000000)).padStart(8, '0'); }
  mac(email: string, code: string): string {
    return createHmac('sha256', this.macKey).update('password-recovery\0').update(email).update('\0').update(code).digest('hex');
  }
  seal(id: string, email: string, code: string): SealedRecovery {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`password-recovery\0${id}`));
    const payload = Buffer.concat([cipher.update(JSON.stringify({ email, code }), 'utf8'), cipher.final()]);
    return { payload: payload.toString('hex'), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
  }
  open(id: string, sealed: SealedRecovery): { email: string; code: string } {
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(sealed.nonce, 'hex'));
    decipher.setAAD(Buffer.from(`password-recovery\0${id}`));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
    const result: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.payload, 'hex')), decipher.final()]).toString('utf8'));
    if (!result || typeof result !== 'object') throw new Error('Payload inválido');
    const value = result as Record<string, unknown>;
    if (typeof value.email !== 'string' || canonicalEmail(value.email) !== value.email || typeof value.code !== 'string' || !/^[0-9]{8}$/.test(value.code)) throw new Error('Payload inválido');
    return { email: value.email, code: value.code };
  }
}
export class RecoveryService {
  constructor(private readonly persistence: RecoveryPort, private readonly limits: RateLimitPort, private readonly crypto: RecoveryCrypto) {}
  async request(email: string, ip: string): Promise<{ message: string }> {
    await this.limits.consume('recovery-ip', ip);
    const normalized = canonicalEmail(email);
    // Reservas conservadoras, también para cuentas inexistentes. No se reembolsan.
    await this.limits.consume('recovery-email-minute', normalized);
    await this.limits.consume('recovery-email-hour', normalized);
    const id = randomUUID(); const code = this.crypto.code();
    await this.persistence.request(normalized, id, this.crypto.mac(normalized, code), this.crypto.seal(id, normalized, code));
    return { message: recoveryMessage };
  }
  async reset(email: string, code: string, password: string, ip: string): Promise<void> {
    await this.limits.consume('recovery-reset-ip', ip);
    const normalized = canonicalEmail(email);
    if (!/^[0-9]{8}$/.test(code)) throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa el código', [{ field: 'code', code: 'FORMAT' }]);
    if (!newPasswordValid(password)) throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa la contraseña', [{ field: 'password', code: 'PASSWORD_POLICY' }]);
    // El mismo coste Argon2id para cuentas/códigos existentes e inexistentes.
    const phc = await hashPassword(password);
    const accepted = await this.persistence.reset(normalized, this.crypto.mac(normalized, code), phc);
    // Error fuera de la transacción: los intentos incorrectos deben quedar confirmados.
    if (!accepted) throw new AuthError(400, 'INVALID_RECOVERY_CODE', 'Código inválido o vencido');
  }
}

export interface RecoveryMailer { send(email: string, code: string): Promise<boolean> }
export async function deliverRecovery(id: string, port: RecoveryDeliveryPort, crypto: RecoveryCrypto, mailer: RecoveryMailer): Promise<void> {
  const lease = randomUUID();
  const sealed = await port.claim(id, lease);
  if (!sealed) return;
  let accepted = false;
  try { const value = crypto.open(id, sealed); accepted = await mailer.send(value.email, value.code); }
  catch { /* Solo estado técnico; nunca detalles SMTP o payloads. */ }
  await port.finish(id, lease, accepted);
}
