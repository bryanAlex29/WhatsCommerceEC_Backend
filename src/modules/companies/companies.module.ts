import { Controller, Get, Header, HttpCode, Module, Param, Patch, Post, Req, UseFilters } from '@nestjs/common';
import { AuthModule, AuthExceptionFilter } from '../auth/auth.module.js';
import { AuthRuntime } from '../auth/runtime.js';
import type { AuthRequest } from '../auth/strict-json.js';
import { branchInput, companyInput, cursorQuery, identifier } from './input.js';
import { CompaniesRuntime } from './runtime.js';

@Controller()
@UseFilters(AuthExceptionFilter)
export class CompaniesController {
  constructor(private readonly auth: AuthRuntime, private readonly runtime: CompaniesRuntime) {}
  private async principal(request: AuthRequest) {
    const { service } = await this.auth.ready();
    return service.authenticate(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
  }
  @Get('platform/companies') @Header('Cache-Control', 'no-store')
  async list(@Req() request: AuthRequest) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    return port.list(principal, cursorQuery(request.url ?? '/', true));
  }
  @Post('platform/companies') @HttpCode(201) @Header('Cache-Control', 'no-store')
  async create(@Req() request: AuthRequest) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.create(principal, companyInput(request.body, false));
  }
  @Get('platform/companies/:companyId') @Header('Cache-Control', 'no-store')
  async company(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.company(principal, identifier(cid, 'companyId'), 'read');
  }
  @Patch('platform/companies/:companyId') @Header('Cache-Control', 'no-store')
  async update(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.company(principal, identifier(cid, 'companyId'), 'patch', companyInput(request.body, true));
  }
  @Post('platform/companies/:companyId/suspend') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async suspend(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.company(principal, identifier(cid, 'companyId'), 'suspend');
  }
  @Post('platform/companies/:companyId/reactivate') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async reactivate(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.company(principal, identifier(cid, 'companyId'), 'reactivate');
  }
  @Get('platform/companies/:companyId/branches') @Header('Cache-Control', 'no-store')
  async platformBranches(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    return port.branches(principal, identifier(cid, 'companyId'), true, cursorQuery(request.url ?? '/', true));
  }
  @Get('companies/:companyId/branches') @Header('Cache-Control', 'no-store')
  async ownBranches(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    return port.branches(principal, identifier(cid, 'companyId'), false, cursorQuery(request.url ?? '/', true));
  }
  @Post('platform/companies/:companyId/branches') @HttpCode(201) @Header('Cache-Control', 'no-store')
  async createBranch(@Req() request: AuthRequest, @Param('companyId') cid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.branch(principal, identifier(cid, 'companyId'), undefined, branchInput(request.body, false));
  }
  @Patch('platform/companies/:companyId/branches/:branchId') @Header('Cache-Control', 'no-store')
  async updateBranch(@Req() request: AuthRequest, @Param('companyId') cid: string, @Param('branchId') bid: string) {
    const principal = await this.principal(request); const port = await this.runtime.ready();
    cursorQuery(request.url ?? '/', false);
    return port.branch(principal, identifier(cid, 'companyId'), identifier(bid, 'branchId'), branchInput(request.body, true));
  }
}
@Module({ imports: [AuthModule], controllers: [CompaniesController], providers: [CompaniesRuntime] })
export class CompaniesModule {}
