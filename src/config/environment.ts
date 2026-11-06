export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  CORS_ORIGINS: string[];
  DATABASE_URL?: string;
  REDIS_URL?: string;
  AUTH_ENABLED: boolean;
  AUTH_IDENTITY_DATABASE_URL?: string;
  AUTH_TENANT_DATABASE_URL?: string;
  AUTH_JWT_KEY?: string;
  AUTH_CURSOR_KEY?: string;
  AUTH_RATE_LIMIT_KEY?: string;
}

function fail(key: string): never {
  // Nunca incluir valores de configuración en errores o logs.
  throw new Error(`Configuración inválida: ${key}`);
}

function validateUrl(value: unknown, key: string, protocols: string[]): string {
  if (typeof value !== 'string' || value.trim() !== value) return fail(key);
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname || url.hash) return fail(key);
  } catch {
    return fail(key);
  }
  return value;
}

export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const nodeEnv = raw.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') fail('NODE_ENV');
  const portValue = raw.PORT ?? '3000';
  if (!/^\d+$/.test(String(portValue))) fail('PORT');
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT');
  const originsValue = raw.CORS_ORIGINS ?? 'http://localhost:5173';
  if (typeof originsValue !== 'string') fail('CORS_ORIGINS');
  const origins = originsValue.split(',').map((origin) => origin.trim());
  for (const origin of origins) {
    validateUrl(origin, 'CORS_ORIGINS', ['http:', 'https:']);
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) fail('CORS_ORIGINS');
  }
  const enabled = raw.AUTH_ENABLED ?? 'false';
  if (!['true', 'false'].includes(String(enabled))) fail('AUTH_ENABLED');
  const config: Environment = { NODE_ENV: nodeEnv, PORT: port, CORS_ORIGINS: [...new Set(origins)], AUTH_ENABLED: String(enabled) === 'true' };
  if (raw.DATABASE_URL !== undefined) {
    config.DATABASE_URL = validateUrl(raw.DATABASE_URL, 'DATABASE_URL', ['postgresql:', 'postgres:']);
  }
  if (raw.REDIS_URL !== undefined) {
    config.REDIS_URL = validateUrl(raw.REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:']);
  }
  if (config.AUTH_ENABLED) {
    // Esta entrega no autoriza habilitar autenticación productiva.
    if (nodeEnv === 'production') fail('AUTH_ENABLED');
    for (const [key, role] of [['AUTH_IDENTITY_DATABASE_URL', 'wc_identity'], ['AUTH_TENANT_DATABASE_URL', 'wc_tenant']] as const) {
      const value = validateUrl(raw[key], key, ['postgresql:', 'postgres:']);
      const url = new URL(value);
      let username: string;
      try { username = decodeURIComponent(url.username); } catch { return fail(key); }
      if (username !== role || !url.password || !url.pathname.slice(1)) fail(key);
      config[key] = value;
    }
    const secrets = new Set<string>();
    for (const key of ['AUTH_JWT_KEY', 'AUTH_CURSOR_KEY', 'AUTH_RATE_LIMIT_KEY'] as const) {
      const value = raw[key];
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
        || Buffer.from(value, 'base64url').length !== 32 || Buffer.from(value, 'base64url').toString('base64url') !== value
        || secrets.has(value)) fail(key);
      secrets.add(value);
      config[key] = value;
    }
    if (!config.REDIS_URL) fail('REDIS_URL');
  }
  return config;
}
