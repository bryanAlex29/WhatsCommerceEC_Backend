import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import { AccessTokens, hashPassword, verifyPassword, randomRefresh, tokenHash } from './crypto.js';
import { canonicalEmail, newPasswordValid } from './input.js';

const principal = { userId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
describe('Criptografía real, sin DB/RLS', () => {
  const key = randomBytes(32);
  const jwt = new AccessTokens(key);
  it('firma/verifica y rechaza ausente/alterado', async () => {
    const token = await jwt.issue(principal);
    expect(await jwt.verify(token)).toEqual(principal);
    await expect(jwt.verify('')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(jwt.verify(`x${token}`)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('solo firma válida vencida produce ACCESS_TOKEN_EXPIRED', async () => {
    const token = await new SignJWT({ sid: principal.sessionId }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(principal.userId).setIssuer('whatscommerceec-api').setAudience('whatscommerceec-clients')
      .setIssuedAt(1).setExpirationTime(901).sign(key);
    await expect(jwt.verify(token)).rejects.toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED' });
    await expect(new AccessTokens(randomBytes(32)).verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('hash Argon2id PHC con parámetros aprobados, sin transformar contraseña', async () => {
    const phc = await hashPassword('SintéticaMayúscula!');
    expect(phc).toContain('$argon2id$v=19$m=65536,t=3,p=1$');
    expect(await verifyPassword(phc, 'SintéticaMayúscula!')).toBe(true);
    expect(await verifyPassword(phc, 'sintéticaMayúscula!')).toBe(false);
  });
  it('claim inválido con expiración pasada no dispara renovación', async () => {
    const token = await new SignJWT({ sid: 123 }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(principal.userId).setIssuer('wrong-issuer').setAudience('whatscommerceec-clients')
      .setIssuedAt(1).setExpirationTime(901).sign(key);
    await expect(jwt.verify(token)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('refresh aleatorio canónico y hash separado', () => {
    const refresh = randomRefresh();
    expect(refresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash(refresh)).toHaveLength(64);
    expect(randomRefresh()).not.toBe(refresh);
  });
});
describe('Entrada Unicode/IDNA Node22', () => {
  it('dominio IDN equivale a punycode, conserva + y puntos', () => {
    expect(canonicalEmail(' A.B+Ventas@compañía.ec ')).toBe('a.b+ventas@xn--compaa-7va5a.ec');
    expect(canonicalEmail('ventas@compañía.ec')).toBe(canonicalEmail('ventas@xn--compaa-7va5a.ec'));
  });
  it.each(['josé@example.ec', 'K@example.ec', 'a@host.ec:80', 'a@host.ec/path', 'a@host.ec%00', 'a@127.0.0.1', 'a@host.ec.', 'a@-host.ec', 'a..b@host.ec'])('rechaza %s', value => {
    expect(() => canonicalEmail(value)).toThrow();
  });
  it('composición Unicode nueva; espacios, invisibles, sustitutos inválidos', () => {
    expect(newPasswordValid('ContraseñaLarga!')).toBe(true);
    expect(newPasswordValid('Contraseña Larga!')).toBe(false);
    expect(newPasswordValid('ContraseñaLarga!\u200b')).toBe(false);
    expect(newPasswordValid('ContraseñaLarga!\ud800')).toBe(false);
  });
  it('permite todos los dígitos sin hacerlos obligatorios ni cambiar los límites', () => {
    expect(newPasswordValid('Abc1234567890!x')).toBe(true); // 15, incluye 0–9.
    expect(newPasswordValid('ContraseñaLarga!')).toBe(true); // Sin números.
    expect(newPasswordValid(`A!${'0123456789'.repeat(12)}abcdef`)).toBe(true); // 128.
    expect(newPasswordValid(`A!${'0123456789'.repeat(12)}abcdefg`)).toBe(false); // 129.
  });
  it.each(['123456789012345', 'Abc1234567890123', 'abc1234567890!xy', 'Abc1234567890! x'])(
    'los números no sustituyen las reglas previas: %s', value => {
      expect(newPasswordValid(value)).toBe(false);
    },
  );
  it('Argon2id conserva números y rechaza una contraseña con un dígito cambiado', async () => {
    const password = 'Abc1234567890!x'; // Fixture sintético, no credencial real.
    const phc = await hashPassword(password);
    expect(await verifyPassword(phc, password)).toBe(true);
    expect(await verifyPassword(phc, 'Abc1234567891!x')).toBe(false);
  });
});
