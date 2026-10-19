import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Get,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Patch,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  LoginDto,
  CreateAccountDto,
  AdminAccountsQueryDto,
  AdminRoleDefinitionDto,
  RecoveryRequestDto,
  RecoveryResetDto,
  RefreshTokenDto,
  ProfileUpdateDto,
} from './auth.dto.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';

@Controller('identity')
export class AuthController {
  constructor(
    private readonly auth: IdentityAuthService,
    private readonly roles: IdentityRoleService,
    private readonly accounts: IdentityAccountService,
  ) {}

  @Post('auth/register')
  register(): never {
    throw new ForbiddenException('Public registration is not available');
  }

  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: LoginDto, @Req() request: Request) {
    return this.auth.login(body, this.requestContext(request));
  }

  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshTokenDto, @Req() request: Request) {
    return this.auth.refresh(body.refreshToken, this.requestContext(request));
  }

  @Post('auth/recovery/request')
  @HttpCode(200)
  requestRecovery(@Body() body: RecoveryRequestDto) {
    return this.auth.requestRecovery(body.email);
  }

  @Post('auth/recovery/reset')
  @HttpCode(200)
  resetRecovery(@Body() body: RecoveryResetDto) {
    return this.auth.resetRecovery(body.token, body.newPassword);
  }

  @Post('auth/logout')
  @HttpCode(200)
  logout(
    @Body() body: Partial<RefreshTokenDto>,
    @Headers('authorization') authorization?: string,
  ) {
    return this.auth.logout(body?.refreshToken, authorization);
  }

  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.auth.currentAccount(authorization);
  }

  @Patch('me/profile')
  updateProfile(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: ProfileUpdateDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.auth.updateOwnProfile(authorization, body);
  }

  @Get('admin/accounts')
  listAdminAccounts(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: AdminAccountsQueryDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.auth.listAdminAccounts(authorization, query);
  }

  @Get('admin/roles')
  listAdminRoles(@Headers('authorization') authorization?: string) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.roles.listAdminRoles(authorization);
  }

  @Post('admin/roles')
  @HttpCode(201)
  createAdminRole(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AdminRoleDefinitionDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.roles.createAdminRole(authorization, body);
  }

  @Post('roles')
  @HttpCode(201)
  createRole(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: AdminRoleDefinitionDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.roles.createAdminRole(authorization, body);
  }

  @Patch('roles/:roleCode')
  updateRole(
    @Headers('authorization') authorization: string | undefined,
    @Param('roleCode') roleCode: string,
    @Body() body: AdminRoleDefinitionDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.roles.updateAdminRole(authorization, roleCode, body);
  }

  @Post('accounts')
  @HttpCode(201)
  createAccount(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateAccountDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.create(authorization, body, idempotencyKey);
  }

  @Get('accounts/:accountId')
  getAccount(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.getAccount(authorization, accountId);
  }

  @Get('accounts/:accountId/roles')
  listAccountRoles(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.listAccountRoles(authorization, accountId);
  }

  private requestContext(request: Request) {
    return {
      userAgent: request.get('user-agent') ?? null,
      remoteAddr: request.ip ?? null,
    };
  }
}
