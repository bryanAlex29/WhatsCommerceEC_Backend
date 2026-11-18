import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from '../auth/crypto.js';
import type { Principal } from '../auth/crypto.js';
import { AuthError } from '../auth/errors.js';
import { canonicalEmail, newPasswordValid, refreshFormat } from '../auth/input.js';
import type { RateLimitPort } from '../auth/ports.js';

export interface Plan { invitationId: string; generation: number; email: string }
export interface Sealed { payload: string; nonce: string; tag: string; keyId: 'v1' }
export interface Receipt { invitationId: string; expiresAt: string }
export interface Acceptance { userId: string; companyId: string; role: 'COMPANY_ADMIN'; companyStatus: 'ACTIVE' }
export interface InvitationPort {
  prepare(principal: Principal, companyId: string, email: string | undefined): Promise<Plan>;
  emit(principal: Principal, companyId: string, operationId: string, plan: Plan, hash: string, sealed: Sealed, resend: boolean): Promise<Receipt>;
  accept(hash: string, principal: Principal | undefined, passwordHash?: string): Promise<Acceptance>;
}
export interface ReservationLimits {
  reserve(operationId: string, companyId: string, adminId: string): Promise<void>;
  release(operationId: string): Promise<void>;
  confirm(operationId: string): Promise<void>;
  pending(): Promise<string[]>;
}
export interface Claimed extends Sealed { invitationId: string; generation: number; expiresAt: string }
export interface DeliveryPort {
  pending(): Promise<Array<{ id: string; generation: number }>>;
  claim(id: string, generation: number, lease: string): Promise<Claimed | null>;
  canSend(id: string, generation: number, lease: string): Promise<boolean>;
  finish(id: string, generation: number, lease: string, accepted: boolean): Promise<void>;
  emitted(operationId: string): Promise<boolean>;
}
function tokenValid(token: string): boolean {
  return refreshFormat.test(token) && Buffer.from(token, 'base64url').toString('base64url') === token;
}
export class InvitationCrypto {
  constructor(private readonly key: Buffer) { if (key.length !== 32) throw new Error('Configuración de invitación inválida'); }
  token(): string { return randomBytes(32).toString('base64url'); }
  hash(token: string): string {
    if (!tokenValid(token)) throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa el código de invitación', [{ field: 'invitationToken', code: 'FORMAT' }]);
    return createHash('sha256').update('invitation\0').update(token).digest('hex');
  }
  seal(plan: Plan, token: string): Sealed {
    this.hash(token);
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`initial-invitation:v1\0${plan.invitationId}\0${plan.generation}`));
    const payload = Buffer.concat([cipher.update(JSON.stringify({ email: plan.email, token })), cipher.final()]);
    return { payload: payload.toString('hex'), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), keyId: 'v1' };
  }
  open(value: Claimed): { email: string; token: string } {
    if (value.keyId !== 'v1') throw new Error('Payload inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.nonce, 'hex'));
    decipher.setAAD(Buffer.from(`initial-invitation:v1\0${value.invitationId}\0${value.generation}`));
    decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    const raw: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.payload, 'hex')), decipher.final()]).toString('utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('Payload inválido');
    const v = raw as Record<string, unknown>;
    if (typeof v.email !== 'string' || canonicalEmail(v.email) !== v.email || typeof v.token !== 'string' || !tokenValid(v.token)) throw new Error('Payload inválido');
    return { email: v.email, token: v.token };
  }
}
export class InvitationService {
  constructor(private readonly port: InvitationPort, private readonly limits: ReservationLimits,
    private readonly acceptanceLimits: RateLimitPort, private readonly crypto: InvitationCrypto) {}
  async emit(principal: Principal, companyId: string, email?: string): Promise<Receipt> {
    const normalized = email === undefined ? undefined : canonicalEmail(email);
    const plan = await this.port.prepare(principal, companyId, normalized);
    const operationId = randomUUID(); const token = this.crypto.token();
    const sealed = this.crypto.seal(plan, token);
    await this.limits.reserve(operationId, companyId, principal.userId);
    let receipt: Receipt;
    try { receipt = await this.port.emit(principal, companyId, operationId, plan, this.crypto.hash(token), sealed, email === undefined); }
    catch (error) {
      // Only definitive business rejections (no committed emission) can release
      // their own reservation. 503/transport ambiguity stays conservative.
      if (error instanceof AuthError && error.status !== 503) await this.limits.release(operationId).catch(() => undefined);
      throw error;
    }
    // A Redis failure after confirmed PG commit must NOT turn it into a second emission.
    await this.limits.confirm(operationId).catch(() => undefined);
    return receipt;
  }
  async accept(token: string, ip: string, principal?: Principal, password?: string): Promise<Acceptance> {
    await this.acceptanceLimits.consume('invitation-accept-ip', ip);
    const hash = this.crypto.hash(token);
    if (!principal && (password === undefined || !newPasswordValid(password))) {
      throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa la contraseña', [{ field: 'password', code: 'PASSWORD_POLICY' }]);
    }
    return this.port.accept(hash, principal, principal ? undefined : await hashPassword(password!));
  }
}
export interface InvitationMailer { send(email: string, token: string): Promise<boolean> }
export async function deliverInvitation(id: string, generation: number, port: DeliveryPort, crypto: InvitationCrypto,
  mailer: InvitationMailer, now = () => Date.now()): Promise<void> {
  const lease = randomUUID(); const claimed = await port.claim(id, generation, lease);
  if (!claimed) return;
  let accepted = false;
  try {
    const message = crypto.open(claimed);
    if (Date.parse(claimed.expiresAt) > now() && await port.canSend(id, generation, lease)) {
      accepted = await mailer.send(message.email, message.token);
    }
  } catch { /* No token, recipient or SMTP diagnostics in queue errors/logs. */ }
  await port.finish(id, generation, lease, accepted);
  if (!accepted) throw new Error('INVITATION_DELIVERY_UNCONFIRMED');
}
export async function reconcileReservations(limits: ReservationLimits, port: DeliveryPort): Promise<void> {
  for (const id of await limits.pending()) {
    // Absence after an uncertain outcome is NOT proof of rollback. Only confirm
    // positive commits; uncertain reservations expire in their approved windows.
    if (await port.emitted(id)) await limits.confirm(id);
  }
}
