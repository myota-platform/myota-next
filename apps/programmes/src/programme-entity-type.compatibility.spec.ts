import type { PoolClient } from 'pg';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ProgrammeEntityTypeRepository } from './programme-entity-type.repository.js';
import type { ProgrammeMutationRepository } from './programme-mutation.repository.js';
import type { ProgrammeRepository } from './programme.repository.js';
import { ProgrammesService } from './programmes.service.js';

describe('Programme entity-type compatibility', () => {
  it('shares catalogue categories without sharing programme assignments', async () => {
    const programmes = new Map<string, Record<string, unknown>>([
      [
        'alpine',
        {
          id: 'programme-alpine',
          slug: 'alpine',
          name: 'Alpine Radio',
          policyVersion: 1,
          entityTypeCodes: [],
          entityTypes: [],
        },
      ],
      [
        'coastal',
        {
          id: 'programme-coastal',
          slug: 'coastal',
          name: 'Coastal Radio',
          policyVersion: 1,
          entityTypeCodes: [],
          entityTypes: [],
        },
      ],
    ]);
    const catalogue = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];
    const recordEvent = vi.fn(
      async (
        _transaction: PoolClient,
        eventType: string,
        aggregateType: string,
        aggregateId: string,
        payload: Record<string, unknown>,
      ) => events.push({ eventType, aggregateType, aggregateId, payload }),
    );
    let timestamp = 0;
    const client = {
      query: async () => ({
        rows: [{ timestamp: `2026-01-01T00:00:0${timestamp++}.000000Z` }],
        rowCount: 1,
      }),
    } as unknown as PoolClient;
    const mutations = {
      mutate: async <T>(
        _key: string | undefined,
        operation: (transaction: PoolClient) => Promise<T>,
      ) => operation(client),
      recordEvent,
    } as unknown as ProgrammeMutationRepository;
    const programmeRepository = {
      listAll: async () =>
        [...programmes.values()].map((row) => structuredClone(row)),
      getInTransaction: async (_transaction: PoolClient, slug: string) => {
        const programme = programmes.get(slug);
        return programme ? structuredClone(programme) : null;
      },
      save: async (
        _transaction: PoolClient,
        programme: Record<string, unknown>,
      ) => {
        programmes.set(String(programme.slug), structuredClone(programme));
      },
    } as unknown as ProgrammeRepository;
    const entityTypeRepository = {
      listAll: async () =>
        Object.fromEntries(
          [...catalogue].map(([code, row]) => [code, structuredClone(row)]),
        ),
      save: async (
        _transaction: PoolClient,
        entityType: Record<string, unknown> & { code: string },
      ) => {
        catalogue.set(entityType.code, structuredClone(entityType));
      },
    } as unknown as ProgrammeEntityTypeRepository;
    const service = new ProgrammesService(
      mutations,
      programmeRepository,
      entityTypeRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['programme.admin'])}`;

    const saved = await service.saveEntityTypeCatalog(authorization, {
      code: 'OUTDOOR_SITE',
      label: 'Outdoor site',
      geometryTypes: [
        'Point',
        'LineString',
        'MultiLineString',
        'Polygon',
        'MultiPolygon',
      ],
    });
    expect(saved.entityType).toMatchObject({
      code: 'OUTDOOR_SITE',
      geometry: 'POINT',
      geometryTypes: [
        'POINT',
        'LINESTRING',
        'MULTILINESTRING',
        'POLYGON',
        'MULTIPOLYGON',
      ],
    });

    await service.assignEntityType(authorization, 'alpine', 'OUTDOOR_SITE');
    await service.assignEntityType(authorization, 'coastal', 'OUTDOOR_SITE');
    await service.unassignEntityType(authorization, 'alpine', 'OUTDOOR_SITE');

    const alpine = programmes.get('alpine')!;
    const coastal = programmes.get('coastal')!;
    expect(alpine.entityTypeCodes).toEqual([]);
    expect(coastal.entityTypeCodes).toEqual(['OUTDOOR_SITE']);
    expect(coastal.entityTypes).toEqual([catalogue.get('OUTDOOR_SITE')]);
    expect(events.map((event) => event.eventType)).toEqual([
      'programme.entity-type.catalog-saved.v1',
      'programme.entity-type.assigned.v1',
      'programme.entity-type.assigned.v1',
      'programme.entity-type.unassigned.v1',
    ]);
  });

  it('rejects renaming an existing category code', async () => {
    const client = {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as PoolClient;
    const recordEvent = vi.fn();
    const mutations = {
      mutate: async <T>(
        _key: string | undefined,
        operation: (transaction: PoolClient) => Promise<T>,
      ) => operation(client),
      recordEvent,
    } as unknown as ProgrammeMutationRepository;
    const saveEntityType = vi.fn();
    const entityTypes = {
      listAll: async () => ({
        OUTDOOR_SITE: {
          code: 'OUTDOOR_SITE',
          label: 'Outdoor site',
          geometry: 'POINT',
          geometryTypes: ['POINT'],
          active: true,
        },
      }),
      save: saveEntityType,
    } as unknown as ProgrammeEntityTypeRepository;
    const service = new ProgrammesService(
      mutations,
      {
        listAll: async () => [],
        save: vi.fn(),
      } as unknown as ProgrammeRepository,
      entityTypes,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['programme.admin'])}`;

    await expect(
      service.saveEntityTypeCatalog(authorization, {
        code: 'CITY_PARK',
        originalCode: 'OUTDOOR_SITE',
        label: 'City park',
        geometry: 'POLYGON',
      }),
    ).rejects.toThrow(
      'category codes are stable identifiers and cannot be renamed',
    );
    expect(saveEntityType).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
