import type { PoolClient } from 'pg';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ProgrammeEntityTypeRepository } from './programme-entity-type.repository.js';
import type { ProgrammeMutationRepository } from './programme-mutation.repository.js';
import type { ProgrammeRepository } from './programme.repository.js';
import type { UpdateProgrammeDto } from './programmes.dto.js';
import { ProgrammesService } from './programmes.service.js';

describe('ProgrammesService compatibility', () => {
  it('rejects an invalid programme status before authentication or repository access', async () => {
    const mutate = vi.fn();
    const service = new ProgrammesService(
      { mutate } as unknown as ProgrammeMutationRepository,
      {} as ProgrammeRepository,
      {} as ProgrammeEntityTypeRepository,
    );

    await expect(
      service.update(undefined, 'alpine', {
        status: 'SUSPENDED',
      } as unknown as UpdateProgrammeDto),
    ).rejects.toThrow('status must be ACTIVE or ARCHIVED');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('archives a programme while ignoring other update fields', async () => {
    const programme = {
      id: 'programme-1',
      slug: 'alpine',
      name: 'Alpine Radio',
      description: 'Existing description',
      rules: { minimumQsos: 2 },
      policyVersion: 3,
      status: 'ACTIVE',
      updatedAt: '2026-01-01T00:00:00.000000Z',
    };
    const events: Array<Record<string, unknown>> = [];
    const saved: Array<Record<string, unknown>> = [];
    const client = {
      query: async () => ({
        rows: [{ timestamp: '2026-01-02T00:00:00.000000Z' }],
        rowCount: 1,
      }),
    } as unknown as PoolClient;
    const mutations = {
      mutate: async <T>(
        _key: string | undefined,
        operation: (transaction: PoolClient) => Promise<T>,
      ) => operation(client),
      recordEvent: async (
        _transaction: PoolClient,
        eventType: string,
        aggregateType: string,
        aggregateId: string,
        payload: Record<string, unknown>,
      ) => {
        events.push({ eventType, aggregateType, aggregateId, payload });
      },
    } as unknown as ProgrammeMutationRepository;
    const programmes = {
      getInTransaction: async () => structuredClone(programme),
      save: async (
        _transaction: PoolClient,
        value: Record<string, unknown>,
      ) => {
        saved.push(structuredClone(value));
      },
    } as unknown as ProgrammeRepository;
    const service = new ProgrammesService(
      mutations,
      programmes,
      {} as ProgrammeEntityTypeRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['programme.admin'])}`;

    const result = await service.update(authorization, 'alpine', {
      status: 'ARCHIVED',
      name: 'Ignored replacement name',
      rules: { minimumQsos: 99 },
    });

    expect(result).toMatchObject({
      slug: 'alpine',
      name: 'Alpine Radio',
      description: 'Existing description',
      rules: { minimumQsos: 2 },
      policyVersion: 3,
      status: 'ARCHIVED',
    });
    expect(saved).toHaveLength(1);
    expect(events).toEqual([
      {
        eventType: 'programme.archived.v1',
        aggregateType: 'programme',
        aggregateId: 'programme-1',
        payload: { slug: 'alpine' },
      },
    ]);
  });
});
