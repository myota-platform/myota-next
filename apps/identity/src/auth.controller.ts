import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Get,
  Header,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Patch,
  Query,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  MYOTA_CLIENT_ADDRESS_HEADER,
  MYOTA_CLIENT_ADDRESS_SIGNATURE_HEADER,
  verifyClientAddress,
} from '@app/platform';
import {
  LoginDto,
  AddCallsignDto,
  CallsignEvidenceDto,
  RetireCallsignDto,
  SetPrimaryCallsignDto,
  VerifyCallsignDto,
  AdminAccountsQueryDto,
  AdminRoleDefinitionDto,
  RecoveryRequestDto,
  RecoveryResetDto,
  RefreshTokenDto,
  SecurityEventsQueryDto,
  OidcProviderMappingDto,
} from './auth.dto.js';
import { IdentityAuthService } from './auth.service.js';
import { IdentityRoleService } from './identity-role.service.js';
import { IdentityAccountService } from './identity-account.service.js';
import { IdentityCallsignService } from './identity-callsign.service.js';
import { IdentityIntegrationService } from './identity-integration.service.js';
import { IdentityCredentialService } from './identity-credential.service.js';
import { IdentityProfileImageService } from './identity-profile-image.service.js';

@Controller('identity')
export class AuthController {
  constructor(
    private readonly auth: IdentityAuthService,
    private readonly roles: IdentityRoleService,
    private readonly accounts: IdentityAccountService,
    private readonly callsigns: IdentityCallsignService,
    private readonly integrations: IdentityIntegrationService,
    private readonly credentials: IdentityCredentialService,
    private readonly profileImages: IdentityProfileImageService,
  ) {}

  @Post('auth/register')
  register(): never {
    throw new ForbiddenException(
      'public participant registration is unavailable until email verification and abuse controls are deployed',
    );
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

  @Post('oidc/providers')
  @HttpCode(201)
  saveOidcMapping(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: OidcProviderMappingDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.integrations.saveOidcMapping(authorization, body);
  }

  @Post('auth/service-token')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  issueServiceToken(
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authorization?: string,
  ) {
    return this.credentials.issueServiceToken(body, authorization);
  }

  @Get('internal/email-recipients/:accountId')
  @Header('Cache-Control', 'private, no-store')
  resolveEmailRecipient(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.credentials.resolveEmailRecipient(authorization, accountId);
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
    @Body() body: Record<string, any>,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.auth.updateOwnProfile(authorization, body);
  }

  @Get('me/profile-image')
  @Header('Content-Type', 'image/webp')
  @Header('Cache-Control', 'private, no-store')
  getOwnProfileImage(
    @Headers('authorization') authorization: string | undefined,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.profileImages.getOwnProfileImage(authorization);
  }

  @Put('me/profile-image')
  @Header('Cache-Control', 'private, no-store')
  uploadOwnProfileImage(
    @Headers('authorization') authorization: string | undefined,
    @Headers('content-type') contentType: string | undefined,
    @Req() request: Request,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.profileImages.uploadOwnProfileImage(
      authorization,
      contentType,
      request,
    );
  }

  @Delete('me/profile-image')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  deleteOwnProfileImage(
    @Headers('authorization') authorization: string | undefined,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.profileImages.deleteOwnProfileImage(authorization);
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

  @Get('admin/security-events')
  listSecurityEvents(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: SecurityEventsQueryDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.listSecurityEvents(authorization, query);
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
    @Body() body: Record<string, unknown>,
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

  @Get('accounts/:accountId/export')
  exportAccount(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.exportAccount(authorization, accountId);
  }

  @Get('accounts/:accountId/profile-image')
  @Header('Content-Type', 'image/webp')
  @Header('Cache-Control', 'private, no-store')
  getAccountProfileImage(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.profileImages.getAccountProfileImage(authorization, accountId);
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

  @Patch('accounts/:accountId')
  updateAccount(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.updateAccount(authorization, accountId, body);
  }

  @Put('accounts/:accountId/role-assignments')
  replaceAccountRoleAssignments(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.updateAccount(authorization, accountId, body);
  }

  @Post('accounts/:accountId/callsigns')
  @HttpCode(201)
  addCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Body() body: AddCallsignDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.callsigns.addCallsign(
      authorization,
      accountId,
      body,
      idempotencyKey,
    );
  }

  @Post('accounts/:accountId/callsigns/:callsignId/evidence')
  @HttpCode(201)
  submitCallsignEvidence(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Param('callsignId', new ParseUUIDPipe()) callsignId: string,
    @Body() body: CallsignEvidenceDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.callsigns.submitCallsignEvidence(
      authorization,
      accountId,
      callsignId,
      body,
    );
  }

  @Post('accounts/:accountId/callsigns/:callsignId/verify')
  @HttpCode(200)
  verifyCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Param('callsignId', new ParseUUIDPipe()) callsignId: string,
    @Body() body: VerifyCallsignDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.callsigns.verifyCallsign(
      authorization,
      accountId,
      callsignId,
      body,
    );
  }

  @Put('accounts/:accountId/primary-callsign')
  setPrimaryCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Body() body: SetPrimaryCallsignDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.callsigns.setPrimaryCallsign(
      authorization,
      accountId,
      body,
      idempotencyKey,
    );
  }

  @Post('accounts/:accountId/callsigns/:callsignId/retire')
  @HttpCode(200)
  retireCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Param('callsignId', new ParseUUIDPipe()) callsignId: string,
    @Body() body: RetireCallsignDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.callsigns.retireCallsign(
      authorization,
      accountId,
      callsignId,
      body,
    );
  }

  private requestContext(request: Request) {
    const clientAddress = request.get(MYOTA_CLIENT_ADDRESS_HEADER);
    const clientAddressSignature = request.get(
      MYOTA_CLIENT_ADDRESS_SIGNATURE_HEADER,
    );
    const trustedClientAddress =
      clientAddress &&
      clientAddressSignature &&
      verifyClientAddress(
        clientAddress,
        clientAddressSignature,
        process.env.MYOTA_AUTH_SIGNING_KEY ?? '',
      )
        ? clientAddress
        : null;
    return {
      userAgent: request.get('user-agent') ?? null,
      remoteAddr:
        trustedClientAddress ??
        request.socket.remoteAddress ??
        request.ip ??
        null,
    };
  }
}
