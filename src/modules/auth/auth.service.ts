import { AccessTokens, randomRefresh, tokenHash, verifyPassword } from './crypto.js';
import type { Principal } from './crypto.js';
import { AuthError } from './errors.js';
import { canonicalEmail, refreshFormat, validUnicode } from './input.js';
import type { IdentityPort, RateLimitPort, SessionRecord } from './ports.js';

export class AuthService {
  constructor(private readonly identity: IdentityPort, private readonly limits: RateLimitPort,
    private readonly jwt: AccessTokens, private readonly dummyHash: string) {}
  async login(email: string, password: string, ip: string) {
    await this.limits.consume('login-ip', ip);
    const normalized = canonicalEmail(email);
    await this.limits.checkLoginFailures(`${normalized}\0${ip}`);
    if (!validUnicode(password) || [...password].length > 128 || password.length === 0) {
      await this.limits.consume('login-failure', `${normalized}\0${ip}`);
      throw new AuthError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }
    const credential = await this.identity.credential(normalized);
    const valid = await verifyPassword(credential?.passwordHash ?? this.dummyHash, password);
    if (!credential || !valid) {
      await this.limits.consume('login-failure', `${normalized}\0${ip}`);
      throw new AuthError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');
    }
    const refresh = randomRefresh();
    return this.tokens(await this.identity.createSession(credential.userId, tokenHash(refresh), credential.passwordHash), refresh);
  }
  async refresh(refresh: string, ip: string) {
    await this.limits.consume('refresh-ip', ip);
    this.validateRefresh(refresh);
    const sessionId = await this.identity.refreshSession(tokenHash(refresh));
    if (sessionId) await this.limits.consume('refresh-session', sessionId);
    const replacement = randomRefresh();
    // Lookup only selects a quota key; rotate must revalidate and lock the session.
    const result = await this.identity.rotate(tokenHash(refresh), tokenHash(replacement));
    // Failure is raised OUTSIDE the persistence transaction: reuse revocation remains committed.
    if (result.code !== 'OK') throw new AuthError(401, result.code);
    return this.tokens(result.session, replacement);
  }
  async logout(refresh: string, ip: string): Promise<void> {
    this.validateRefresh(refresh);
    let limitFailure: unknown;
    try { await this.limits.consume('logout-ip', ip); } catch (error) { limitFailure = error; }
    await this.identity.logout(tokenHash(refresh));
    if (limitFailure) throw limitFailure;
  }
  async authenticate(authorization?: string): Promise<Principal> {
    if (!authorization?.startsWith('Bearer ')) throw new AuthError(401, 'UNAUTHENTICATED');
    const principal = await this.jwt.verify(authorization.slice(7));
    await this.identity.self(principal);
    return principal;
  }
  private validateRefresh(refresh: string): void {
    if (!refreshFormat.test(refresh) || Buffer.from(refresh, 'base64url').toString('base64url') !== refresh) throw new AuthError(401, 'INVALID_REFRESH_TOKEN');
  }
  private async tokens(session: SessionRecord, refreshToken: string) {
    return { accessToken: await this.jwt.issue(session.principal), tokenType: 'Bearer' as const,
      expiresIn: 900 as const, refreshToken, refreshExpiresAt: session.absoluteExpiresAt.toISOString(), user: session.user };
  }
}
