import { Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Redis } from 'ioredis';
import type { Environment } from '../../config/environment.js';
import { unavailable } from '../auth/errors.js';
import { RedisRateLimits } from '../auth/rate-limit.js';
import { InvitationCrypto, InvitationService } from './invitations.js';
import { RedisInvitationLimits } from './limits.js';

@Injectable()
export class InvitationsRuntime implements OnModuleDestroy {
  private initialization?: Promise<InvitationService>;
  private readonly close: Array<() => Promise<void>> = [];
  constructor(@Optional() private readonly config?: ConfigService<Environment, true>) {}
  ready(): Promise<InvitationService> {
    if (this.config?.get('INVITATIONS_ENABLED', { infer: true }) !== true) unavailable();
    return this.initialization ??= this.build();
  }
  async onModuleDestroy(): Promise<void> {
    await this.initialization?.catch(() => undefined); await Promise.allSettled(this.close.map(fn => fn()));
  }
  private async build(): Promise<InvitationService> {
    const required = (key: keyof Environment): string => {
      const v = this.config?.get(key, { infer: true }); if (typeof v !== 'string' || !v) return unavailable(); return v;
    };
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const { PrismaInvitationPort } = await import('./persistence.js');
    const client = (url: string) => {
      const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 3000, statement_timeout: 5000, query_timeout: 6000 });
      pool.on('error', () => {});
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'app_private', onConnectionError: () => {}, onPoolError: () => {} }), log: [], errorFormat: 'minimal' });
      this.close.push(async () => { try { await prisma.$disconnect(); } finally { await pool.end(); } }); return prisma;
    };
    const redis = new Redis(required('REDIS_URL'), { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000,
      retryStrategy: () => null, maxRetriesPerRequest: 0, enableOfflineQueue: false, autoResendUnfulfilledCommands: false });
    redis.on('error', () => {}); this.close.push(async () => { redis.disconnect(); });
    let connecting: Promise<void> | undefined;
    const evaluator = { async eval(script: string, keys: string[], args: string[]) {
      if (redis.status !== 'ready') { connecting ??= redis.connect().finally(() => { connecting = undefined; }); await connecting; }
      return redis.eval(script, keys.length, ...keys, ...args);
    } };
    const key = Buffer.from(required('AUTH_RATE_LIMIT_KEY'), 'base64url');
    return new InvitationService(new PrismaInvitationPort(client(required('COMPANIES_PLATFORM_DATABASE_URL')), client(required('AUTH_IDENTITY_DATABASE_URL'))),
      new RedisInvitationLimits(evaluator, key), new RedisRateLimits({ eval: (script, key, args) => evaluator.eval(script, [key], args) }, key),
      new InvitationCrypto(Buffer.from(required('INVITATION_OUTBOX_KEY'), 'base64url')));
  }
}
