import { fileURLToPath } from 'node:url';
import { recoveryConfig } from './recovery-config.js';
import { GmailApiMailer, GmailApiError } from '../src/modules/auth/gmail-api-mailer.js';

try {
  if (process.argv.length !== 2) throw new Error();
  const { config } = recoveryConfig(fileURLToPath(new URL('../', import.meta.url)));
  if (config.RECOVERY_MAIL_TRANSPORT !== 'gmail-api') throw new Error();
  await new GmailApiMailer({ sender: config.SMTP_USER!, clientId: config.GMAIL_OAUTH_CLIENT_ID!,
    clientSecret: config.GMAIL_OAUTH_CLIENT_SECRET!, refreshToken: config.GMAIL_OAUTH_REFRESH_TOKEN! }).verify();
  console.log('GMAIL_API_OAUTH_OK. Renovación aceptada, sin enviar correos; no confirma entrega.');
} catch (error) {
  console.error(error instanceof GmailApiError ? error.code : 'GMAIL_API_CONFIG_UNAVAILABLE'); process.exitCode = 1;
}
