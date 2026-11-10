import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { desktopClient, oauthAttempt, authorizationUrl, localOAuthCallback, exchangeGmailAuthorization, type VerifyGoogleIdentity } from './gmail-oauth.js';
import { gmailScopes, type GmailFetch } from '../src/modules/auth/gmail-api-mailer.js';

const client = { clientId: 'synthetic.apps.googleusercontent.com', clientSecret: 'synthetic-client-secret' };
const sender = 'synthetic.sender@gmail.com';
it('solo acepta JSON Desktop, no web ni cuenta de servicio', () => {
  expect(desktopClient({ installed: { client_id: client.clientId, client_secret: client.clientSecret } })).toEqual(client);
  expect(() => desktopClient({ web: { client_id: client.clientId, client_secret: client.clientSecret } })).toThrow();
  expect(() => desktopClient({ type: 'service_account' })).toThrow();
});
it('genera PKCE S256 y state/nonce distintos y abre solo Google', () => {
  const attempt = oauthAttempt(); const url = new URL(authorizationUrl(client.clientId, 'http://127.0.0.1:1234/oauth2callback', attempt, sender));
  expect(new Set(Object.values(attempt)).size).toBe(3);
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(attempt.verifier).digest('base64url'));
  expect(url.searchParams.get('scope')).toBe(gmailScopes);
  expect(url.searchParams.get('state')).toBe(attempt.state);
});
it('callback HTTP real solo loopback y state correcto, sin devolver código al navegador', async () => {
  const attempt = oauthAttempt(); const callback = await localOAuthCallback(attempt.state);
  try {
    const wrong = await fetch(`${callback.redirectUri}?state=incorrect&code=synthetic`, { headers: { Connection: 'close' } });
    expect(wrong.status).toBe(400);
    const unicode = await fetch(`${callback.redirectUri}?state=${encodeURIComponent('ñ'.repeat(43))}&code=synthetic`, { headers: { Connection: 'close' } });
    expect(unicode.status).toBe(400);
    const correct = await fetch(`${callback.redirectUri}?state=${attempt.state}&code=synthetic-authorization-code`, { headers: { Connection: 'close' } });
    expect(correct.status).toBe(200); expect(await correct.text()).not.toContain('synthetic-authorization-code');
    await expect(callback.code).resolves.toBe('synthetic-authorization-code');
  } finally { callback.cancel(); }
});
it('denegación de consentimiento no crea credenciales', async () => {
  const attempt = oauthAttempt(); const callback = await localOAuthCallback(attempt.state);
  const rejection = expect(callback.code).rejects.toThrow('GMAIL_AUTHORIZATION_CANCELLED');
  await fetch(`${callback.redirectUri}?state=${attempt.state}&error=access_denied`, { headers: { Connection: 'close' } }); await rejection;
});
function exchangeFixture() {
  const attempt = oauthAttempt();
  const http = jest.fn<GmailFetch>().mockResolvedValue({ ok: true, status: 200, json: async () => ({ scope: gmailScopes, token_type: 'Bearer', refresh_token: 'synthetic-refresh-token', id_token: 'synthetic-id-token' }) });
  const verify = jest.fn<VerifyGoogleIdentity>().mockResolvedValue({ email: sender, email_verified: true, nonce: attempt.nonce });
  const run = () => exchangeGmailAuthorization(client, 'synthetic-code', 'http://127.0.0.1:1234/oauth2callback', attempt, sender, http, verify);
  return { http, verify, attempt, run };
}
it('canje simulado envía verifier solo en body, comprueba identidad y no expone access tokens', async () => {
  const f = exchangeFixture(); await expect(f.run()).resolves.toBe('synthetic-refresh-token');
  expect(f.http.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
  expect(new URLSearchParams(f.http.mock.calls[0]![1].body as string).get('code_verifier')).toBe(f.attempt.verifier);
  expect(f.verify).toHaveBeenCalledWith('synthetic-id-token', client.clientId);
});
it.each(['wrong-email', 'unverified-email', 'wrong-nonce', 'wrong-client'])('rechaza identidad %s', async scenario => {
  const f = exchangeFixture(); f.verify.mockResolvedValue({ email: scenario === 'wrong-email' ? 'other@example.test' : sender,
    email_verified: scenario !== 'unverified-email', nonce: scenario === 'wrong-nonce' ? 'wrong' : f.attempt.nonce,
    ...(scenario === 'wrong-client' ? { azp: 'other-client' } : {}) });
  await expect(f.run()).rejects.toMatchObject({ code: 'GMAIL_AUTHORIZATION_REQUIRED' });
});
