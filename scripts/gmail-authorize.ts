import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { consoleInput } from './bootstrap-platform.js';
import { recoveryConfig } from './recovery-config.js';
import { desktopClient, oauthAttempt, localOAuthCallback, authorizationUrl, exchangeGmailAuthorization } from './gmail-oauth.js';
import { validateEnvironment } from '../src/config/environment.js';

async function main() {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY || process.platform !== 'win32') throw new Error();
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { config } = recoveryConfig(root, false);
  const target = resolve(root, '.env.gmail-api-dev');
  const existing = existsSync(target);
  if (existing && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error();
  console.log('Gmail API DEV: no activa facturación ni envía mensajes. Detén API y worker antes de autorizar.');
  console.log('El navegador solicitará solo envío y verificación de identidad del Gmail remitente. Testing de Google puede caducar en 7 días.');
  const confirmation = existing ? 'REAUTORIZAR GMAIL DEV' : 'CONECTAR GMAIL DEV';
  if (await consoleInput(`Escribe ${confirmation} para continuar: `, false) !== confirmation) throw new Error();
  const path = resolve((await consoleInput('Ruta del JSON OAuth tipo Escritorio (fuera del repositorio): ', false)).trim().replace(/^"(.*)"$/, '$1'));
  if (realpathSync(path).toLowerCase().startsWith(realpathSync(root).toLowerCase() + sep) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 16384) throw new Error();
  const client = desktopClient(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  const attempt = oauthAttempt(); const callback = await localOAuthCallback(attempt.state);
  try {
    console.log('Se abrirá Google en el navegador de este PC. Elige la misma cuenta remitente. No copies códigos ni tokens al chat.');
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', authorizationUrl(client.clientId, callback.redirectUri, attempt, config.SMTP_USER!)],
      { windowsHide: true }, error => { if (error) callback.cancel(); });
    const code = await callback.code;
    const refreshToken = await exchangeGmailAuthorization(client, code, callback.redirectUri, attempt, config.SMTP_USER!);
    const overlay = { RECOVERY_MAIL_TRANSPORT: 'gmail-api', GMAIL_OAUTH_CLIENT_ID: client.clientId,
      GMAIL_OAUTH_CLIENT_SECRET: client.clientSecret, GMAIL_OAUTH_REFRESH_TOKEN: refreshToken };
    validateEnvironment({ ...config, CORS_ORIGINS: config.CORS_ORIGINS.join(','), ...overlay });
    // Escritura nueva separada: nunca rotar claves HMAC/cifrado ni credenciales DB.
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, Object.entries(overlay).map(([key,value]) => `${key}=${value}\n`).join(''), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    console.log('GMAIL_API_AUTH_SAVED. Protege ACL del archivo; no confirma envío. Reinicia API y worker para usar HTTPS.');
  } finally { callback.cancel(); }
}
await main().catch(() => {
  console.error('GMAIL_AUTHORIZATION_FAILED. Revisa cliente Escritorio, API habilitada, usuario de prueba y cuenta remitente. No se muestran tokens ni errores privados.');
  process.exitCode = 1;
});
