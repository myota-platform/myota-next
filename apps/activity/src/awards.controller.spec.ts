import type { Response } from 'express';
import type { AwardsService } from './awards.service.js';
import { AwardsController } from './awards.controller.js';

describe('AwardsController award creation', () => {
  it('passes the deletion idempotency key to the authorized service action', async () => {
    const job = { id: 'delete-job-1', status: 'QUEUED' };
    const requestAwardDeletion = vi.fn().mockResolvedValue(job);
    const controller = new AwardsController({
      requestAwardDeletion,
    } as unknown as AwardsService);

    await expect(
      controller.createDeletion(
        'Bearer global-admin-token',
        'delete-award-key',
        'award-1',
      ),
    ).resolves.toBe(job);
    expect(requestAwardDeletion).toHaveBeenCalledWith(
      'Bearer global-admin-token',
      'delete-award-key',
      'award-1',
    );
  });

  it('authorizes deletion job status reads through the service', async () => {
    const getAwardDeletionJob = vi.fn().mockResolvedValue({
      id: 'delete-job-1',
      status: 'SUCCEEDED',
    });
    const controller = new AwardsController({
      getAwardDeletionJob,
    } as unknown as AwardsService);

    await expect(
      controller.getDeletion('Bearer global-admin-token', 'delete-job-1'),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(getAwardDeletionJob).toHaveBeenCalledWith(
      'Bearer global-admin-token',
      'delete-job-1',
    );
  });

  it('forwards the idempotency key to the award save operation', async () => {
    const award = { id: 'award-1', status: 'DRAFT' };
    const save = vi.fn().mockResolvedValue({ award, statusCode: 201 });
    const setStatus = vi.fn();
    const controller = new AwardsController({
      save,
    } as unknown as AwardsService);
    const response = { status: setStatus } as unknown as Response;
    const authorization = 'Bearer activity-admin-token';
    const key = 'award-create-retry-key';
    const body = { code: 'ALPINE-10', name: 'Alpine Ten' };

    const result = await controller.create(authorization, key, body, response);

    expect(save).toHaveBeenCalledWith(authorization, key, body);
    expect(setStatus).toHaveBeenCalledWith(201);
    expect(result).toBe(award);
  });
});
