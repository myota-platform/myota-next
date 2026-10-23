import { S3Client } from '@aws-sdk/client-s3';
import { vi } from 'vitest';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import { ActivityService } from './activity.service.js';
import type { ActivityRepository } from './activity.repository.js';

describe('Activity ADIF upload failure handling', () => {
  const originalEnvironment = {
    myotaEnv: process.env.MYOTA_ENV,
    signingKey: process.env.MYOTA_AUTH_SIGNING_KEY,
    clamavUrl: process.env.MYOTA_CLAMAV_URL,
  };

  beforeEach(() => {
    process.env.MYOTA_ENV = 'test';
    process.env.MYOTA_AUTH_SIGNING_KEY = 'activity-adif-upload-test-key';
    delete process.env.MYOTA_CLAMAV_URL;
  });

  afterEach(() => {
    if (originalEnvironment.myotaEnv === undefined)
      delete process.env.MYOTA_ENV;
    else process.env.MYOTA_ENV = originalEnvironment.myotaEnv;
    if (originalEnvironment.signingKey === undefined)
      delete process.env.MYOTA_AUTH_SIGNING_KEY;
    else process.env.MYOTA_AUTH_SIGNING_KEY = originalEnvironment.signingKey;
    if (originalEnvironment.clamavUrl === undefined)
      delete process.env.MYOTA_CLAMAV_URL;
    else process.env.MYOTA_CLAMAV_URL = originalEnvironment.clamavUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function harness() {
    const createAdifImport = vi.fn();
    const repository = {
      get: vi.fn().mockResolvedValue({ operatorId: 'operator-1' }),
      createAdifImport,
    } as unknown as ActivityRepository;
    const service = new ActivityService(repository);
    const authorization = `Bearer ${signAccessToken('operator-1', [])}`;
    return { createAdifImport, service, authorization };
  }

  it('rejects the EICAR test signature before storage or job creation', async () => {
    const { createAdifImport, service, authorization } = harness();
    const send = vi.spyOn(S3Client.prototype, 'send');
    const content = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );

    await expect(
      service.createAdifImport(authorization, {
        activationId: 'activation-1',
        filename: 'infected.adi',
        contentBase64: content.toString('base64'),
      }),
    ).rejects.toThrow('malware scan rejected the upload');

    expect(send).not.toHaveBeenCalled();
    expect(createAdifImport).not.toHaveBeenCalled();
  });

  it('fails closed when the configured malware scanner is unavailable', async () => {
    const { createAdifImport, service, authorization } = harness();
    process.env.MYOTA_CLAMAV_URL = 'http://clamav.invalid/scan';
    const fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetch);
    const send = vi.spyOn(S3Client.prototype, 'send');

    await expect(
      service.createAdifImport(authorization, {
        activationId: 'activation-1',
        filename: 'clean.adi',
        contentBase64: Buffer.from('<ADIF_VER:5>3.1.4').toString('base64'),
      }),
    ).rejects.toThrow('malware scanner is unavailable; upload was not stored');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(createAdifImport).not.toHaveBeenCalled();
  });

  it('authorizes the activation owner before validating the base64 type', async () => {
    const { createAdifImport, service } = harness();
    const otherUserAuthorization = `Bearer ${signAccessToken('other-user', [])}`;

    await expect(
      service.createAdifImport(otherUserAuthorization, {
        activationId: 'activation-1',
        filename: 'invalid.adi',
        contentBase64: 123,
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: {
        message: 'the activity owner or activity.admin scope is required',
      },
    });

    expect(createAdifImport).not.toHaveBeenCalled();
  });
});
