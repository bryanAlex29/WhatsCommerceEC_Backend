import { randomBytes } from 'node:crypto';
import { platformProfile, sealBackup, openBackup } from './companies-local.js';

describe('preparación DEV Empresas; sin perfiles reales ni conexiones', () => {
  it('overlay estricto, rol/destino DEV acotados, sin aceptar admin ni secretos por defecto', () => {
    const url = `postgresql://wc_platform:${'a'.repeat(43)}@127.0.0.1:55432/whatscommerceec_auth_dev`;
    const text = `COMPANIES_ENABLED=true\nCOMPANIES_PLATFORM_DATABASE_URL=${url}\n`;
    expect(platformProfile(text).COMPANIES_ENABLED).toBe('true');
    for (const candidate of [text.replace('wc_platform:', 'postgres:'), text.replace('55432', '5432'),
      text.replace('127.0.0.1', 'example.test'), text.replace('true', 'false'), `${text}AUTH_JWT_KEY=x\n`]) {
      expect(() => platformProfile(candidate)).toThrow();
    }
  });
  it('respaldo cifrado autenticado conserva bytes y rechaza clave/payload adulterados', () => {
    const key = randomBytes(32); const bytes = Buffer.from('synthetic-private-backup-not-real-data');
    const envelope = sealBackup(bytes, key);
    expect(JSON.stringify(envelope)).not.toContain(bytes.toString());
    expect(openBackup(envelope, key)).toEqual(bytes);
    expect(() => openBackup(envelope, randomBytes(32))).toThrow();
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64'); ciphertext[0] = ciphertext[0]! ^ 1;
    expect(() => openBackup({ ...envelope, ciphertext: ciphertext.toString('base64') }, key)).toThrow();
    expect(() => openBackup({ ...envelope, version: 2 }, key)).toThrow();
  });
});
