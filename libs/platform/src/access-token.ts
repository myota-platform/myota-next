import { createHmac, timingSafeEqual } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  jti: string;
  scp: string[];
  exp: number;
  tokenType: 'access';
}

export function verifyAccessToken(authorization?: string): AccessTokenClaims {
  if (!authorization?.startsWith('Bearer ')) {
    throw new UnauthorizedException('Bearer authentication is required');
  }
  const token = authorization.slice(7);
  try {
    const [headerPart, claimsPart, signaturePart, ...extra] = token.split('.');
    if (!headerPart || !claimsPart || !signaturePart || extra.length) {
      throw new Error('malformed token');
    }
    const header = JSON.parse(
      Buffer.from(headerPart, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const claims = JSON.parse(
      Buffer.from(claimsPart, 'base64url').toString('utf8'),
    ) as Partial<AccessTokenClaims>;
    const expected = createHmac('sha256', authSigningKey())
      .update(`${headerPart}.${claimsPart}`)
      .digest();
    const received = Buffer.from(signaturePart, 'base64url');
    if (
      header.alg !== 'HS256' ||
      header.tokenType !== 'access' ||
      claims.tokenType !== 'access' ||
      !claims.sub ||
      !claims.sid ||
      !claims.jti ||
      !Array.isArray(claims.scp) ||
      !Number.isSafeInteger(claims.exp) ||
      (claims.exp ?? 0) <= Math.floor(Date.now() / 1000) ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new Error('invalid token claims');
    }
    return claims as AccessTokenClaims;
  } catch {
    throw new UnauthorizedException('invalid or expired token');
  }
}

function authSigningKey(): string {
  const key =
    process.env.MYOTA_AUTH_SIGNING_KEY ?? 'myota-development-key-change-me';
  if (
    process.env.MYOTA_ENV?.toLowerCase() === 'production' &&
    key === 'myota-development-key-change-me'
  ) {
    throw new Error('MYOTA_AUTH_SIGNING_KEY must be set outside development');
  }
  return key;
}
