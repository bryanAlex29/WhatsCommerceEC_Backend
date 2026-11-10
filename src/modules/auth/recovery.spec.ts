import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { RecoveryCrypto, RecoveryService, deliverRecovery, recoveryMessage } from './recovery.js';
import type { RecoveryPort, RecoveryDeliveryPort, RecoveryMailer } from './recovery.js';
import type { RateLimitPort } from './ports.js';
import { verifyPassword } from './crypto.js';
import { AuthError } from './errors.js';

const email = 'synthetic@example.test'; const password = 'SyntheticNewPassword!';
function fixture() {
  const crypto = new RecoveryCrypto(randomBytes(32),randomBytes(32));
  const persistence: RecoveryPort = { request: jest.fn<RecoveryPort['request']>().mockResolvedValue(undefined), reset: jest.fn<RecoveryPort['reset']>().mockResolvedValue(true) };
  const limits: RateLimitPort = { checkLoginFailures: async () => {}, consume: jest.fn<RateLimitPort['consume']>().mockResolvedValue(undefined) };
  return { crypto,persistence,limits,service: new RecoveryService(persistence,limits,crypto) };
}
describe('recuperación: criptografía real, puertos simulados, sin SMTP', () => {
  it('códigos ocho dígitos, MAC ligado a correo y separación de claves', () => {
    const f=fixture();
    for (let i=0;i<50;i++) expect(f.crypto.code()).toMatch(/^[0-9]{8}$/);
    expect(f.crypto.mac(email,'00001234')).not.toBe(f.crypto.mac('other@example.test','00001234'));
    const key=randomBytes(32); expect(() => new RecoveryCrypto(key,key)).toThrow();
  });
  it('AES-GCM ligado al id y autenticación contra manipulación', () => {
    const {crypto}=fixture(); const sealed=crypto.seal('id-a',email,'00001234');
    expect(crypto.open('id-a',sealed)).toEqual({email,code:'00001234'});
    expect(sealed.payload).not.toContain(Buffer.from('00001234').toString('hex'));
    expect(() => crypto.open('id-b',sealed)).toThrow();
    expect(() => crypto.open('id-a',{...sealed,tag:'0'.repeat(32)})).toThrow();
  });
  it('solicita genéricamente sin consultar existencia en cliente, reserva cuotas y cifra código', async () => {
    const f=fixture();
    expect(await f.service.request(' SYNTHETIC@example.test ','ip')).toEqual({message:recoveryMessage});
    expect(jest.mocked(f.limits.consume).mock.calls).toEqual([['recovery-ip','ip'],['recovery-email-minute',email],['recovery-email-hour',email]]);
    const [normalized,id,mac,sealed]=jest.mocked(f.persistence.request).mock.calls[0]!;
    expect(normalized).toBe(email); const opened=f.crypto.open(id,sealed);
    expect(mac).toBe(f.crypto.mac(email,opened.code));
  });
  it('fallo Redis impide emisión y no degrada a bypass', async () => {
    const f=fixture(); jest.mocked(f.limits.consume).mockRejectedValue(new AuthError(503,'SERVICE_TEMPORARILY_UNAVAILABLE'));
    await expect(f.service.request(email,'ip')).rejects.toMatchObject({status:503});
    expect(f.persistence.request).not.toHaveBeenCalled();
  });
  it.each(['123','１２３４５６７８',' 00001234','00001234\n'])('rechaza formato código %p',async code => {
    const f=fixture(); await expect(f.service.reset(email,code,password,'ip')).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(f.persistence.reset).not.toHaveBeenCalled();
  });
  it.each(['short!','Synthetic WithSpace!','syntheticlowercase!','SyntheticNoSymbol','SyntheticInvisible\u200b!'])('rechaza política clave %p',async value => {
    const f=fixture(); await expect(f.service.reset(email,'00001234',value,'ip')).rejects.toMatchObject({fields:[{field:'password',code:'PASSWORD_POLICY'}]});
    expect(f.persistence.reset).not.toHaveBeenCalled();
  });
  it('solo pasa MAC y Argon2id al reset y no inicia sesión',async () => {
    const f=fixture(); await f.service.reset(email,'00001234',password,'ip');
    const call=jest.mocked(f.persistence.reset).mock.calls[0]!;
    expect(call[1]).toBe(f.crypto.mac(email,'00001234'));
    expect(call[2]).toMatch(/^\$argon2id\$/); expect(await verifyPassword(call[2],password)).toBe(true);
    expect(f.limits.consume).toHaveBeenCalledWith('recovery-reset-ip','ip');
  });
  it('convierte código inválido a error después del puerto confirmado, sin rollback',async () => {
    const f=fixture(); jest.mocked(f.persistence.reset).mockResolvedValue(false);
    await expect(f.service.reset(email,'00001234',password,'ip')).rejects.toMatchObject({status:400,code:'INVALID_RECOVERY_CODE'});
    expect(f.persistence.reset).toHaveBeenCalledTimes(1);
  });
  it('worker recibe referencia, no envía si claim rechazado; fallo SMTP se registra como fallo',async () => {
    const f=fixture(); const id='synthetic-id';
    const delivery: RecoveryDeliveryPort={pending:async()=>[],claim:jest.fn<RecoveryDeliveryPort['claim']>().mockResolvedValue(null),finish:jest.fn<RecoveryDeliveryPort['finish']>().mockResolvedValue(undefined)};
    const mailer:RecoveryMailer={send:jest.fn<RecoveryMailer['send']>().mockRejectedValue(new Error('synthetic private SMTP error'))};
    await deliverRecovery(id,delivery,f.crypto,mailer); expect(mailer.send).not.toHaveBeenCalled();
    jest.mocked(delivery.claim).mockResolvedValue(f.crypto.seal(id,email,'00001234'));
    await deliverRecovery(id,delivery,f.crypto,mailer);
    expect(delivery.finish).toHaveBeenCalledWith(id,expect.any(String),false);
    jest.mocked(mailer.send).mockResolvedValue(true); await deliverRecovery(id,delivery,f.crypto,mailer);
    expect(delivery.finish).toHaveBeenLastCalledWith(id,expect.any(String),true);
  });
});
