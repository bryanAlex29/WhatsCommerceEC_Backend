import { jest } from '@jest/globals';
import type { PrismaClient, Prisma } from '../../../generated/prisma/client.js';
import { PrismaRecoveryPort } from './recovery-adapter.js';

function fixture(code: string) {
  const events: string[]=[];
  const query=jest.fn<(sql:TemplateStringsArray,...values:unknown[])=>Promise<unknown>>().mockResolvedValueOnce([{safe:true}]).mockResolvedValueOnce([]).mockResolvedValue([{result:{code}}]);
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
it('request parametriza ciphertext sin SELECT general ni retorno de código (Prisma simulado)',async()=>{
  const f=fixture('OK');await f.port.request('synthetic@example.test','11111111-1111-4111-8111-111111111111','a'.repeat(64),{payload:'ab',nonce:'a'.repeat(24),tag:'b'.repeat(32)});
  expect(f.events).toEqual(['begin','commit']);expect(f.query.mock.calls[2]?.[0].join('?')).toContain('app_api.recovery_request');
});
