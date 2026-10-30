import {
  GeodataRepository,
  mapSimplificationToleranceMeters,
} from './geodata.repository.js';

describe('GeodataRepository programme map reads', () => {
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
