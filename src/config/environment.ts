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
  COMPANIES_ENABLED?: boolean;
  COMPANIES_PLATFORM_DATABASE_URL?: string;
  RECOVERY_ENABLED?: boolean;
  RECOVERY_MAC_KEY?: string;
  RECOVERY_ENCRYPTION_KEY?: string;
  RECOVERY_DELIVERY_DATABASE_URL?: string;
  SMTP_USER?: string;
  SMTP_APP_PASSWORD?: string;
  RECOVERY_MAIL_TRANSPORT?: 'smtp' | 'gmail-api';
  GMAIL_OAUTH_CLIENT_ID?: string;
  GMAIL_OAUTH_CLIENT_SECRET?: string;
  GMAIL_OAUTH_REFRESH_TOKEN?: string;
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
  const companies = raw.COMPANIES_ENABLED ?? 'false';
  if (!['true', 'false'].includes(String(companies))) fail('COMPANIES_ENABLED');
  if (String(companies) === 'true') {
    if (!config.AUTH_ENABLED || nodeEnv === 'production') fail('COMPANIES_ENABLED');
    const platform = validateUrl(raw.COMPANIES_PLATFORM_DATABASE_URL, 'COMPANIES_PLATFORM_DATABASE_URL', ['postgresql:', 'postgres:']);
    const url = new URL(platform);
    let username: string;
    try { username = decodeURIComponent(url.username); } catch { return fail('COMPANIES_PLATFORM_DATABASE_URL'); }
    if (username !== 'wc_platform' || !url.password || !url.pathname.slice(1)) fail('COMPANIES_PLATFORM_DATABASE_URL');
    config.COMPANIES_ENABLED = true;
    config.COMPANIES_PLATFORM_DATABASE_URL = platform;
  }
  const recovery = raw.RECOVERY_ENABLED ?? 'false';
  if (!['true', 'false'].includes(String(recovery))) fail('RECOVERY_ENABLED');
  if (String(recovery) === 'true') {
    if (!config.AUTH_ENABLED || nodeEnv === 'production') fail('RECOVERY_ENABLED');
    config.RECOVERY_ENABLED = true;
    const secrets = new Set([config.AUTH_JWT_KEY, config.AUTH_CURSOR_KEY, config.AUTH_RATE_LIMIT_KEY]);
    for (const key of ['RECOVERY_MAC_KEY', 'RECOVERY_ENCRYPTION_KEY'] as const) {
      const value = raw[key];
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value || secrets.has(value)) fail(key);
      secrets.add(value); config[key] = value;
    }
    const delivery = validateUrl(raw.RECOVERY_DELIVERY_DATABASE_URL, 'RECOVERY_DELIVERY_DATABASE_URL', ['postgresql:', 'postgres:']);
    const url = new URL(delivery);
    if (url.username !== 'wc_delivery' || !url.password || !url.pathname.slice(1)) fail('RECOVERY_DELIVERY_DATABASE_URL');
    config.RECOVERY_DELIVERY_DATABASE_URL = delivery;
    if (typeof raw.SMTP_USER !== 'string' || !/^[a-z0-9]+(?:[a-z0-9.]*[a-z0-9])?@gmail\.com$/.test(raw.SMTP_USER)) fail('SMTP_USER');
    config.SMTP_USER = raw.SMTP_USER;
    const transport = raw.RECOVERY_MAIL_TRANSPORT ?? 'smtp';
    if (transport !== 'smtp' && transport !== 'gmail-api') fail('RECOVERY_MAIL_TRANSPORT');
    config.RECOVERY_MAIL_TRANSPORT = transport;
    if (transport === 'smtp') {
      if (typeof raw.SMTP_APP_PASSWORD !== 'string' || !/^[a-z]{16}$/.test(raw.SMTP_APP_PASSWORD)) fail('SMTP_APP_PASSWORD');
      config.SMTP_APP_PASSWORD = raw.SMTP_APP_PASSWORD;
    } else {
      if (typeof raw.GMAIL_OAUTH_CLIENT_ID !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(raw.GMAIL_OAUTH_CLIENT_ID)) fail('GMAIL_OAUTH_CLIENT_ID');
      if (typeof raw.GMAIL_OAUTH_CLIENT_SECRET !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(raw.GMAIL_OAUTH_CLIENT_SECRET)) fail('GMAIL_OAUTH_CLIENT_SECRET');
      if (typeof raw.GMAIL_OAUTH_REFRESH_TOKEN !== 'string' || !/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(raw.GMAIL_OAUTH_REFRESH_TOKEN)) fail('GMAIL_OAUTH_REFRESH_TOKEN');
      config.GMAIL_OAUTH_CLIENT_ID = raw.GMAIL_OAUTH_CLIENT_ID;
      config.GMAIL_OAUTH_CLIENT_SECRET = raw.GMAIL_OAUTH_CLIENT_SECRET;
      config.GMAIL_OAUTH_REFRESH_TOKEN = raw.GMAIL_OAUTH_REFRESH_TOKEN;
    }
  }
  return config;
}
