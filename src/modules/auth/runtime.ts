import { Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import type { Environment } from '../../config/environment.js';
import { AuthService } from './auth.service.js';
import { AccessTokens, hashPassword } from './crypto.js';
import { CompanyCursor } from './cursor.js';
import { unavailable } from './errors.js';
import type { IdentityPort, TenantPort } from './ports.js';
import { RedisRateLimits } from './rate-limit.js';

export interface AuthDependencies { service: AuthService; identity: IdentityPort; tenant: TenantPort }
/** Sin conexiones al boot. Solo configuración explícita habilita adaptadores reales. */
@Injectable()
export class AuthRuntime implements OnModuleDestroy {
  private initialization?: Promise<AuthDependencies>;
  private readonly close: Array<() => Promise<void>> = [];
  constructor(@Optional() private readonly config?: ConfigService<Environment, true>) {}
  enabled(): boolean { return this.config?.get('AUTH_ENABLED', { infer: true }) === true; }
  ready(): Promise<AuthDependencies> {
    if (!this.enabled()) unavailable();
    return this.initialization ??= this.build();
  }
  async onModuleDestroy(): Promise<void> {
    await this.initialization?.catch(() => undefined);
    await Promise.allSettled(this.close.map(close => close()));
  }
  private async build(): Promise<AuthDependencies> {
    const config = this.config;
    if (!config) unavailable();
    const required = (key: keyof Environment): string => {
      const value = config.get(key, { infer: true });
      if (typeof value !== 'string' || !value) unavailable();
      return value;
    };
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const { PrismaIdentityPort, PrismaTenantPort } = await import('./persistence/adapters.js');
    const client = (url: string) => {
      const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000, statement_timeout: 4000, query_timeout: 5000 });
      pool.on('error', () => { /* Nunca imprimir errores privados del driver. */ });
      const adapter = new PrismaPg(pool, { schema: 'app_private', onConnectionError: () => {}, onPoolError: () => {} });
      const prisma = new PrismaClient({ adapter, log: [], errorFormat: 'minimal' });
      this.close.push(async () => { try { await prisma.$disconnect(); } finally { await pool.end(); } });
      return prisma;
    };
    const identityClient = client(required('AUTH_IDENTITY_DATABASE_URL'));
    const tenantClient = client(required('AUTH_TENANT_DATABASE_URL'));
    const redis = new Redis(required('REDIS_URL'), { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000,
      retryStrategy: () => null, maxRetriesPerRequest: 0, enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false });
    redis.on('error', () => { /* El puerto devuelve un error sanitizado. */ });
    this.close.push(async () => { redis.disconnect(); });
    let connecting: Promise<void> | undefined;
    const limits = new RedisRateLimits({
      async eval(script, key, args) {
        if (redis.status !== 'ready') {
          connecting ??= redis.connect().finally(() => { connecting = undefined; });
          await connecting;
        }
        return redis.eval(script, 1, key, ...args);
      },
    }, Buffer.from(required('AUTH_RATE_LIMIT_KEY'), 'base64url'));
    const identity = new PrismaIdentityPort(identityClient, new CompanyCursor(Buffer.from(required('AUTH_CURSOR_KEY'), 'base64url')));
    const tenant = new PrismaTenantPort(tenantClient);
    // Aleatorio y privado, únicamente iguala el coste para una cuenta inexistente.
    const dummyHash = await hashPassword(randomBytes(32).toString('base64url'));
    const service = new AuthService(identity, limits, new AccessTokens(Buffer.from(required('AUTH_JWT_KEY'), 'base64url')), dummyHash);
    return { service, identity, tenant };
  }
}
