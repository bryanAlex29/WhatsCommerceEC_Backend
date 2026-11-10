import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, Header, HttpCode, Module, Param, Post, Req, UseFilters } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { AuthError, unavailable } from './errors.js';
import { uuid } from './input.js';
import { RateLimitError } from './rate-limit.js';
import { AuthRuntime } from './runtime.js';
import type { AuthRequest } from './strict-json.js';

interface Response {
  setHeader(name: string, value: string): void;
  status(status: number): Response;
  json(body: unknown): void;
}
@Catch()
export class AuthExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    const known = error instanceof AuthError;
    if (error instanceof RateLimitError) response.setHeader('Retry-After', String(error.retryAfter));
    response.status(known ? error.status : 500).json({ error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'No se pudo completar la solicitud',
      ...(known && error.code === 'VALIDATION_ERROR' && error.fields ? { fields: error.fields } : {}),
    } });
  }
}
function invalid(fields?: Array<{ field: string; code: string }>): never {
  throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa los campos enviados.', fields);
}
function body(request: AuthRequest, expected: string[]): Record<string, string> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) invalid();
  const object = request.body as Record<string, unknown>;
  const fields: Array<{ field: string; code: string }> = [];
  for (const key of Object.keys(object)) {
    if (!expected.includes(key)) {
      if (['userId', 'companyId', 'role'].includes(key)) fields.push({ field: key, code: 'PROTECTED_FIELD' });
      else invalid(); // No reflejar nombres arbitrarios aportados por el cliente.
    }
  }
  for (const field of expected) {
    if (!(field in object)) fields.push({ field, code: 'REQUIRED' });
    else if (typeof object[field] !== 'string') fields.push({ field, code: 'TYPE' });
  }
  if (fields.length) invalid(fields);
  return object as Record<string, string>;
}
function query(request: AuthRequest, allowCursor = false): string | undefined {
  const parameters = new URL(request.url ?? '/', 'http://local.invalid').searchParams;
  for (const key of parameters.keys()) if (!allowCursor || key !== 'cursor') invalid();
  if (!allowCursor || !parameters.has('cursor')) return undefined;
  const cursor = parameters.get('cursor');
  if (parameters.getAll('cursor').length !== 1 || !cursor || cursor.length > 2048 || !/^[\x21-\x7e]+$/.test(cursor)) {
    throw new AuthError(400, 'INVALID_CURSOR', 'Cursor inválido');
  }
  return cursor;
}
function authorization(headers: IncomingHttpHeaders): string | undefined {
  return typeof headers.authorization === 'string' ? headers.authorization : undefined;
}
@Controller()
@UseFilters(AuthExceptionFilter)
export class AuthController {
  constructor(private readonly runtime: AuthRuntime) {}
  @Post('auth/password-recovery/request') @HttpCode(202) @Header('Cache-Control', 'no-store')
  async recoveryRequest(@Req() request: AuthRequest) {
    const { recovery } = await this.runtime.ready();
    if (!recovery) unavailable();
    query(request);
    return recovery.request(body(request, ['email']).email ?? '', this.ip(request));
  }
  @Post('auth/password-recovery/reset') @HttpCode(204) @Header('Cache-Control', 'no-store')
  async recoveryReset(@Req() request: AuthRequest): Promise<void> {
    const { recovery } = await this.runtime.ready();
    if (!recovery) unavailable();
    query(request);
    const input = body(request, ['email', 'code', 'password']);
    await recovery.reset(input.email ?? '', input.code ?? '', input.password ?? '', this.ip(request));
  }
  @Post('auth/login') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async login(@Req() request: AuthRequest) {
    const { service } = await this.runtime.ready();
    query(request);
    const input = body(request, ['email', 'password']);
    return service.login(input.email ?? '', input.password ?? '', this.ip(request));
  }
  @Post('auth/refresh') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async refresh(@Req() request: AuthRequest) {
    const { service } = await this.runtime.ready();
    query(request);
    return service.refresh(body(request, ['refreshToken']).refreshToken ?? '', this.ip(request));
  }
  @Post('auth/logout') @HttpCode(204) @Header('Cache-Control', 'no-store')
  async logout(@Req() request: AuthRequest): Promise<void> {
    const { service } = await this.runtime.ready();
    query(request);
    await service.logout(body(request, ['refreshToken']).refreshToken ?? '', this.ip(request));
  }
  @Get('auth/me') @Header('Cache-Control', 'no-store')
  async me(@Req() request: AuthRequest) {
    const { service, identity } = await this.runtime.ready();
    query(request);
    return identity.self(await service.authenticate(authorization(request.headers)));
  }
  @Get('me/companies') @Header('Cache-Control', 'no-store')
  async companies(@Req() request: AuthRequest) {
    const { service, identity } = await this.runtime.ready();
    const cursor = query(request, true);
    return identity.companies(await service.authenticate(authorization(request.headers)), cursor);
  }
  @Get('companies/:companyId') @Header('Cache-Control', 'no-store')
  async company(@Req() request: AuthRequest, @Param('companyId') companyId: string) {
    const { service, tenant } = await this.runtime.ready();
    query(request);
    const principal = await service.authenticate(authorization(request.headers));
    if (!uuid.test(companyId)) invalid([{ field: 'companyId', code: 'FORMAT' }]);
    return tenant.company(principal, companyId);
  }
  private ip(request: AuthRequest): string {
    // Sin trust proxy: un X-Forwarded-For del móvil no elude las cuotas.
    return request.socket.remoteAddress ?? 'unknown';
  }
}
@Module({ controllers: [AuthController], providers: [AuthRuntime] })
export class AuthModule {}
