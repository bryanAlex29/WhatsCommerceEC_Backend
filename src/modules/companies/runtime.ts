import { Injectable, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Environment } from '../../config/environment.js';
import { unavailable } from '../auth/errors.js';
import type { CompaniesPort } from './ports.js';

/** Disabled by default; no connection, migration or provisioning at boot. */
@Injectable()
export class CompaniesRuntime implements OnModuleDestroy {
  private initialization?: Promise<CompaniesPort>;
  private readonly close: Array<() => Promise<void>> = [];
  constructor(@Optional() private readonly config?: ConfigService<Environment, true>) {}
  ready(): Promise<CompaniesPort> {
    if (this.config?.get('COMPANIES_ENABLED', { infer: true }) !== true) unavailable();
    return this.initialization ??= this.build();
  }
  async onModuleDestroy(): Promise<void> {
    await this.initialization?.catch(() => undefined);
    await Promise.allSettled(this.close.map(close => close()));
  }
  private async build(): Promise<CompaniesPort> {
    const required = (key: keyof Environment): string => {
      const value = this.config?.get(key, { infer: true });
      if (typeof value !== 'string' || !value) return unavailable();
      return value;
    };
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const { PrismaCompaniesPort } = await import('./persistence.js');
    const client = (url: string) => {
      const pool = new Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000, statement_timeout: 4000, query_timeout: 5000 });
      pool.on('error', () => { /* Never expose private driver diagnostics. */ });
      const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'app_private',
        onConnectionError: () => {}, onPoolError: () => {} }), log: [], errorFormat: 'minimal' });
      this.close.push(async () => { try { await prisma.$disconnect(); } finally { await pool.end(); } });
      return prisma;
    };
    return new PrismaCompaniesPort(client(required('COMPANIES_PLATFORM_DATABASE_URL')),
      client(required('AUTH_TENANT_DATABASE_URL')), Buffer.from(required('AUTH_CURSOR_KEY'), 'base64url'));
  }
}
