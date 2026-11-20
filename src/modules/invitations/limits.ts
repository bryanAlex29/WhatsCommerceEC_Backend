import { createHmac } from 'node:crypto';
import { uuid } from '../auth/input.js';
import { unavailable } from '../auth/errors.js';
import { RateLimitError } from '../auth/rate-limit.js';
import type { ReservationLimits } from './invitations.js';

export interface MultiRedis { eval(script: string, keys: string[], args: string[]): Promise<unknown> }
const reserve = `
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local windows={60000,3600000,3600000}; local limits={1,5,20}; local retry=0
for i=1,3 do
 redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-windows[i])
 if redis.call('ZCARD',KEYS[i])>=limits[i] then
  local first=redis.call('ZRANGE',KEYS[i],0,0,'WITHSCORES')
  retry=math.max(retry,math.max(1,math.ceil((tonumber(first[2])+windows[i]-now)/1000)))
 end
end
if retry>0 then return {0,retry} end
if redis.call('EXISTS',KEYS[4])==1 then return {0,1} end
for i=1,3 do redis.call('ZADD',KEYS[i],now,ARGV[1]); redis.call('PEXPIRE',KEYS[i],windows[i]+1000) end
redis.call('HSET',KEYS[4],'a',KEYS[1],'b',KEYS[2],'c',KEYS[3],'state','reserved')
redis.call('PEXPIRE',KEYS[4],3601000); redis.call('ZADD',KEYS[5],now,ARGV[1]); redis.call('PEXPIRE',KEYS[5],3601000)
return {1,0}`;
const finish = `
if ARGV[2]=='confirm' then
 if redis.call('EXISTS',KEYS[1])==1 then redis.call('HSET',KEYS[1],'state','confirmed') end
 redis.call('ZREM',KEYS[2],ARGV[1]); return 1
end
if redis.call('HGET',KEYS[1],'state')=='confirmed' then return 0 end
for _,field in ipairs({'a','b','c'}) do
 local key=redis.call('HGET',KEYS[1],field); if key then redis.call('ZREM',key,ARGV[1]) end
end
redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1`;
const pending = `
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now-3601000)
return redis.call('ZRANGE',KEYS[1],0,19)`;
export class RedisInvitationLimits implements ReservationLimits {
  constructor(private readonly redis: MultiRedis, private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('Configuración de límites inválida');
  }
  private digest(scope: string, id: string) { return createHmac('sha256', this.key).update(`invitation:${scope}\0${id}`).digest('hex'); }
  private get index() { return `wc:inv:${this.digest('index', 'pending')}`; }
  private reservation(id: string) { if (!uuid.test(id)) return unavailable(); return `wc:inv:op:${this.digest('op', id)}`; }
  private async eval(script: string, keys: string[], args: string[]) {
    try { return await this.redis.eval(script, keys, args); } catch { return unavailable(); }
  }
  async reserve(operationId: string, companyId: string, adminId: string): Promise<void> {
    if (!uuid.test(companyId) || !uuid.test(adminId)) unavailable();
    const keys = ['minute', 'hour'].map(scope => `wc:inv:${this.digest(scope, companyId)}`);
    const result = await this.eval(reserve, [...keys, `wc:inv:${this.digest('admin', adminId)}`, this.reservation(operationId), this.index], [operationId]);
    if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(result[0] as number) || !Number.isSafeInteger(result[1]) || Number(result[1]) < 0) unavailable();
    if (result[0] === 0) throw new RateLimitError(Math.max(1, Number(result[1])));
  }
  async release(id: string): Promise<void> { await this.eval(finish, [this.reservation(id), this.index], [id, 'release']); }
  async confirm(id: string): Promise<void> { await this.eval(finish, [this.reservation(id), this.index], [id, 'confirm']); }
  async pending(): Promise<string[]> {
    const result = await this.eval(pending, [this.index], []);
    if (!Array.isArray(result) || result.length > 20 || result.some(id => typeof id !== 'string' || !uuid.test(id))) return unavailable();
    return result as string[];
  }
}
