import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ActivityRepository } from './activity.repository.js';
import { ActivityService } from './activity.service.js';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';

describe('Activity activation authorization compatibility', () => {
  const body = {
    programmeSlug: 'sevilla-demo',
    entityId: 'park-1',
    operatorId: 'operator-1',
    startedAt: '2026-01-01T10:00:00Z',
  };

  function fixture() {
    const create = vi.fn().mockResolvedValue({ id: 'activation-1' });
    const get = vi.fn().mockResolvedValue({
      id: 'activation-1',
      operatorId: 'operator-1',
      status: 'OPEN',
    });
    const addQso = vi.fn().mockResolvedValue({
      activationId: 'activation-1',
      qso: { id: 'qso-1' },
      qsoCount: 1,
      duplicate: false,
    });
    const service = new ActivityService({
      create,
      get,
      addQso,
    } as unknown as ActivityRepository);
    return { service, create, get, addQso };
  }

  it('requires bearer authentication before creating a valid activation', async () => {
    const { service, create } = fixture();

    await expect(service.create(undefined, undefined, body)).rejects.toThrow(
      new UnauthorizedException('Bearer authentication is required'),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a participant creating an activation for another operator', async () => {
    const { service, create } = fixture();
    const authorization = `Bearer ${signAccessToken('other-user', [])}`;

    await expect(
      service.create(authorization, undefined, body),
    ).rejects.toThrow(
      new ForbiddenException(
        'activation operator does not match the authenticated account',
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('allows the activation owner to create an activation', async () => {
    const { service, create } = fixture();
    const authorization = `Bearer ${signAccessToken('operator-1', [])}`;

    await expect(
      service.create(authorization, undefined, body),
    ).resolves.toEqual({ id: 'activation-1' });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining(body),
      undefined,
    );
  });

  it('rejects a non-owner QSO write before repository mutation', async () => {
    const { service, get, addQso } = fixture();
    const authorization = `Bearer ${signAccessToken('other-user', [])}`;

    await expect(
      service.addQso(authorization, 'qso-key', 'activation-1', {
        workedCallsign: 'K1ABC',
        timestamp: '2026-01-01T12:00:00Z',
      }),
    ).rejects.toThrow(
      new ForbiddenException(
        'the activity owner or activity.admin scope is required',
      ),
    );
    expect(get).toHaveBeenCalledWith('activation-1');
    expect(addQso).not.toHaveBeenCalled();
  });

  it('checks required QSO fields before activation lookup or authentication', async () => {
    const { service, get, addQso } = fixture();

    await expect(
      service.addQso(undefined, undefined, 'activation-1', {}),
    ).rejects.toThrow(
      new BadRequestException(
        'missing required fields: workedCallsign, timestamp',
      ),
    );
    expect(get).not.toHaveBeenCalled();
    expect(addQso).not.toHaveBeenCalled();
  });

  it('allows an Activity administrator to write a QSO for another operator', async () => {
    const { service, get, addQso } = fixture();
    const authorization = `Bearer ${signAccessToken('admin-1', ['activity.admin'])}`;

    await expect(
      service.addQso(authorization, 'qso-key', 'activation-1', {
        workedCallsign: ' k1abc ',
        timestamp: '2026-01-01T12:00:00Z',
      }),
    ).resolves.toMatchObject({ duplicate: false });
    expect(get).toHaveBeenCalledWith('activation-1');
    expect(addQso).toHaveBeenCalledWith(
      'activation-1',
      expect.objectContaining({
        activationId: 'activation-1',
        workedCallsign: 'K1ABC',
      }),
      'qso-key',
    );
  });
});
