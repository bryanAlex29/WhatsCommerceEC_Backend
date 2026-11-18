import nodemailer from 'nodemailer';
import type { InvitationMailer } from './invitations.js';

/** Solo captura local. No host configurable, auth, relay ni transporte Gmail. */
export function mailpitInvitationMailer(port: number): InvitationMailer {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MAILPIT_CONFIG_INVALID');
  const smtp = nodemailer.createTransport({
    host: '127.0.0.1', port, secure: false, ignoreTLS: true,
    connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
  });
  return { async send(email, token) {
    const result = await smtp.sendMail({
      from: { name: 'WhatsCommerce EC (captura local)', address: 'invitations@whatscommerce.example.test' }, to: email,
      subject: 'Invitación inicial de WhatsCommerce EC',
      text: `Código manual de invitación: ${token}\n\nVigencia: 48 horas desde su emisión. Un solo uso. Si solicitaste un reenvío, usa el código más reciente. No compartas el código.`,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return result.accepted.some(address => address.toLowerCase() === email) && result.rejected.length === 0;
  } };
}
