import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleInput } from './bootstrap-platform.js';
import { validateDatabaseUrl } from './auth-local-core.js';
import { runtimeProfile } from './recovery-config.js';
import { validateEnvironment } from '../src/config/environment.js';

async function main() {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const runtime = runtimeProfile(root);
  const path = resolve(root, '.env.recovery-dev');
  if (existsSync(path)) throw new Error(); // No sustituir claves existentes ni invalidar payloads.
  const user = (await consoleInput('Gmail remitente del proyecto: ', false)).trim().toLowerCase();
  const password = (await consoleInput('Contraseña de APLICACIÓN generada por Google (no la habitual): ', true)).replace(/ /g, '');
  const key = () => randomBytes(32).toString('base64url');
  const url = validateDatabaseUrl(runtime.AUTH_IDENTITY_DATABASE_URL, 'wc_identity');
  url.username = 'wc_delivery'; url.password = key();
  const overlay = { RECOVERY_ENABLED: 'true', RECOVERY_MAC_KEY: key(), RECOVERY_ENCRYPTION_KEY: key(),
    RECOVERY_DELIVERY_DATABASE_URL: url.href, SMTP_USER: user, SMTP_APP_PASSWORD: password };
  validateEnvironment({ ...runtime, ...overlay });
  writeFileSync(path, Object.entries(overlay).map(([name,value]) => `${name}=${value}\n`).join(''), { flag: 'wx', mode: 0o600 });
  console.log('RECOVERY_CONFIG_SAVED. Protege los permisos del archivo. No inicia SMTP ni aplica SQL.');
}
await main().catch(() => { console.error('RECOVERY_SETUP_FAILED: revisa cuenta, clave de aplicación y archivo privado existente; no se muestran secretos.'); process.exitCode = 1; });
