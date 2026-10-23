import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { verifyAccessToken } from '@app/platform/access-token.js';
import { normalizePythonNumericText } from '@app/platform/python-numeric.js';
import { fingerprintJsonRequest } from './geodata-request-fingerprint.js';

export function parseImportPartNumber(value: string): number {
  const normalized = normalizePythonNumericText(value);
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized))
    throw new BadRequestException('partNumber must be between 1 and 10000');
  const parsed = BigInt(normalized.replaceAll('_', ''));
  if (parsed < 1n || parsed > 10000n)
    throw new BadRequestException('partNumber must be between 1 and 10000');
  return Number(parsed);
}

export function scopedRequestIdempotency(
  key: string | undefined,
  owner: string,
  request: Request,
  body: Record<string, unknown>,
) {
  if (!key) return { key: undefined, requestHash: undefined };
  const rawBody = (request as Request & { rawBody?: Buffer }).rawBody?.toString(
    'utf8',
  );
  return {
    key: `http:${owner}:${request.originalUrl}:${key}`,
    requestHash: fingerprintJsonRequest(body, rawBody),
  };
}

export function authorizeBearer(authorization: string | undefined) {
  verifyAccessToken(authorization);
}

export function authorizeImport(authorization: string | undefined) {
  const claims = verifyAccessToken(authorization);
  if (!claims.scp.some((scope) => scope === '*' || scope === 'geodata.import'))
    throw new ForbiddenException('geodata.import scope is required');
  return claims;
}
