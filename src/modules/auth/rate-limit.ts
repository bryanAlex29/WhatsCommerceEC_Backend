import { createHmac, randomUUID } from 'node:crypto';
import { AuthError, unavailable } from './errors.js';
import type { RateLimitPort } from './ports.js';

// TIME y ZSET en una sola operación: ventana móvil compartida, sin IP/correo en claves.
const slidingWindow = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.max(1, math.ceil((tonumber(first[2]) + window - now) / 1000))}
end
if ARGV[3] == '1' then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], window + 1000)
end
return {1, 0}
`;
export interface RedisEvaluator { eval(script: string, key: string, args: string[]): Promise<unknown> }
export class RateLimitError extends AuthError {
  constructor(readonly retryAfter: number) { super(429, 'RATE_LIMITED', 'Demasiadas solicitudes. Inténtalo más tarde'); }
}
export class RedisRateLimits implements RateLimitPort {
  constructor(private readonly redis: RedisEvaluator, private readonly secret: Uint8Array) {
    if (secret.byteLength !== 32) throw new Error('Configuración de límites inválida');
  }
  checkLoginFailures(key: string): Promise<void> { return this.run('login-failure', key, false); }
  consume(scope: Parameters<RateLimitPort['consume']>[0], key: string): Promise<void> { return this.run(scope, key, true); }
  private async run(scope: Parameters<RateLimitPort['consume']>[0], key: string, consume: boolean): Promise<void> {
    const [window, limit] = {
      'login-ip': [900000, 30], 'login-failure': [900000, 5],
      'refresh-ip': [60000, 60], 'refresh-session': [60000, 30], 'logout-ip': [60000, 60],
    }[scope];
    const digest = createHmac('sha256', this.secret).update(scope).update('\0').update(key).digest('hex');
    let result: unknown;
    try { result = await this.redis.eval(slidingWindow, `wc:auth:${digest}`, [String(window), String(limit), consume ? '1' : '0', randomUUID()]); }
    catch { unavailable(); }
    if (!Array.isArray(result) || result.length !== 2 || ![0, 1].includes(result[0] as number)
      || typeof result[1] !== 'number' || !Number.isSafeInteger(result[1]) || result[1] < 0) unavailable();
    if (result[0] === 0) throw new RateLimitError(Math.max(1, result[1] as number));
  }
}
