import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GeodataRepository } from './geodata.repository.js';

describe('GeodataRepository.listEntities programme filter', () => {
  it('filters to entities without a programme and preserves pagination', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [{ entity: { id: 'unassigned-1' } }] }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repository = new GeodataRepository(pool as never, {} as never);

    const result = await repository.listEntities({
      programmeUnassigned: 'true',
      page: '2',
      pageSize: '25',
    });

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE programme_slug IS NULL'),
      [],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('WHERE programme_slug IS NULL'),
      [25, 25],
    );
    expect(result).toMatchObject({
      items: [{ id: 'unassigned-1' }],
      page: 2,
      pageSize: 25,
      total: 1,
      nextPage: null,
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects conflicting exact-programme and unassigned filters', async () => {
    const repository = new GeodataRepository({} as never, {} as never);

    await expect(
      repository.listEntities({
        programme: 'parks',
        programmeUnassigned: 'true',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the exact-programme filter unchanged', async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ total: '1' }] })
        .mockResolvedValueOnce({ rows: [{ entity: { id: 'parks-1' } }] }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repository = new GeodataRepository(pool as never, {} as never);

    const result = await repository.listEntities({ programme: 'parks' });

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE programme_slug=$1'),
      ['parks'],
    );
    expect(result.items).toEqual([{ id: 'parks-1' }]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rejects malformed programmeUnassigned values', async () => {
    const repository = new GeodataRepository({} as never, {} as never);

    await expect(
      repository.listEntities({ programmeUnassigned: 'yes' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
