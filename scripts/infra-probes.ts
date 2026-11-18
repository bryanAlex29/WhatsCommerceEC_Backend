import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { PrismaClient } from '../src/generated/prisma/client.js';
import type { ProbeFactory } from './check-infra-core.js';

export const postgresProbe: ProbeFactory = (config) => {
  const pool = new Pool({
    ...config.postgres,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000,
    statement_timeout: 3000,
    query_timeout: 3500,
    ssl: false,
  });
  pool.on('error', () => { /* Nunca registrar errores crudos del driver. */ });
  const adapter = new PrismaPg(pool, { schema: 'public', onConnectionError: () => {}, onPoolError: () => {} });
  const prisma = new PrismaClient({ adapter, log: [], errorFormat: 'minimal' });
  return {
    async check() {
      const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
      if (rows.length !== 1 || rows[0]?.ok !== 1) throw new Error('Respuesta inesperada.');
    },
    async close() {
      try { await prisma.$disconnect(); } finally { await pool.end(); }
    },
  };
};

export const redisProbe: ProbeFactory = (config) => {
  const redis = new Redis({
    ...config.redis,
    lazyConnect: true,
    connectTimeout: 3000,
    commandTimeout: 3000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    autoResendUnfulfilledCommands: false,
  });
  redis.on('error', () => { /* Error informado por el probe, sin datos del proveedor. */ });
  return {
    async check() {
      await redis.connect();
      if (await redis.ping() !== 'PONG') throw new Error('Respuesta inesperada.');
    },
    async close() {
      // Cierra socket inmediatamente también si connect/PING falló; sin reconexiones.
      redis.disconnect();
    },
  };
};
