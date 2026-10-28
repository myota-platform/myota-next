import {
  Body,
  Controller,
  Delete,
  Param,
  Get,
  Header,
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
  REQUEST_ID_HEADER,
  safeRequestId,
  verifyClientAddress,
} from '@app/platform';
import {
  LoginDto,
  AddCallsignDto,
  CallsignEvidenceDto,
  SetPrimaryCallsignDto,
  AdminAccountsQueryDto,
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
import { IdentityRegistrationService } from './identity-registration.service.js';
import { IdentityEmailChangeService } from './identity-email-change.service.js';

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
    private readonly registration: IdentityRegistrationService,
    private readonly emailChanges: IdentityEmailChangeService,
  ) {}

  @Post('auth/register')
  @HttpCode(200)
  register(@Body() body: unknown, @Req() request: Request) {
    return this.registration.register(
      body,
      this.requestContext(request).remoteAddr,
    );
  }

  @Post('auth/register/resend')
  @HttpCode(200)
  resendRegistration(@Body() body: unknown, @Req() request: Request) {
    return this.registration.resend(
      body,
      this.requestContext(request).remoteAddr,
    );
  }

  @Post('auth/register/verify')
  @HttpCode(200)
  verifyRegistration(@Body() body: unknown) {
    return this.registration.verify(body);
  }

  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: Record<string, unknown>, @Req() request: Request) {
    return this.auth.login(
      body as unknown as LoginDto,
      this.requestContext(request),
    );
  }

  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body() body: Record<string, unknown>, @Req() request: Request) {
    return this.auth.refresh(
      body.refreshToken as string,
      this.requestContext(request),
    );
  }

  @Post('auth/recovery/request')
  @HttpCode(200)
  requestRecovery(
    @Body() body: Record<string, unknown>,
    @Req() request: Request,
  ) {
    return this.auth.requestRecovery(
      body.email as string,
      this.requestContext(request).remoteAddr,
    );
  }

  @Post('auth/recovery/reset')
  @HttpCode(200)
  resetRecovery(@Body() body: Record<string, unknown>) {
    return this.auth.resetRecovery(
      body.token as string,
      body.newPassword as string,
    );
  }

  @Post('auth/email-change/verify')
  @HttpCode(200)
  confirmEmailChange(@Body() body: unknown) {
    return this.emailChanges.confirm(body);
  }

  @Get('me/email-change')
  getEmailChangeStatus(
    @Headers('authorization') authorization: string | undefined,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.emailChanges.status(authorization);
  }

  @Post('me/email-change')
  @HttpCode(200)
  requestEmailChange(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.emailChanges.request(authorization, body);
  }

  @Delete('me/email-change')
  @HttpCode(200)
  cancelEmailChange(
    @Headers('authorization') authorization: string | undefined,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.emailChanges.cancel(authorization);
  }

  @Post('oidc/providers')
  @HttpCode(201)
  saveOidcMapping(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.integrations.saveOidcMapping(
      authorization ?? '',
      body as unknown as OidcProviderMappingDto,
    );
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
    @Query('templateId') templateId: string | undefined,
    @Query('contextId') contextId: string | undefined,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.credentials.resolveEmailRecipient(
      authorization,
      accountId,
      templateId,
      contextId,
    );
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
    @Headers('content-length') contentLength: string | undefined,
    @Req() request: Request,
  ) {
    return this.profileImages.uploadOwnProfileImage(
      authorization,
      contentType,
      contentLength,
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

  @Get('admin/participants')
  listAdminParticipants(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: AdminAccountsQueryDto,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.listParticipants(authorization, query);
  }

  @Patch('admin/participants/:accountId')
  updateAdminParticipant(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.updateParticipant(authorization, accountId, body);
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
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.roles.createAdminRole(authorization, body);
  }

  @Post('roles')
  @HttpCode(201)
  createRole(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.roles.createAdminRole(authorization, body);
  }

  @Patch('roles/:roleCode')
  updateRole(
    @Headers('authorization') authorization: string | undefined,
    @Param('roleCode') roleCode: string,
    @Body() body: unknown,
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
    @Param('accountId') accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.getAccount(authorization, accountId);
  }

  @Get('accounts/:accountId/export')
  exportAccount(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
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
    @Param('accountId') accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.profileImages.getAccountProfileImage(authorization, accountId);
  }

  @Get('accounts/:accountId/roles')
  listAccountRoles(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.listAccountRoles(authorization, accountId);
  }

  @Patch('accounts/:accountId')
  updateAccount(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.updateAccount(authorization, accountId, body);
  }

  @Put('accounts/:accountId/role-assignments')
  replaceAccountRoleAssignments(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    if (!authorization)
      throw new UnauthorizedException('Bearer authentication is required');
    return this.accounts.updateAccount(authorization, accountId, body, true);
  }

  @Post('accounts/:accountId/callsigns')
  @HttpCode(201)
  addCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('accountId') accountId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.callsigns.addCallsign(
      authorization ?? '',
      accountId,
      body as unknown as AddCallsignDto,
      idempotencyKey,
    );
  }

  @Post('accounts/:accountId/callsigns/:callsignId/evidence')
  @HttpCode(201)
  submitCallsignEvidence(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
    @Param('callsignId') callsignId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.callsigns.submitCallsignEvidence(
      authorization ?? '',
      accountId,
      callsignId,
      body as unknown as CallsignEvidenceDto,
    );
  }

  @Post('accounts/:accountId/callsigns/:callsignId/verify')
  @HttpCode(200)
  verifyCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
    @Param('callsignId') callsignId: string,
    @Body() body: unknown,
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
    @Param('accountId') accountId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.callsigns.setPrimaryCallsign(
      authorization ?? '',
      accountId,
      body as unknown as SetPrimaryCallsignDto,
      idempotencyKey,
    );
  }

  @Post('accounts/:accountId/callsigns/:callsignId/retire')
  @HttpCode(200)
  retireCallsign(
    @Headers('authorization') authorization: string | undefined,
    @Param('accountId') accountId: string,
    @Param('callsignId') callsignId: string,
    @Body() body: unknown,
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
      requestId: safeRequestId(request.get(REQUEST_ID_HEADER)),
      remoteAddr:
        trustedClientAddress ??
        request.socket.remoteAddress ??
        request.ip ??
        null,
    };
  }
}
