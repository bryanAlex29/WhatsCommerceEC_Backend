import { canonicalEmail } from './input.js';
import type { RecoveryMailer } from './recovery.js';

export const gmailSendScope = 'https://www.googleapis.com/auth/gmail.send';
export const gmailScopes = `openid email ${gmailSendScope}`;
export type GmailFetch = (url: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;
export class GmailApiError extends Error {
  constructor(readonly code: 'GMAIL_AUTHORIZATION_REQUIRED' | 'GMAIL_CONNECTION_UNAVAILABLE' | 'GMAIL_SEND_REJECTED' | 'GMAIL_RESPONSE_INVALID') { super(code); }
}
export function allowedGmailScopes(scope: unknown): boolean {
  if (typeof scope !== 'string') return false;
  const scopes = scope.split(/\s+/).filter(Boolean);
  const allowed = [gmailSendScope, 'openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'];
  return scopes.includes(gmailSendScope) && scopes.includes('openid') &&
    (scopes.includes('email') || scopes.includes('https://www.googleapis.com/auth/userinfo.email')) && scopes.every(value => allowed.includes(value));
}
export function recoveryMime(sender: string, email: string, code: string): string {
  if (canonicalEmail(sender) !== sender || canonicalEmail(email) !== email || !/^[0-9]{8}$/.test(code)) throw new GmailApiError('GMAIL_RESPONSE_INVALID');
  const subject = Buffer.from('Código de recuperación de WhatsCommerce EC').toString('base64');
  const body = Buffer.from(`Tu código de recuperación es: ${code}\n\nCaduca 15 minutos después de solicitarlo y solo puede usarse una vez. Si solicitaste otro, usa el más reciente.\n\nSi no solicitaste este cambio, ignora el mensaje. No compartas el código.`, 'utf8').toString('base64').match(/.{1,76}/g)!.join('\r\n');
  return [`From: WhatsCommerce EC <${sender}>`, `To: ${email}`, `Subject: =?UTF-8?B?${subject}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated', '', body, ''].join('\r\n');
}
export interface GmailCredentials { sender: string; clientId: string; clientSecret: string; refreshToken: string }
/** Solo HTTPS443. No URLs configurables, redirect de credenciales, logs o reintentos ocultos. */
export class GmailApiMailer implements RecoveryMailer {
  private token?: { value: string; expiresAt: number };
  private flight?: Promise<string>;
  constructor(private readonly credentials: GmailCredentials, private readonly http: GmailFetch = fetch,
    private readonly now: () => number = Date.now) {}
  private async call(url: string, options: RequestInit) {
    try { return await this.http(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new GmailApiError('GMAIL_CONNECTION_UNAVAILABLE'); }
  }
  private access(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60000) return Promise.resolve(this.token.value);
    return this.flight ??= this.refresh().finally(() => { this.flight = undefined; });
  }
  private async refresh(): Promise<string> {
    const response = await this.call('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken, grant_type: 'refresh_token' }).toString() });
    if (!response.ok || response.status !== 200) throw new GmailApiError(response.status === 400 || response.status === 401 ? 'GMAIL_AUTHORIZATION_REQUIRED' : 'GMAIL_CONNECTION_UNAVAILABLE');
    let value: Record<string, unknown>;
    try { const json: unknown = await response.json(); if (!json || typeof json !== 'object') throw new Error(); value = json as Record<string, unknown>; }
    catch { throw new GmailApiError('GMAIL_RESPONSE_INVALID'); }
    if (typeof value.access_token !== 'string' || !/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(value.access_token) || value.token_type !== 'Bearer' ||
      typeof value.expires_in !== 'number' || !Number.isInteger(value.expires_in) || value.expires_in < 60 || value.expires_in > 86400 ||
      (value.scope !== undefined && !allowedGmailScopes(value.scope))) throw new GmailApiError('GMAIL_RESPONSE_INVALID');
    this.token = { value: value.access_token, expiresAt: this.now() + value.expires_in * 1000 };
    return value.access_token;
  }
  /** Verifica renovación OAuth; no envía mensaje ni acredita entrega. */
  async verify(): Promise<void> { await this.access(); }
  async send(email: string, code: string): Promise<boolean> {
    const raw = Buffer.from(recoveryMime(this.credentials.sender, email, code), 'utf8').toString('base64url');
    const access = await this.access();
    const response = await this.call('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
    if (!response.ok || response.status !== 200) {
      if (response.status === 401) this.token = undefined;
      throw new GmailApiError(response.status === 401 ? 'GMAIL_AUTHORIZATION_REQUIRED' : 'GMAIL_SEND_REJECTED');
    }
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test((value as { id: string }).id)) throw new Error();
    } catch { throw new GmailApiError('GMAIL_RESPONSE_INVALID'); }
    return true;
  }
}
