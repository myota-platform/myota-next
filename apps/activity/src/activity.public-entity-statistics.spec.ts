import { BadRequestException } from '@nestjs/common';
import type { ActivityRepository } from './activity.repository.js';
import { ActivityService } from './activity.service.js';

describe('ActivityService.publicEntityStatistics', () => {
  it('requires a programme and at least one entity ID', async () => {
    const service = new ActivityService({} as ActivityRepository);

    await expect(
      service.publicEntityStatistics(undefined, ['entity-1']),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.publicEntityStatistics('worldwide', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deduplicates and bounds the public entity ID query', async () => {
    const entityStatistics = vi.fn().mockResolvedValue([]);
    const service = new ActivityService({
      entityStatistics,
    } as unknown as ActivityRepository);

    await expect(
      service.publicEntityStatistics(' worldwide ', [
        'entity-1,entity-2',
        'entity-2',
      ]),
    ).resolves.toEqual({ programme: 'worldwide', items: [] });
    expect(entityStatistics).toHaveBeenCalledWith('worldwide', [
      'entity-1',
      'entity-2',
    ]);
    await expect(
      service.publicEntityStatistics(
        'worldwide',
        Array.from({ length: 101 }, (_, index) => `entity-${index}`),
      ),
    ).rejects.toThrow('at most 100 entityIds may be requested');
  });
});
