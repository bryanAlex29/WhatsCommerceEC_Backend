import { jest } from '@jest/globals';
import type { PrismaClient, Prisma } from '../../../generated/prisma/client.js';
import { PrismaRecoveryPort } from './recovery-adapter.js';

function fixture(code: string, expiresAt?: unknown) {
  const events: string[]=[];
  const query=jest.fn<(sql:TemplateStringsArray,...values:unknown[])=>Promise<unknown>>().mockResolvedValueOnce([{safe:true}]).mockResolvedValueOnce([]).mockResolvedValue([{result:{code,...(expiresAt === undefined ? {} : {expiresAt})}}]);
  const client={$transaction:async(work:(tx:Prisma.TransactionClient)=>Promise<unknown>)=>{
    events.push('begin');try{const result=await work({$queryRaw:query} as unknown as Prisma.TransactionClient);events.push('commit');return result;}catch(error){events.push('rollback');throw error;}
  }} as unknown as PrismaClient;
  return {port:new PrismaRecoveryPort(client),events,query};
}
it('reset incorrecto confirma intentos antes de devolver false (Prisma simulado)',async()=>{
  const f=fixture('INVALID_RECOVERY_CODE');expect(await f.port.reset('synthetic@example.test','a'.repeat(64),'$argon2id$synthetic')).toBe(false);
  expect(f.events).toEqual(['begin','commit']);expect(f.query.mock.calls[2]?.[0].join('?')).toContain('app_api.recovery_reset');
  expect(f.query.mock.calls[2]?.slice(1)).toEqual(['synthetic@example.test','a'.repeat(64),'$argon2id$synthetic']);
});
it('verify inválido confirma intentos y no lanza dentro de transacción', async () => {
  const f=fixture('INVALID_RECOVERY_CODE'); expect(await f.port.verify('synthetic@example.test','a'.repeat(64),'b'.repeat(64))).toBeNull();
  expect(f.events).toEqual(['begin','commit']);
});
it('verify solo admite fecha canónica y complete inválido confirma sin éxito falso', async () => {
  const ok=fixture('OK','2027-01-01T00:00:00.000Z'); expect(await ok.port.verify('synthetic@example.test','a'.repeat(64),'b'.repeat(64))).toBe('2027-01-01T00:00:00.000Z');
  const bad=fixture('OK','not-a-date'); await expect(bad.port.verify('synthetic@example.test','a'.repeat(64),'b'.repeat(64))).rejects.toMatchObject({status:503});
  expect(bad.events).toEqual(['begin','rollback']);
  const failed=fixture('INVALID_RECOVERY_CODE');expect(await failed.port.complete('synthetic@example.test','b'.repeat(64),'$argon2id$fixture')).toBe(false);
  expect(failed.events).toEqual(['begin','commit']);
});
it('request parametriza ciphertext sin SELECT general ni retorno de código (Prisma simulado)',async()=>{
  const f=fixture('OK');await f.port.request('synthetic@example.test','11111111-1111-4111-8111-111111111111','a'.repeat(64),{payload:'ab',nonce:'a'.repeat(24),tag:'b'.repeat(32)});
  expect(f.events).toEqual(['begin','commit']);expect(f.query.mock.calls[2]?.[0].join('?')).toContain('app_api.recovery_request');
});
