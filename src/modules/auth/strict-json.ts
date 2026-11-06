import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthError } from './errors.js';

/** JSON.parse valida gramática; este recorrido adicional rechaza duplicados antes de usarlos. */
export function parseStrictJson(text: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    let offset = 0;
    const whitespace = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
    const string = (): string => {
      const start = offset++;
      while (offset < text.length) {
        const char = text[offset++];
        if (char === '\\') offset++;
        else if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      }
      throw new Error();
    };
    const value = (depth: number): void => {
      if (depth > 64) throw new Error();
      whitespace();
      const first = text[offset];
      if (first === '"') { string(); return; }
      if (first === '{') {
        offset++; whitespace();
        const keys = new Set<string>();
        if (text[offset] === '}') { offset++; return; }
        while (offset < text.length) {
          whitespace();
          const key = string();
          if (keys.has(key)) throw new Error();
          keys.add(key); whitespace(); offset++; value(depth + 1); whitespace();
          if (text[offset++] === '}') return;
        }
        throw new Error();
      }
      if (first === '[') {
        offset++; whitespace();
        if (text[offset] === ']') { offset++; return; }
        while (offset < text.length) {
          value(depth + 1); whitespace();
          if (text[offset++] === ']') return;
        }
        throw new Error();
      }
      while (offset < text.length && !/[\s,}\]]/.test(text[offset] ?? '')) offset++;
    };
    value(0);
    return result as Record<string, unknown>;
  } catch { throw new AuthError(400, 'VALIDATION_ERROR', 'Entrada inválida'); }
}

export interface AuthRequest extends IncomingMessage { body?: unknown; ip?: string; params: Record<string, string> }
// Express/Nest enruta sin distinguir mayúsculas por defecto; la guarda debe coincidir.
const routes = /^\/api\/(?:auth\/(?:login|refresh|logout|me)|me\/companies|companies\/[^/]+)\/?$/i;
/** Se instala antes del parser de Nest; no consume cuerpos ajenos al alcance de auth. */
export function authJsonMiddleware(enabled: boolean) {
  return (request: AuthRequest, response: ServerResponse, next: () => void): void => {
    const path = (request.url ?? '').split('?')[0] ?? '';
    if (!enabled || !routes.test(path)) { next(); return; }
    response.setHeader('Cache-Control', 'no-store');
    const fail = (status: number, code: string): void => {
      if (response.writableEnded) return;
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: { code, message: status === 400 ? 'Entrada inválida' : 'Solicitud rechazada' } }));
    };
    const expectsBody = request.method === 'POST' && /\/auth\/(login|refresh|logout)\/?$/i.test(path);
    const hasBody = request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] ?? '0') > 0;
    if (!expectsBody) {
      if (hasBody) { request.resume(); fail(400, 'VALIDATION_ERROR'); return; }
      next(); return;
    }
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type)) {
      request.resume(); fail(415, 'UNSUPPORTED_MEDIA_TYPE'); return;
    }
    if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
      request.resume(); fail(415, 'UNSUPPORTED_MEDIA_TYPE'); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16384) { chunks.length = 0; fail(413, 'PAYLOAD_TOO_LARGE'); }
      else if (!response.writableEnded) chunks.push(chunk);
    });
    request.once('error', () => fail(400, 'VALIDATION_ERROR'));
    request.once('end', () => {
      if (response.writableEnded) return;
      try {
        request.body = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        next();
      } catch { fail(400, 'VALIDATION_ERROR'); }
    });
  };
}
