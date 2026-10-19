import {
  Body,
  Controller,
  Get,
  ForbiddenException,
  Headers,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { LoginDto, RefreshTokenDto } from './auth.dto.js';
import { IdentityAuthService } from './auth.service.js';

@Controller('identity')
export class AuthController {
  constructor(private readonly auth: IdentityAuthService) {}

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

  private requestContext(request: Request) {
    return {
      userAgent: request.get('user-agent') ?? null,
      remoteAddr: request.ip ?? null,
    };
  }
}
