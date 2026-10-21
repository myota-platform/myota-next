import { UnauthorizedException } from '@nestjs/common';
import { IdentityAuthService } from './auth.service.js';

describe('Identity service token compatibility', () => {
  const service = new IdentityAuthService(null);
  let originalSigningKey: string | undefined;

  beforeEach(() => {
    originalSigningKey = process.env.MYOTA_AUTH_SIGNING_KEY;
    process.env.MYOTA_AUTH_SIGNING_KEY = 'test-auth-key';
  });

  afterEach(() => {
    if (originalSigningKey === undefined)
      delete process.env.MYOTA_AUTH_SIGNING_KEY;
    else process.env.MYOTA_AUTH_SIGNING_KEY = originalSigningKey;
  });

  it('matches the pinned Python HS256 service-token fixture', () => {
    const claims = {
      sub: 'service:test',
      jti: 'fixture-jti',
      scp: ['identity.email.resolve'],
      iat: 1_700_000_000,
      exp: 1_900_000_000,
      aud: 'myota-identity',
    };
    const token = service.signServiceToken(claims);

    expect(token).toBe(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCIsInRva2VuVHlwZSI6InNlcnZpY2UifQ.eyJzdWIiOiJzZXJ2aWNlOnRlc3QiLCJqdGkiOiJmaXh0dXJlLWp0aSIsInNjcCI6WyJpZGVudGl0eS5lbWFpbC5yZXNvbHZlIl0sImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxOTAwMDAwMDAwLCJhdWQiOiJteW90YS1pZGVudGl0eSIsInRva2VuVHlwZSI6InNlcnZpY2UifQ.GfrJjbCeVPRdRopCqNsPbQhUrOe4SuBTDVLojXfyjOE',
    );
    expect(service.verifyServiceToken(`Bearer ${token}`)).toEqual({
      ...claims,
      tokenType: 'service',
    });
  });

  it('requires Bearer authentication and rejects tampered tokens', () => {
    expect(() => service.verifyServiceToken('Basic token')).toThrow(
      'Bearer authentication is required',
    );
    expect(() =>
      service.verifyServiceToken('Bearer invalid.token.value'),
    ).toThrow(UnauthorizedException);
  });

  it('rejects expired signed service tokens', () => {
    const token = service.signServiceToken({
      sub: 'service:test',
      jti: 'expired-fixture',
      scp: ['identity.email.resolve'],
      iat: 1_700_000_000,
      exp: 1,
    });

    expect(() => service.verifyServiceToken(`Bearer ${token}`)).toThrow(
      'invalid or expired token',
    );
  });
});
