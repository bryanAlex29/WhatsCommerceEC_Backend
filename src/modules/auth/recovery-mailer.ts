import nodemailer from 'nodemailer';
import type { RecoveryMailer } from './recovery.js';

/** Remitente Gmail dedicado; TLS obligatorio, sin logging ni acceso al buzón. */
export function gmailRecoveryMailer(user: string, appPassword: string): RecoveryMailer {
  const smtp = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user, pass: appPassword }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  return { async send(email, code) {
    const result = await smtp.sendMail({
      from: { name: 'WhatsCommerce EC', address: user }, to: email,
      subject: 'Código de recuperación de WhatsCommerce EC',
      text: `Tu código de recuperación es: ${code}\n\nCaduca 15 minutos después de solicitarlo y solo puede usarse una vez. Si solicitaste otro, usa el más reciente.\n\nSi no solicitaste este cambio, ignora el mensaje. No compartas el código.`,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return result.accepted.some(address => address.toLowerCase() === email);
  } };
}
