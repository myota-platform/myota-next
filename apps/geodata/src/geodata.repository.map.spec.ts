import { GeodataRepository } from './geodata.repository.js';

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
    expect(result).toMatchObject({
      type: 'FeatureCollection',
      count: 0,
      truncated: false,
      tile: { z: 3, x: 2, y: 4 },
    });
    expect(client.release).toHaveBeenCalledOnce();
  });
});
