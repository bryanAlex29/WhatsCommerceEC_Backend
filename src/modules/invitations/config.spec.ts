import { randomBytes } from 'node:crypto';
import { validateEnvironment } from '../../config/environment.js';
import { InvitationsRuntime } from './runtime.js';

function environment(): Record<string, unknown> {
  return { NODE_ENV: 'test', AUTH_ENABLED: 'true', COMPANIES_ENABLED: 'true', INVITATIONS_ENABLED: 'true',
    AUTH_IDENTITY_DATABASE_URL: 'postgresql://wc_identity:synthetic@127.0.0.1:5432/test',
    AUTH_TENANT_DATABASE_URL: 'postgresql://wc_tenant:synthetic@127.0.0.1:5432/test',
    COMPANIES_PLATFORM_DATABASE_URL: 'postgresql://wc_platform:synthetic@127.0.0.1:5432/test',
    INVITATION_DELIVERY_DATABASE_URL: 'postgresql://wc_delivery:synthetic@127.0.0.1:5432/test',
    REDIS_URL: 'redis://127.0.0.1:6379', AUTH_JWT_KEY: randomBytes(32).toString('base64url'),
    AUTH_CURSOR_KEY: randomBytes(32).toString('base64url'), AUTH_RATE_LIMIT_KEY: randomBytes(32).toString('base64url'),
    INVITATION_OUTBOX_KEY: randomBytes(32).toString('base64url') };
}
describe('invitaciones: configuración sin conexiones', () => {
  it('deshabilitado por defecto, runtime no inicializa dependencias', () => {
    expect(validateEnvironment({}).INVITATIONS_ENABLED).not.toBe(true);
    expect(() => new InvitationsRuntime().ready()).toThrow();
  });
  it('habilitación explícita con clave propia/rol delivery y puerto captura', () => {
    const value = validateEnvironment(environment());
    expect(value.INVITATIONS_ENABLED).toBe(true); expect(value.INVITATION_MAILPIT_PORT).toBe(1025);
  });
  it.each(['bad', '', 'TRUE'])('flag inválido %p', value => {
    expect(() => validateEnvironment({ ...environment(), INVITATIONS_ENABLED: value })).toThrow('INVITATIONS_ENABLED');
  });
  it.each(['short', 'x'.repeat(43), undefined])('clave no canónica rechazada %p', value => {
    expect(() => validateEnvironment({ ...environment(), INVITATION_OUTBOX_KEY: value })).toThrow('INVITATION_OUTBOX_KEY');
  });
  it.each(['AUTH_JWT_KEY', 'AUTH_CURSOR_KEY', 'AUTH_RATE_LIMIT_KEY'])('no reutiliza %s', key => {
    const raw = environment(); raw.INVITATION_OUTBOX_KEY = raw[key];
    expect(() => validateEnvironment(raw)).toThrow('INVITATION_OUTBOX_KEY');
  });
  it('no admite propietario/admin como transporte', () => {
    expect(() => validateEnvironment({ ...environment(), INVITATION_DELIVERY_DATABASE_URL: 'postgresql://postgres:synthetic@127.0.0.1:5432/test' })).toThrow('INVITATION_DELIVERY_DATABASE_URL');
  });
  it.each(['0', '1023', '65536', '1.5', 'abc'])('puerto inválido %p', value => {
    expect(() => validateEnvironment({ ...environment(), INVITATION_MAILPIT_PORT: value })).toThrow('INVITATION_MAILPIT_PORT');
  });
  it('producción prohibida', () => {
    expect(() => validateEnvironment({ ...environment(), NODE_ENV: 'production' })).toThrow();
  });
});
