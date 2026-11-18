import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { allowedGmailScopes, gmailScopes, GmailApiError, type GmailFetch } from '../src/modules/auth/gmail-api-mailer.js';

export interface DesktopClient { clientId: string; clientSecret: string }
export function desktopClient(json: unknown): DesktopClient {
  if (!json || typeof json !== 'object') throw new Error('GMAIL_CLIENT_INVALID');
  const installed = (json as { installed?: unknown }).installed;
  if (!installed || typeof installed !== 'object') throw new Error('GMAIL_CLIENT_INVALID');
  const value = installed as Record<string, unknown>;
  if (typeof value.client_id !== 'string' || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.client_id) ||
    typeof value.client_secret !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(value.client_secret)) throw new Error('GMAIL_CLIENT_INVALID');
  return { clientId: value.client_id, clientSecret: value.client_secret };
}
export function oauthAttempt() {
  return { state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url') };
}
export function authorizationUrl(clientId: string, redirectUri: string, attempt: ReturnType<typeof oauthAttempt>, sender: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: gmailScopes,
    state: attempt.state, nonce: attempt.nonce, code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account', login_hint: sender }).toString();
  return url.href;
}
export async function localOAuthCallback(expectedState: string, timeout = 300000) {
  let resolveCode!: (code: string) => void; let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  let settled = false; let origin = '';
  const finish = (value?: string) => {
    if (settled) return;
    settled = true; clearTimeout(timer); server.close();
    if (value) resolveCode(value); else rejectCode(new Error('GMAIL_AUTHORIZATION_CANCELLED'));
  };
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const invalid = () => { response.statusCode = 400; response.end('Solicitud no válida. Regresa a la consola.'); };
    if (settled || request.method !== 'GET' || (request.url?.length ?? 0) > 4096 || request.headers.host !== new URL(origin).host) return invalid();
    let url: URL;
    try { url = new URL(request.url ?? '/', origin); } catch { return invalid(); }
    const state = url.searchParams.get('state') ?? '';
    const actualState = Buffer.from(state); const expected = Buffer.from(expectedState);
    if (url.origin !== origin || url.pathname !== '/oauth2callback' || url.searchParams.getAll('state').length !== 1 ||
      actualState.length !== expected.length || !timingSafeEqual(actualState, expected)) return invalid();
    const authorizationCode = url.searchParams.get('code');
    if (url.searchParams.has('error')) { invalid(); finish(); return; }
    if (!authorizationCode || url.searchParams.getAll('code').length !== 1 || !/^[\x21-\x7e]{1,2048}$/.test(authorizationCode)) return invalid();
    response.end('Autorización recibida. Cierra esta pestaña y revisa el resultado en tu consola. No compartas la dirección de esta página.');
    finish(authorizationCode);
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('GMAIL_CALLBACK_UNAVAILABLE'); }
  origin = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(() => finish(), timeout);
  return { redirectUri: `${origin}/oauth2callback`, code, cancel: () => finish() };
}
const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 10000 });
export type VerifyGoogleIdentity = (token: string, audience: string) => Promise<Record<string, unknown>>;
export const verifyGoogleIdentity: VerifyGoogleIdentity = async (token, audience) => {
  const { payload } = await jwtVerify(token, jwks, { algorithms: ['RS256'], audience,
    issuer: ['https://accounts.google.com', 'accounts.google.com'], maxTokenAge: '10m', clockTolerance: 5,
    requiredClaims: ['sub', 'iat', 'exp', 'email', 'email_verified', 'nonce'] });
  return payload;
};
export async function exchangeGmailAuthorization(client: DesktopClient, code: string, redirectUri: string,
  attempt: ReturnType<typeof oauthAttempt>, expectedSender: string, http: GmailFetch = fetch,
  verify: VerifyGoogleIdentity = verifyGoogleIdentity): Promise<string> {
  try {
    const response = await http('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: redirectUri,
        code_verifier: attempt.verifier, grant_type: 'authorization_code' }).toString() });
    if (!response.ok || response.status !== 200) throw new Error();
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') throw new Error();
    const tokens = value as Record<string, unknown>;
    if (!allowedGmailScopes(tokens.scope) || typeof tokens.refresh_token !== 'string' || !/^[A-Za-z0-9._~+/=-]{10,4096}$/.test(tokens.refresh_token) ||
      typeof tokens.id_token !== 'string' || tokens.token_type !== 'Bearer') throw new Error();
    const identity = await verify(tokens.id_token, client.clientId);
    if (identity.email !== expectedSender || identity.email_verified !== true || identity.nonce !== attempt.nonce ||
      (identity.azp !== undefined && identity.azp !== client.clientId)) throw new Error();
    return tokens.refresh_token;
  } catch { throw new GmailApiError('GMAIL_AUTHORIZATION_REQUIRED'); }
}
