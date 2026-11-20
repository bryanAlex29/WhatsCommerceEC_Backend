import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { validateEnvironment } from '../src/config/environment.js';

export function runtimeProfile(root: string): Record<string, string> {
  const path = resolve(root, '.env.auth-dev');
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('RECOVERY_CONFIG_INVALID');
  return parse(readFileSync(path));
}

export function recoveryConfig(root: string, includeGmail = true) {
  const runtime = runtimeProfile(root);
  const path = resolve(root, '.env.recovery-dev');
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('RECOVERY_CONFIG_INVALID');
  const overlay = parse(readFileSync(path));
  const keys = ['RECOVERY_ENABLED','RECOVERY_MAC_KEY','RECOVERY_ENCRYPTION_KEY','RECOVERY_DELIVERY_DATABASE_URL','SMTP_USER','SMTP_APP_PASSWORD'];
  if (Object.keys(overlay).sort().join() !== keys.sort().join()) throw new Error('RECOVERY_CONFIG_INVALID');
  let gmail: Record<string, string> = {};
  const gmailPath = resolve(root, '.env.gmail-api-dev');
  if (includeGmail && existsSync(gmailPath)) {
    if (!lstatSync(gmailPath).isFile() || lstatSync(gmailPath).isSymbolicLink()) throw new Error('GMAIL_CONFIG_INVALID');
    gmail = parse(readFileSync(gmailPath));
    const allowed = ['RECOVERY_MAIL_TRANSPORT','GMAIL_OAUTH_CLIENT_ID','GMAIL_OAUTH_CLIENT_SECRET','GMAIL_OAUTH_REFRESH_TOKEN'];
    if (Object.keys(gmail).sort().join() !== allowed.sort().join() || gmail.RECOVERY_MAIL_TRANSPORT !== 'gmail-api') throw new Error('GMAIL_CONFIG_INVALID');
  }
  const config = validateEnvironment({ ...runtime, ...overlay, ...gmail });
  if (!config.RECOVERY_ENABLED) throw new Error('RECOVERY_CONFIG_DISABLED');
  return { config };
}
