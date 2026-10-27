import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
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

  it('allows a participant to read their own activation and QSOs', async () => {
    const { service, get } = fixture();
    const authorization = `Bearer ${signAccessToken('operator-1', ['identity.me'])}`;

    await expect(
      service.get(authorization, 'activation-1'),
    ).resolves.toMatchObject({
      id: 'activation-1',
      operatorId: 'operator-1',
    });
    expect(get).toHaveBeenCalledWith('activation-1');
  });

  it('hides another participant activation behind the same not-found response', async () => {
    const { service, get } = fixture();
    const authorization = `Bearer ${signAccessToken('other-user', ['identity.me'])}`;

    await expect(service.get(authorization, 'activation-1')).rejects.toThrow(
      new NotFoundException('Activation not found'),
    );
    expect(get).toHaveBeenCalledWith('activation-1');

    get.mockRejectedValueOnce(
      new NotFoundException('internal missing ID detail'),
    );
    await expect(
      service.get(authorization, 'missing-activation'),
    ).rejects.toThrow(new NotFoundException('Activation not found'));
  });

  it('keeps activation detail reads restricted to Activity scopes for other callers', async () => {
    const { service, get } = fixture();
    const authorization = `Bearer ${signAccessToken('user-without-activity-scope', [])}`;

    await expect(service.get(authorization, 'activation-1')).rejects.toThrow(
      new ForbiddenException('required activity scope is missing'),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('preserves Activity administrator access to other activation details', async () => {
    const { service, get } = fixture();
    const authorization = `Bearer ${signAccessToken('admin-1', ['activity.read'])}`;

    await expect(
      service.get(authorization, 'activation-1'),
    ).resolves.toMatchObject({
      operatorId: 'operator-1',
    });
    expect(get).toHaveBeenCalledWith('activation-1');
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
