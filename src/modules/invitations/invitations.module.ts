import { Controller, Header, HttpCode, Module, Param, Post, Req, UseFilters } from '@nestjs/common';
import { AuthModule, AuthExceptionFilter } from '../auth/auth.module.js';
import { AuthRuntime } from '../auth/runtime.js';
import { AuthError } from '../auth/errors.js';
import type { AuthRequest } from '../auth/strict-json.js';
import { cursorQuery, identifier } from '../companies/input.js';
import { InvitationsRuntime } from './runtime.js';

function body(request: AuthRequest, keys: string[]): Record<string, string> {
  const fail = (fields?: Array<{ field: string; code: string }>): never => { throw new AuthError(400, 'VALIDATION_ERROR', 'Revisa los campos enviados', fields); };
  const value = request.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) if (!keys.includes(key)) {
    if (['userId', 'companyId', 'role', 'email', 'status'].includes(key)) fail([{ field: key, code: 'PROTECTED_FIELD' }]);
    fail();
  }
  for (const key of keys) if (typeof data[key] !== 'string') fail([{ field: key, code: key in data ? 'TYPE' : 'REQUIRED' }]);
  return data as Record<string, string>;
}
@Controller()
@UseFilters(AuthExceptionFilter)
export class InvitationsController {
  constructor(private readonly auth: AuthRuntime, private readonly runtime: InvitationsRuntime) {}
  private async principal(request: AuthRequest) {
    const { service } = await this.auth.ready();
    return service.authenticate(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
  }
  @Post('platform/companies/:companyId/initial-invitation') @HttpCode(202) @Header('Cache-Control', 'no-store')
  async emit(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const p = await this.principal(request); cursorQuery(request.url ?? '/', false);
    return (await this.runtime.ready()).emit(p, identifier(cid, 'companyId'), body(request, ['email']).email!);
  }
  @Post('platform/companies/:companyId/initial-invitation/resend') @HttpCode(202) @Header('Cache-Control', 'no-store')
  async resend(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const p = await this.principal(request); cursorQuery(request.url ?? '/', false);
    return (await this.runtime.ready()).emit(p, identifier(cid, 'companyId'));
  }
  @Post('auth/invitations/accept-new') @HttpCode(201) @Header('Cache-Control', 'no-store')
  async acceptNew(@Req() request: AuthRequest) {
    cursorQuery(request.url ?? '/', false); const input = body(request, ['invitationToken', 'password']);
    return (await this.runtime.ready()).accept(input.invitationToken!, request.socket.remoteAddress ?? 'unknown', undefined, input.password!);
  }
  @Post('auth/invitations/accept') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async accept(@Req() request: AuthRequest) {
    const p = await this.principal(request); cursorQuery(request.url ?? '/', false);
    return (await this.runtime.ready()).accept(body(request, ['invitationToken']).invitationToken!, request.socket.remoteAddress ?? 'unknown', p);
  }
}
@Module({ imports: [AuthModule], controllers: [InvitationsController], providers: [InvitationsRuntime] })
export class InvitationsModule {}
