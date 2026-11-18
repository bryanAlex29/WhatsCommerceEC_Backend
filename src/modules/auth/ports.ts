import type { Principal } from './crypto.js';
import { unavailable } from './errors.js';

export interface UserSelf { id: string; email: string; platformRole: 'PLATFORM_ADMIN' | null }
export interface SessionRecord { principal: Principal; user: UserSelf; absoluteExpiresAt: Date }
export type RotationResult = { code: 'OK'; session: SessionRecord } |
  { code: 'INVALID_REFRESH_TOKEN' | 'SESSION_REVOKED' | 'SESSION_EXPIRED' };
/** Each method is an atomic transaction. Rotate MUST commit reuse revocation before returning failure.
 * No general model access is permitted. Tenant must reauthorize inside its own transaction. */
export interface IdentityPort {
  credential(email: string): Promise<{ userId: string; passwordHash: string } | null>;
  createSession(userId: string, refreshHash: string, expectedPasswordHash: string): Promise<SessionRecord>;
  refreshSession(refreshHash: string): Promise<string | null>;
  rotate(refreshHash: string, replacementHash: string): Promise<RotationResult>;
  logout(refreshHash: string): Promise<void>;
  self(principal: Principal): Promise<UserSelf>;
  companies(principal: Principal, cursor?: string): Promise<{ items: CompanySelection[]; nextCursor: string | null }>;
}
export interface CompanySelection {
  companyId: string; tradeName: string;
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED'; role: 'COMPANY_ADMIN' | 'SELLER';
}
export interface CompanyBasic { representation: 'BASIC'; id: string; tradeName: string; status: 'ACTIVE' }
export interface CompanyFull extends Omit<CompanyBasic, 'representation'> {
  representation: 'FULL'; legalName: string; ruc: string; taxAddress: string;
  contactEmail: string; contactPhone: string; createdAt: string; updatedAt: string;
}
export interface TenantPort { company(principal: Principal, companyId: string): Promise<CompanyBasic | CompanyFull> }
export interface RateLimitPort {
  checkLoginFailures(key: string): Promise<void>;
  consume(scope: 'login-ip' | 'login-failure' | 'refresh-ip' | 'refresh-session' | 'logout-ip' |
    'recovery-ip' | 'recovery-email-minute' | 'recovery-email-hour' | 'recovery-reset-ip', key: string): Promise<void>;
}
/** Deliberately unavailable: never a mock or in-memory authentication runtime. */
export class UnavailablePersistence implements IdentityPort, TenantPort {
  credential(): ReturnType<IdentityPort['credential']> { return Promise.reject(this.failure()); }
  createSession(): Promise<SessionRecord> { return Promise.reject(this.failure()); }
  refreshSession(): Promise<string | null> { return Promise.reject(this.failure()); }
  rotate(): Promise<RotationResult> { return Promise.reject(this.failure()); }
  logout(): Promise<void> { return Promise.reject(this.failure()); }
  self(): Promise<UserSelf> { return Promise.reject(this.failure()); }
  companies(): ReturnType<IdentityPort['companies']> { return Promise.reject(this.failure()); }
  company(): ReturnType<TenantPort['company']> { return Promise.reject(this.failure()); }
  private failure(): unknown { try { unavailable(); } catch (error) { return error; } }
}
