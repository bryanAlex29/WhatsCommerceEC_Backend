import { jest } from '@jest/globals';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthError } from '../auth/errors.js';
import { verifyPassword } from '../auth/crypto.js';
import type { RateLimitPort } from '../auth/ports.js';
import { InvitationCrypto, InvitationService, deliverInvitation, reconcileReservations } from './invitations.js';
import type { DeliveryPort, InvitationPort, ReservationLimits } from './invitations.js';

function fixture() {
  const crypto = new InvitationCrypto(randomBytes(32));
  const p = { userId: randomUUID(), sessionId: randomUUID() }; const cid = randomUUID();
  const plan = { invitationId: randomUUID(), generation: 1, email: 'recipient@example.test' };
  const port: InvitationPort = {
    prepare: jest.fn<InvitationPort['prepare']>().mockResolvedValue(plan),
    emit: jest.fn<InvitationPort['emit']>().mockResolvedValue({ invitationId: plan.invitationId, expiresAt: '2026-11-15T00:00:00.000Z' }),
    accept: jest.fn<InvitationPort['accept']>().mockResolvedValue({ userId: p.userId, companyId: cid, role: 'COMPANY_ADMIN', companyStatus: 'ACTIVE' }),
  };
  const limits: ReservationLimits = {
    reserve: jest.fn<ReservationLimits['reserve']>().mockResolvedValue(undefined),
    release: jest.fn<ReservationLimits['release']>().mockResolvedValue(undefined),
    confirm: jest.fn<ReservationLimits['confirm']>().mockResolvedValue(undefined), pending: async () => [],
  };
  const ipLimits: RateLimitPort = { consume: jest.fn<RateLimitPort['consume']>().mockResolvedValue(undefined), checkLoginFailures: async () => {} };
  return { crypto, p, cid, plan, port, limits, ipLimits, service: new InvitationService(port, limits, ipLimits, crypto) };
}
describe('invitación inicial: criptografía real y puertos simulados', () => {
  it('32 bytes canónicos, hash separado por propósito y AAD por generación', () => {
    const f = fixture(); const token = f.crypto.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const sealed = f.crypto.seal(f.plan, token); const claimed = { ...sealed, ...f.plan, expiresAt: '2026-11-15T00:00:00.000Z' };
    expect(f.crypto.open(claimed)).toEqual({ email: f.plan.email, token });
    expect(() => f.crypto.open({ ...claimed, generation: 2 })).toThrow();
    expect(() => f.crypto.open({ ...claimed, invitationId: randomUUID() })).toThrow();
    expect(() => f.crypto.open({ ...claimed, tag: '00'.repeat(16) })).toThrow();
    expect(() => new InvitationCrypto(randomBytes(31))).toThrow();
  });
  it.each(['12345678', 'a'.repeat(42), 'a'.repeat(44), 'A'.repeat(42) + 'B', 'a'.repeat(43) + '\n'])('rechaza token no canónico %p', token => {
    expect(() => fixture().crypto.hash(token)).toThrow(AuthError);
  });
  it('normaliza correo; persiste hash/payload, nunca retorna token ni plan', async () => {
    const f = fixture(); const receipt = await f.service.emit(f.p, f.cid, ' Recipient@Example.Test ');
    expect(f.port.prepare).toHaveBeenCalledWith(f.p, f.cid, 'recipient@example.test');
    const call = jest.mocked(f.port.emit).mock.calls[0]!;
    const opened = f.crypto.open({ ...call[5], ...f.plan, expiresAt: receipt.expiresAt });
    expect(call[4]).toBe(f.crypto.hash(opened.token)); expect(call[6]).toBe(false);
    expect(Object.keys(receipt).sort()).toEqual(['expiresAt', 'invitationId']);
  });
  it('no reserva si autorización previa rechaza', async () => {
    const f = fixture(); jest.mocked(f.port.prepare).mockRejectedValue(new AuthError(403, 'FORBIDDEN'));
    await expect(f.service.emit(f.p, f.cid)).rejects.toMatchObject({ status: 403 });
    expect(f.limits.reserve).not.toHaveBeenCalled(); expect(f.port.emit).not.toHaveBeenCalled();
  });
  it('fallo Redis impide persistencia', async () => {
    const f = fixture(); jest.mocked(f.limits.reserve).mockRejectedValue(new AuthError(503, 'SERVICE_TEMPORARILY_UNAVAILABLE'));
    await expect(f.service.emit(f.p, f.cid)).rejects.toMatchObject({ status: 503 }); expect(f.port.emit).not.toHaveBeenCalled();
  });
  it.each([409, 429, 503])('libera solo rechazo definitivo %i', async status => {
    const f = fixture(); jest.mocked(f.port.emit).mockRejectedValue(new AuthError(status, 'TEST_REJECTION'));
    await expect(f.service.emit(f.p, f.cid)).rejects.toMatchObject({ status });
    expect(f.limits.release).toHaveBeenCalledTimes(status === 503 ? 0 : 1);
  });
  it('confirmación Redis fallida tras commit no convierte éxito en 503', async () => {
    const f = fixture(); jest.mocked(f.limits.confirm).mockRejectedValue(new Error('unavailable'));
    await expect(f.service.emit(f.p, f.cid)).resolves.toHaveProperty('invitationId');
    expect(f.limits.release).not.toHaveBeenCalled();
  });
  it('aceptación usa cuota compartida y hash Argon2id sin login automático', async () => {
    const f = fixture(); const token = f.crypto.token(); const password = 'SyntheticPassword!';
    await f.service.accept(token, 'synthetic-ip', undefined, password);
    expect(f.ipLimits.consume).toHaveBeenCalledWith('invitation-accept-ip', 'synthetic-ip');
    const [hash, principal, phc] = jest.mocked(f.port.accept).mock.calls[0]!;
    expect(hash).toBe(f.crypto.hash(token)); expect(principal).toBeUndefined(); expect(await verifyPassword(phc!, password)).toBe(true);
  });
  it('aceptación existente solo deriva identidad autenticada', async () => {
    const f = fixture(); const token = f.crypto.token(); await f.service.accept(token, 'ip', f.p);
    expect(f.port.accept).toHaveBeenCalledWith(f.crypto.hash(token), f.p, undefined);
  });
  it('contraseña inválida no persiste usuario', async () => {
    const f = fixture(); await expect(f.service.accept(f.crypto.token(), 'ip', undefined, 'short!')).rejects.toMatchObject({ status: 400 });
    expect(f.port.accept).not.toHaveBeenCalled();
  });
  it('reconciliación nunca libera ausencia incierta', async () => {
    const f = fixture(); const ids = [randomUUID(), randomUUID()]; f.limits.pending = async () => ids;
    const port = { emitted: async (id: string) => id === ids[0] } as DeliveryPort;
    await reconcileReservations(f.limits, port);
    expect(f.limits.confirm).toHaveBeenCalledTimes(1); expect(f.limits.confirm).toHaveBeenCalledWith(ids[0]); expect(f.limits.release).not.toHaveBeenCalled();
  });
  it.each(['expired', 'invalidated', 'smtp-failure', 'accepted'] as const)('entrega condicionada %s', async scenario => {
    const f = fixture(); const token = f.crypto.token();
    const claim = { ...f.crypto.seal(f.plan, token), ...f.plan, expiresAt: new Date(scenario === 'expired' ? 0 : Date.now() + 60000).toISOString() };
    const delivery: DeliveryPort = { pending: async () => [], emitted: async () => false, claim: async () => claim,
      canSend: async () => scenario !== 'invalidated', finish: jest.fn<DeliveryPort['finish']>().mockResolvedValue(undefined) };
    const send = jest.fn<(email: string, token: string) => Promise<boolean>>().mockResolvedValue(scenario === 'accepted');
    const work = deliverInvitation(randomUUID(), 1, delivery, f.crypto, { send });
    if (scenario === 'accepted') await work; else await expect(work).rejects.toThrow('INVITATION_DELIVERY_UNCONFIRMED');
    expect(send).toHaveBeenCalledTimes(['accepted', 'smtp-failure'].includes(scenario) ? 1 : 0);
    expect(delivery.finish).toHaveBeenCalledWith(expect.any(String), 1, expect.any(String), scenario === 'accepted');
  });
});
