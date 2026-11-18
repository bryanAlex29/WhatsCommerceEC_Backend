import type { Principal } from '../auth/crypto.js';
import type { CompanyFull } from '../auth/ports.js';

export type CompanyStatus = 'PENDING_ACTIVATION' | 'ACTIVE' | 'SUSPENDED';
export interface Company extends Omit<CompanyFull, 'status'> { status: CompanyStatus }
export interface CompanyInput {
  tradeName: string; legalName: string; ruc: string; taxAddress: string; contactEmail: string; contactPhone: string;
}
export type CompanyPatch = Partial<Omit<CompanyInput, 'ruc'>>;
export interface BranchInput { name: string; address: string; email?: string | null; phone?: string | null }
export interface Branch extends Required<BranchInput> {
  id: string; companyId: string; createdAt: string; updatedAt: string;
}
export interface Page<T> { items: T[]; nextCursor: string | null }
export type CompanyAction = 'read' | 'patch' | 'suspend' | 'reactivate';
/** Every method reauthorizes current session/privilege inside the database transaction. */
export interface CompaniesPort {
  list(principal: Principal, cursor?: string): Promise<Page<Company>>;
  create(principal: Principal, input: CompanyInput): Promise<Company>;
  company(principal: Principal, companyId: string, action: CompanyAction, patch?: CompanyPatch): Promise<Company>;
  branches(principal: Principal, companyId: string, platform: boolean, cursor?: string): Promise<Page<Branch>>;
  branch(principal: Principal, companyId: string, branchId: string | undefined, input: Partial<BranchInput>): Promise<Branch>;
}
