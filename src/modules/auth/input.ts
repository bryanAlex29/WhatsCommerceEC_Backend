import { domainToASCII } from 'node:url';
import { AuthError } from './errors.js';

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const refreshFormat = /^[A-Za-z0-9_-]{43}$/;
export function validUnicode(value: string): boolean {
  return !/[\p{Cc}\p{Cs}]/u.test(value);
}
export function canonicalEmail(value: string): string {
  const original = value.trim();
  // No transformar una parte local Unicode prohibida en otra identidad ASCII.
  if ([...(original.split('@')[0] ?? '')].some(character => character.charCodeAt(0) > 127)) {
    throw new AuthError(400, 'VALIDATION_ERROR', 'Entrada inválida');
  }
  const email = original.toLowerCase();
  const parts = email.split('@');
  const local = parts[0] ?? '';
  const domain = parts[1] ?? '';
  if (parts.length !== 2 || !validUnicode(email) ||
      !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(local) ||
      /[\s:/\\?#%[\]@]/u.test(domain)) throw new AuthError(400, 'VALIDATION_ERROR', 'Entrada inválida');
  const ascii = domainToASCII(domain);
  if (!ascii || !ascii.includes('.') || /^\d+(?:\.\d+){3}$/.test(ascii) ||
      !ascii.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      `${local}@${ascii}`.length > 254) throw new AuthError(400, 'VALIDATION_ERROR', 'Entrada inválida');
  return `${local}@${ascii}`;
}
export function newPasswordValid(value: string): boolean {
  // Los números están permitidos, pero no son obligatorios. No restringir la
  // contraseña a una lista de letras/símbolos ni transformar su contenido.
  const length = [...value].length;
  return length >= 15 && length <= 128 && validUnicode(value) &&
    !/[\p{White_Space}\p{Cf}]/u.test(value) && /\p{Lu}/u.test(value) && /[\p{P}\p{S}]/u.test(value);
}
