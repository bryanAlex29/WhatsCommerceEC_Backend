import { jest } from '@jest/globals';
import { GmailApiMailer, recoveryMime, allowedGmailScopes, gmailScopes, type GmailFetch } from './gmail-api-mailer.js';

const credentials = { sender: 'synthetic.sender@gmail.com', clientId: 'synthetic.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret', refreshToken: 'synthetic-refresh-token' };
const token = (scope: unknown = gmailScopes) => ({ ok: true, status: 200, json: async () => ({ access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: 3600, scope }) });
const sent = () => ({ ok: true, status: 200, json: async () => ({ id: 'syntheticMessageId' }) });
function fixture() {
  const http = jest.fn<GmailFetch>().mockResolvedValueOnce(token()).mockResolvedValue(sent());
  return { http, mailer: new GmailApiMailer(credentials, http) };
}
describe('Gmail API con HTTP simulado; sin cuentas, tokens reales ni correo externo', () => {
  it('MIME base64 UTF8, ceros iniciales y sin inyección de cabeceras', () => {
    const mime = recoveryMime(credentials.sender, 'recipient@example.test', '00001234');
    expect(mime).toContain('To: recipient@example.test\r\n');
    const encoded = mime.split('\r\n\r\n')[1]!;
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').toString('utf8')).toContain('00001234');
    expect(() => recoveryMime(credentials.sender, 'recipient@example.test\r\nBcc:bad@example.test', '00001234')).toThrow();
  });
  it('solo HTTPS443 y bearer en cabecera; refresh en body, sin redirect de credenciales', async () => {
    const { http, mailer } = fixture();
    expect(await mailer.send('recipient@example.test', '00001234')).toBe(true);
    expect(http.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
    expect(http.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new URLSearchParams(http.mock.calls[0]![1].body as string).get('refresh_token')).toBe(credentials.refreshToken);
    expect(http.mock.calls[1]![0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(http.mock.calls[1]![1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer synthetic-access-token' } });
    expect(http.mock.calls[1]![0]).not.toContain('synthetic-access-token');
  });
  it('verificación OAuth no envía mensajes y reutiliza acceso en memoria', async () => {
    const { http, mailer } = fixture(); await mailer.verify(); await mailer.verify();
    expect(http).toHaveBeenCalledTimes(1);
    await mailer.send('recipient@example.test', '00001234'); expect(http).toHaveBeenCalledTimes(2);
  });
  it('renovación single-flight en llamadas simultáneas', async () => {
    const { http, mailer } = fixture(); await Promise.all([mailer.verify(), mailer.verify(), mailer.verify()]);
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('renueva al vencer sin guardar refresh nuevo o token en disco', async () => {
    let now = 0; const http = jest.fn<GmailFetch>().mockResolvedValue(token());
    const mailer = new GmailApiMailer(credentials, http, () => now);
    await mailer.verify(); now = 3590000; await mailer.verify(); expect(http).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401])('refresh rechazado%d requiere autorización, sin exponer cuerpo', async status => {
    const http = jest.fn<GmailFetch>().mockResolvedValue({ ok: false, status, json: async () => ({ private: 'never-log' }) });
    await expect(new GmailApiMailer(credentials, http).send('recipient@example.test', '00001234')).rejects.toMatchObject({ code: 'GMAIL_AUTHORIZATION_REQUIRED', message: 'GMAIL_AUTHORIZATION_REQUIRED' });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('timeout/red no se presenta como clave inválida ni reintenta send', async () => {
    const http = jest.fn<GmailFetch>().mockRejectedValue(new Error('private network details'));
    await expect(new GmailApiMailer(credentials, http).verify()).rejects.toMatchObject({ code: 'GMAIL_CONNECTION_UNAVAILABLE' });
    expect(http).toHaveBeenCalledTimes(1);
  });
  it.each([403, 429, 500])('send%d no se repite automáticamente ni finge aceptación', async status => {
    const { http, mailer } = fixture(); http.mockReset().mockResolvedValueOnce(token()).mockResolvedValue({ ok: false, status, json: async () => ({}) });
    await expect(mailer.send('recipient@example.test', '00001234')).rejects.toMatchObject({ code: 'GMAIL_SEND_REJECTED' }); expect(http).toHaveBeenCalledTimes(2);
  });
  it('401 descarta acceso; nueva operación renueva pero no repite la escritura incierta', async () => {
    const { http, mailer } = fixture(); http.mockReset().mockResolvedValueOnce(token()).mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }).mockResolvedValue(token());
    await expect(mailer.send('recipient@example.test', '00001234')).rejects.toMatchObject({ code: 'GMAIL_AUTHORIZATION_REQUIRED' });
    expect(http).toHaveBeenCalledTimes(2); await mailer.verify(); expect(http).toHaveBeenCalledTimes(3);
  });
  it('solo permite permisos de envío e identidad, no lectura ni administración', () => {
    expect(allowedGmailScopes(gmailScopes)).toBe(true);
    expect(allowedGmailScopes('openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send')).toBe(true);
    expect(allowedGmailScopes(`${gmailScopes} https://mail.google.com/`)).toBe(false);
    expect(allowedGmailScopes('openid email')).toBe(false);
  });
  it('rechaza respuesta de aceptación incompleta', async () => {
    const { http, mailer } = fixture(); http.mockReset().mockResolvedValueOnce(token()).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(mailer.send('recipient@example.test', '00001234')).rejects.toMatchObject({ code: 'GMAIL_RESPONSE_INVALID' });
  });
  it('rechaza concesión con permisos más amplios incluso al renovar', async () => {
    const http = jest.fn<GmailFetch>().mockResolvedValue(token(`${gmailScopes} https://www.googleapis.com/auth/gmail.readonly`));
    await expect(new GmailApiMailer(credentials, http).verify()).rejects.toMatchObject({ code: 'GMAIL_RESPONSE_INVALID' });
  });
});
