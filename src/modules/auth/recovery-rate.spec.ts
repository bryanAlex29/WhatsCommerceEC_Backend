import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import { RedisRateLimits } from './rate-limit.js';
import type { RedisEvaluator } from './rate-limit.js';
describe('cuotas recuperación con Redis simulado',()=>{
  it.each([
    ['recovery-ip',900000,10],['recovery-email-minute',60000,1],['recovery-email-hour',3600000,3],['recovery-reset-ip',900000,10],
  ] as const)('%s: parámetros y claves sin IP/correo legibles',async(scope,window,limit)=>{
    const evalScript=jest.fn<RedisEvaluator['eval']>().mockResolvedValue([1,0]);
    await new RedisRateLimits({eval:evalScript},randomBytes(32)).consume(scope,'synthetic@example.test');
    const call=evalScript.mock.calls[0]!;
    expect(call[1]).toMatch(/^wc:auth:[0-9a-f]{64}$/);expect(call[1]).not.toContain('synthetic');
    expect(call[2].slice(0,3)).toEqual([String(window),String(limit),'1']);
    expect(call[0]).toContain("redis.call('TIME')");
  });
});
