import type { PoolClient } from 'pg';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ProgrammeContentRepository } from './programme-content.repository.js';
import type { ProgrammeReadRepository } from './programme-read.repository.js';
import { ProgrammeContentService } from './programme-content.service.js';

describe('Programme content save validation compatibility', () => {
  const authorization = `Bearer ${signAccessToken('admin-1', ['programme.admin'])}`;

  function fixture(previous: Record<string, unknown>) {
    const client = {} as PoolClient;
    const lockRecord = vi.fn();
    const find = vi.fn().mockResolvedValue(previous);
    const mutate = vi.fn(
      async <T>(
        _key: string | undefined,
        operation: (transaction: PoolClient) => Promise<T>,
      ) => operation(client),
    );
    const contents = {
      lockRecord,
      find,
      mutate,
    } as unknown as ProgrammeContentRepository;
    const service = new ProgrammeContentService(
      contents,
      {} as ProgrammeReadRepository,
    );
    return { service, lockRecord, find, mutate };
  }

  it('checks programme ownership before required fields', async () => {
    const fixtureState = fixture({
      id: 'content-other-programme',
      programmeSlug: 'coastal',
      status: 'PUBLISHED',
    });

    await expect(
      fixtureState.service.save(authorization, 'alpine', {
        contentId: 'content-other-programme',
      } as never),
    ).rejects.toThrow('content does not belong to programme');
    expect(fixtureState.lockRecord).toHaveBeenCalledWith(
      expect.anything(),
      'content-other-programme',
    );
    expect(fixtureState.find).toHaveBeenCalledWith(
      expect.anything(),
      'content-other-programme',
    );
  });

  it('checks required fields before the existing content status', async () => {
    const fixtureState = fixture({
      id: 'content-published',
      programmeSlug: 'alpine',
      status: 'PUBLISHED',
    });

    await expect(
      fixtureState.service.save(authorization, 'alpine', {
        contentId: 'content-published',
      } as never),
    ).rejects.toThrow('key, locale, and value are required');
    expect(fixtureState.find).toHaveBeenCalledOnce();
  });
});
