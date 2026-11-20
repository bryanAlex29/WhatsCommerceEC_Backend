import { AuthError } from '../auth/errors.js';
import { canonicalEmail, uuid, validUnicode } from '../auth/input.js';
import type { BranchInput, CompanyInput, CompanyPatch } from './ports.js';

type FieldCode = 'REQUIRED' | 'TYPE' | 'LENGTH' | 'FORMAT' | 'UNKNOWN_FIELD' | 'PROTECTED_FIELD' | 'EMPTY_PATCH';
function invalid(field?: string, code: FieldCode = 'FORMAT'): never {
  throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa los campos enviados.', field ? [{ field, code }] : undefined);
}
export function identifier(value: string, field: 'companyId' | 'branchId'): string {
  if (!uuid.test(value)) invalid(field);
  return value;
}
export function cursorQuery(url: string, allowed: boolean): string | undefined {
  const parameters = new URL(url, 'http://local.invalid').searchParams;
  for (const key of parameters.keys()) if (!allowed || key !== 'cursor') invalid();
  if (!parameters.has('cursor')) return undefined;
  const value = parameters.get('cursor');
  if (parameters.getAll('cursor').length !== 1 || !value || value.length > 2048 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new AuthError(400, 'INVALID_CURSOR', 'Cursor inválido');
  }
  return value;
}
const protectedFields = new Set(['id', 'companyId', 'branchId', 'userId', 'role', 'status', 'activatedAt', 'createdAt', 'updatedAt', 'memberships']);
function fields(body: unknown, allowed: string[], patch: boolean): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) {
    if (protectedFields.has(key) || key === 'ruc') invalid(key, 'PROTECTED_FIELD');
    invalid(); // Never reflect arbitrary caller-controlled property names.
  }
  if (patch && Object.keys(input).length === 0) invalid('body', 'EMPTY_PATCH');
  return input;
}
function text(value: unknown, field: string, max: number): string {
  if (value === undefined) invalid(field, 'REQUIRED');
  if (typeof value !== 'string') invalid(field, 'TYPE');
  // Validate before trimming so control characters are not silently erased.
  if (!validUnicode(value)) invalid(field);
  const result = value.trim();
  if (!result) invalid(field, 'REQUIRED');
  if ([...result].length > max) invalid(field, 'LENGTH');
  return result;
}
function contact(value: unknown, field: string, email: boolean): string {
  const result = text(value, field, email ? 1024 : 16);
  if (!email) { if (!/^\+[0-9]{8,15}$/.test(result)) invalid(field); return result; }
  try { return canonicalEmail(result); } catch { return invalid(field); }
}
export function companyInput(body: unknown, patch: false): CompanyInput;
export function companyInput(body: unknown, patch: true): CompanyPatch;
export function companyInput(body: unknown, patch: boolean): CompanyInput | CompanyPatch {
  const limits = { tradeName: 150, legalName: 250, taxAddress: 300 };
  const keys = [...Object.keys(limits), 'contactEmail', 'contactPhone', ...(!patch ? ['ruc'] : [])];
  const input = fields(body, keys, patch); const output: Record<string, string> = {};
  for (const [field, max] of Object.entries(limits)) if (!patch || field in input) output[field] = text(input[field], field, max);
  for (const field of ['contactEmail', 'contactPhone']) if (!patch || field in input) output[field] = contact(input[field], field, field === 'contactEmail');
  if (!patch) {
    const ruc = text(input.ruc, 'ruc', 13);
    if (!/^[0-9]{13}$/.test(ruc)) invalid('ruc');
    return { tradeName: output.tradeName!, legalName: output.legalName!, taxAddress: output.taxAddress!,
      contactEmail: output.contactEmail!, contactPhone: output.contactPhone!, ruc };
  }
  return output;
}
export function branchInput(body: unknown, patch: boolean): Partial<BranchInput> {
  const input = fields(body, ['name', 'address', 'email', 'phone'], patch);
  const output: Partial<BranchInput> = {};
  if (!patch || 'name' in input) output.name = text(input.name, 'name', 150);
  if (!patch || 'address' in input) output.address = text(input.address, 'address', 300);
  for (const field of ['email', 'phone'] as const) if (field in input) {
    output[field] = input[field] === null ? null : contact(input[field], field, field === 'email');
  }
  return output;
}
