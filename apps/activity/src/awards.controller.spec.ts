import type { Response } from 'express';
import type { AwardsService } from './awards.service.js';
import { AwardsController } from './awards.controller.js';

describe('AwardsController award creation', () => {
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
