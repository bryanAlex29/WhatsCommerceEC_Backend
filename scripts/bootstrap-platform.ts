import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { StringDecoder } from 'node:string_decoder';
import { canonicalEmail, newPasswordValid } from '../src/modules/auth/input.js';
import { hashPassword } from '../src/modules/auth/crypto.js';
import { checkReceipt, loadProfiles, safeError, sqlBundle, verifyAdmin } from './auth-local-core.js';

const failureMessages = {
  EMAIL_INVALID: 'El correo no tiene un formato válido. Usa un correo con parte local ASCII y dominio válido.',
  PASSWORD_POLICY: 'La contraseña admite números y debe tener 15–128 caracteres, una mayúscula y un símbolo, sin espacios, controles ni caracteres invisibles.',
  PASSWORD_MISMATCH: 'Las contraseñas no coinciden. Vuelve a introducirlas.',
  ADMIN_EXISTS: 'Ya existe un administrador de plataforma. Este comando no permite crear otro ni cambiar su contraseña.',
  EMAIL_EXISTS: 'Ese correo ya pertenece a una cuenta. No se modifica ni se promueve automáticamente.',
  TTY_REQUIRED: 'Ejecuta el comando en una consola interactiva privada, no mediante argumentos o redirecciones.',
  INPUT_CANCELLED: 'Entrada cancelada. No se creó la cuenta.',
  INPUT_FAILED: 'No se pudo leer la entrada de la consola.',
  INPUT_CONTROL: 'Se recibió una tecla de control no admitida. Vuelve a escribir la entrada sin tabulaciones.',
  INPUT_LIMIT: 'La entrada supera el límite admitido.',
  SETUP_RECEIPT: 'La preparación local no está validada. Revisa auth:setup:local antes de reintentar.',
} as const;
type FailureCode = keyof typeof failureMessages;
export class BootstrapError extends Error {
  constructor(readonly code: FailureCode) { super(code); }
}
function requireBootstrap(condition: unknown, code: FailureCode): asserts condition {
  if (!condition) throw new BootstrapError(code);
}
export function bootstrapFailureMessage(error: unknown): string {
  return error instanceof BootstrapError ? `AUTH_DEV_FAILED [${error.code}]: ${failureMessages[error.code]}` : safeError(error);
}

export async function bootstrapPlatform(client: Client, email: string, password: string, checksum: string): Promise<void> {
  let normalized: string;
  try { normalized = canonicalEmail(email); } catch { throw new BootstrapError('EMAIL_INVALID'); }
  requireBootstrap(newPasswordValid(password), 'PASSWORD_POLICY');
  const passwordHash = await hashPassword(password);
  await verifyAdmin(client);
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(174013,1)');
    requireBootstrap(await checkReceipt(client, checksum), 'SETUP_RECEIPT');
    const administrators = await client.query('SELECT 1 FROM app_private.platform_admin LIMIT 1');
    requireBootstrap(administrators.rowCount === 0, 'ADMIN_EXISTS');
    const existing = await client.query('SELECT 1 FROM app_private.app_user WHERE email_normalized=$1 LIMIT 1', [normalized]);
    requireBootstrap(existing.rowCount === 0, 'EMAIL_EXISTS');
    const id = randomUUID();
    await client.query('INSERT INTO app_private.app_user(id,email_normalized,password_hash) VALUES ($1,$2,$3)', [id, normalized, passwordHash]);
    await client.query('INSERT INTO app_private.platform_admin(user_id) VALUES ($1)', [id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
}

export function inputDisplay(value: string, masked: boolean): string {
  return masked ? '*'.repeat([...value].length) : value;
}

export function consoleInput(prompt: string, masked: boolean): Promise<string> {
  requireBootstrap(process.stdin.isTTY && process.stdout.isTTY, 'TTY_REQUIRED');
  return new Promise((resolveInput, reject) => {
    const input = process.stdin;
    const decoder = new StringDecoder('utf8');
    let value = '';
    const wasRaw = input.isRaw;
    const cleanup = (): void => { input.off('data', onData); input.off('error', onError); input.setRawMode(wasRaw); input.pause(); process.stdout.write('\n'); };
    const onError = (): void => { cleanup(); reject(new BootstrapError('INPUT_FAILED')); };
    const onData = (data: Buffer): void => {
      for (const char of decoder.write(data)) {
        if (char === '\u0003' || char === '\u0004' || char === '\u001b') { cleanup(); reject(new BootstrapError('INPUT_CANCELLED')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolveInput(value); return; }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (/\p{Cc}/u.test(char) || (!masked && /\p{Cf}/u.test(char))) { cleanup(); reject(new BootstrapError('INPUT_CONTROL')); return; }
        else value += char;
        if ([...value].length > 1024) { cleanup(); reject(new BootstrapError('INPUT_LIMIT')); return; }
        // Redibujar permite corregir Unicode sin revelar contraseñas ni usar su
        // contenido en mensajes de diagnóstico. La clave solo produce asteriscos.
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        process.stdout.write(prompt + inputDisplay(value, masked));
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true); input.on('data', onData); input.once('error', onError); input.resume();
  });
}
export async function main(): Promise<void> {
  requireBootstrap(process.argv.length === 2 && process.stdin.isTTY && process.stdout.isTTY, 'TTY_REQUIRED');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const profiles = loadProfiles(root);
  const bundle = sqlBundle(root);
  const email = await consoleInput('Correo del primer administrador: ', false);
  const password = await consoleInput('Contraseña: ', true);
  const confirm = await consoleInput('Repetir contraseña: ', true);
  requireBootstrap(password === confirm, 'PASSWORD_MISMATCH');
  const client = new Client({ connectionString: profiles.admin.AUTH_DEV_ADMIN_URL, connectionTimeoutMillis: 5000 });
  try { await client.connect(); await bootstrapPlatform(client, email, password, bundle.checksum); }
  finally { await client.end().catch(() => undefined); }
  console.log('AUTH_DEV_BOOTSTRAP_OK');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(bootstrapFailureMessage(error)); process.exitCode = 1; });
}
