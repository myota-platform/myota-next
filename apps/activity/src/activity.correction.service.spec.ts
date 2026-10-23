import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ActivityRepository } from './activity.repository.js';
import { ActivityService } from './activity.service.js';

describe('ActivityService QSO correction authorization', () => {
  function harness() {
    const createCorrection = vi.fn(
      async (_qsoId: string, body: Record<string, unknown>) => ({
        id: 'correction-1',
        ...body,
      }),
    );
    const repository = { createCorrection } as unknown as ActivityRepository;
    return { service: new ActivityService(repository), createCorrection };
  }

  const body = {
    requestedBy: 'participant-1',
    reason: 'Correct worked callsign',
    proposedValues: { workedCallsign: 'F4XYZ' },
  };

  it('allows the requesting account and passes the requested QSO through', async () => {
    const fixture = harness();
    const authorization = `Bearer ${signAccessToken('participant-1', ['identity.me'])}`;

    await expect(
      fixture.service.requestCorrection(authorization, 'qso-1', body),
    ).resolves.toMatchObject({ id: 'correction-1', reason: body.reason });
    expect(fixture.createCorrection).toHaveBeenCalledWith('qso-1', body);
  });

  it('allows an activity administrator to request for another account', async () => {
    const fixture = harness();
    const authorization = `Bearer ${signAccessToken('admin-1', ['activity.admin'])}`;

    await fixture.service.requestCorrection(authorization, 'qso-1', body);

    expect(fixture.createCorrection).toHaveBeenCalledWith('qso-1', body);
  });

  it('rejects another participant before creating a correction', async () => {
    const fixture = harness();
    const authorization = `Bearer ${signAccessToken('participant-2', ['identity.me'])}`;

    await expect(
      fixture.service.requestCorrection(authorization, 'qso-1', body),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.createCorrection).not.toHaveBeenCalled();
  });

  it('validates required correction fields before authentication', async () => {
    const fixture = harness();

    await expect(
      fixture.service.requestCorrection(undefined, 'qso-1', {
        requestedBy: 'participant-1',
        reason: 'Missing proposed values',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.createCorrection).not.toHaveBeenCalled();
  });
});
