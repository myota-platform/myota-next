import { readFileSync } from 'node:fs';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ActivityRepository } from './activity.repository.js';
import type { ActivityAwardsRepository } from './activity-awards.repository.js';
import { AwardsService } from './awards.service.js';

function readInvalidFixture(): Record<string, any> {
  return JSON.parse(
    readFileSync(
      new URL(
        '../../../contracts/fixtures/award-definition-invalid.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
}

describe('AwardsService configuration validation', () => {
  it('rejects invalid create requests before reading or persisting award state', async () => {
    const getAwardDefinition = vi.fn();
    const saveAwardDefinition = vi.fn();
    const awardsRepository = {
      getAwardDefinition,
      saveAwardDefinition,
    } as unknown as ActivityAwardsRepository;
    const service = new AwardsService(
      {} as ActivityRepository,
      awardsRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['awards.admin'])}`;

    await expect(
      service.save(
        authorization,
        'invalid-award-idempotency',
        readInvalidFixture(),
      ),
    ).rejects.toThrow(/condition\.conditions\[0\]\.value.*finite number/);
    expect(getAwardDefinition).not.toHaveBeenCalled();
    expect(saveAwardDefinition).not.toHaveBeenCalled();
  });

  it('rejects invalid update fragments before loading the current award', async () => {
    const getAwardDefinition = vi.fn();
    const awardsRepository = {
      getAwardDefinition,
    } as unknown as ActivityAwardsRepository;
    const service = new AwardsService(
      {} as ActivityRepository,
      awardsRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['awards.admin'])}`;

    await expect(
      service.patch(authorization, 'invalid-award-idempotency', 'award-1', {
        printSpec: { dpi: 301 },
      }),
    ).rejects.toThrow(/printSpec\.dpi.*between 150 and 300/);
    expect(getAwardDefinition).not.toHaveBeenCalled();
  });
});
