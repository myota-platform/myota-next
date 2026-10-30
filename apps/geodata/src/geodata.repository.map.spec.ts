import {
  GeodataRepository,
  mapSimplificationToleranceMeters,
} from './geodata.repository.js';

describe('GeodataRepository programme map reads', () => {
  it('caps admin map entities at 500 and returns the actual viewport count', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total: '734' }] })
        .mockResolvedValueOnce({
          rows: Array.from({ length: 501 }, (_, index) => ({
            entity: { id: `entity-${index + 1}` },
          })),
        }),
      release: vi.fn(),
    };
    const repository = new GeodataRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      {} as never,
    );

    const result = await repository.getAdminMapEntities({
      bbox: '-5,35,1,42',
      zoom: '7',
    });

    expect(result).toMatchObject({
      total: 734,
      limit: 500,
      truncated: true,
      zoom: 7,
      bbox: [-5, 35, 1, 42],
    });
    expect(result.items).toHaveLength(500);
    expect(client.query.mock.calls[1]![0]).toContain(
      'ST_SimplifyPreserveTopology',
    );
    expect(client.query.mock.calls[1]![0]).toContain('LIMIT $8');
    expect(client.query.mock.calls[1]![1]).toEqual([
      -5,
      35,
      1,
      42,
      mapSimplificationToleranceMeters(7),
      -2,
      38.5,
      501,
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([0, 100, 500])(
    'returns an untruncated viewport response for %i matching entities',
    async (total) => {
      const client = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ total: String(total) }] })
          .mockResolvedValueOnce({
            rows: Array.from({ length: total }, (_, index) => ({
              entity: { id: `entity-${index + 1}` },
            })),
          }),
        release: vi.fn(),
      };
      const repository = new GeodataRepository(
        { connect: vi.fn().mockResolvedValue(client) } as never,
        {} as never,
      );

      const result = await repository.getAdminMapEntities({
        bbox: '-5,35,1,42',
        zoom: '7',
      });

      expect(result.items).toHaveLength(total);
      expect(result).toMatchObject({ total, limit: 500, truncated: false });
      expect(client.release).toHaveBeenCalledOnce();
    },
  );

  it('requires valid viewport bounds and zoom for the admin map', async () => {
    const repository = new GeodataRepository(
      { connect: vi.fn() } as never,
      {} as never,
    );

    await expect(repository.getAdminMapEntities({ zoom: 4 })).rejects.toThrow(
      'map bounds are required',
    );
    await expect(
      repository.getAdminMapEntities({ bbox: '0,0,1,1', zoom: 23 }),
    ).rejects.toThrow('map zoom must be an integer from 0 to 22');
    await expect(
      repository.getAdminMapEntities({ bbox: '0,91,1,92', zoom: 4 }),
    ).rejects.toThrow('valid WGS 84 bounding box');
  });

  it('generalizes no more than 500 submitted geometries with PostGIS', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ items: [{ id: 'area-1', geometry: { type: 'Polygon' } }] }],
      }),
      release: vi.fn(),
    };
    const repository = new GeodataRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      {} as never,
    );
    const input = {
      zoom: 5,
      items: [
        {
          id: 'area-1',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };

    await expect(repository.simplifyMapGeometries(input)).resolves.toEqual({
      items: [{ id: 'area-1', geometry: { type: 'Polygon' } }],
      zoom: 5,
    });
    expect(client.query.mock.calls[0]![0]).toContain(
      'ST_SimplifyPreserveTopology',
    );
    expect(client.query.mock.calls[0]![1]![1]).toBe(
      mapSimplificationToleranceMeters(5),
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects oversized map simplification batches and payloads', async () => {
    const repository = new GeodataRepository(
      { connect: vi.fn() } as never,
      {} as never,
    );
    const validItem = {
      id: 'area-1',
      geometry: { type: 'Point', coordinates: [0, 0] },
    };

    await expect(
      repository.simplifyMapGeometries({
        zoom: 4,
        items: Array.from({ length: 501 }, () => validItem),
      }),
    ).rejects.toThrow('at most 500 map geometries');
    await expect(
      repository.simplifyMapGeometries({
        zoom: 4,
        items: [
          {
            id: 'area-1',
            geometry: {
              type: 'Point',
              coordinates: ['x'.repeat(4 * 1024 * 1024)],
            },
          },
        ],
      }),
    ).rejects.toThrow('payload exceeds 4 MiB');
  });

  it('returns a programme-specific extent and entity count', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            total: '12',
            min_lon: '-123',
            min_lat: '24',
            max_lon: '-67',
            max_lat: '49',
          },
        ],
      }),
      release: vi.fn(),
    };
    const repository = new GeodataRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      {} as never,
    );

    await expect(
      repository.getProgrammeMapExtent('continental'),
    ).resolves.toEqual({
      programme: 'continental',
      total: 12,
      bbox: [-123, 24, -67, 49],
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_Extent(geom)'),
      ['continental', ['APPROVED', 'CANDIDATE']],
    );
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('filters vector tiles by programme and public entity status', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const repository = new GeodataRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      { observePostgisQuery: vi.fn() } as never,
    );

    const result = await repository.getTile(3, 2, 4, 'continental', [
      'APPROVED',
      'CANDIDATE',
    ]);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('programme_slug=$5'),
      expect.arrayContaining(['continental', ['APPROVED', 'CANDIDATE']]),
    );
    expect(client.query.mock.calls[0][0]).toContain(
      'lifecycle_status=ANY($6::text[])',
    );
    expect(client.query.mock.calls[0][0]).toContain(
      'ST_SimplifyPreserveTopology',
    );
    expect(client.query.mock.calls[0][1]).toHaveLength(10);
    expect(client.query.mock.calls[0][1][8]).toBe(
      mapSimplificationToleranceMeters(3),
    );
    expect(client.query.mock.calls[0][1][9]).toBe(501);
    expect(client.query.mock.calls[0][0]).toContain('LIMIT $10');
    expect(result).toMatchObject({
      type: 'FeatureCollection',
      count: 0,
      truncated: false,
      tile: { z: 3, x: 2, y: 4 },
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('uses coarser map geometry at low zoom and retains a small high-zoom floor', () => {
    expect(mapSimplificationToleranceMeters(3)).toBeGreaterThan(
      mapSimplificationToleranceMeters(12),
    );
    expect(mapSimplificationToleranceMeters(22)).toBeGreaterThanOrEqual(0.05);
  });

  it('bounds caller-supplied tile feature limits', async () => {
    const repository = new GeodataRepository(
      { connect: vi.fn() } as never,
      {} as never,
    );
    await expect(
      repository.getTile(3, 2, 4, undefined, ['APPROVED'], 501),
    ).rejects.toThrow('tile feature limit must be between 1 and 500');
  });

  it('returns at most the requested tile limit and marks the tile truncated', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: 'entity-1',
            programme_slug: 'continental',
            entity_identifier: 'CT-001',
            entity_type_code: 'AREA',
            name: 'Entity one',
            status: 'APPROVED',
            geometry: { type: 'Point', coordinates: [0, 0] },
            centroid_lon: '0',
            centroid_lat: '0',
          },
          {
            id: 'entity-2',
            programme_slug: 'continental',
            entity_identifier: 'CT-002',
            entity_type_code: 'AREA',
            name: 'Entity two',
            status: 'APPROVED',
            geometry: { type: 'Point', coordinates: [1, 1] },
            centroid_lon: '1',
            centroid_lat: '1',
          },
        ],
      }),
      release: vi.fn(),
    };
    const repository = new GeodataRepository(
      { connect: vi.fn().mockResolvedValue(client) } as never,
      { observePostgisQuery: vi.fn() } as never,
    );

    await expect(
      repository.getTile(3, 2, 4, 'continental', ['APPROVED'], 1),
    ).resolves.toMatchObject({ count: 1, truncated: true });
  });
});
