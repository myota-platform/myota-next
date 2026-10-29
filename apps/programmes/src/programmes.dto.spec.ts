import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PoolClient } from 'pg';
import { ProgrammeRepository } from './programme.repository.js';
import { ProgrammeEntityNumberingDto } from './programmes.dto.js';

describe('ProgrammeEntityNumberingDto', () => {
  it('accepts a programme and location-scoped numbering policy', () => {
    const policy = plainToInstance(ProgrammeEntityNumberingDto, {
      identifier: 'PJE',
      qualifierMode: 'LOCATION',
      qualifierField: 'provinceCode',
      serialWidth: 5,
      assignmentMode: 'QUALIFIER_SEQUENCE',
    });

    expect(validateSync(policy)).toEqual([]);
  });

  it.each([
    {
      identifier: 'pje',
      qualifierMode: 'NONE',
      serialWidth: 4,
      assignmentMode: 'MANUAL',
    },
    {
      identifier: 'TOO-LONG',
      qualifierMode: 'NONE',
      serialWidth: 4,
      assignmentMode: 'MANUAL',
    },
    {
      identifier: 'PJE',
      qualifierMode: 'LOCATION',
      serialWidth: 4,
      assignmentMode: 'MANUAL',
    },
    {
      identifier: 'PJE',
      qualifierMode: 'NONE',
      serialWidth: 7,
      assignmentMode: 'MANUAL',
    },
  ])('rejects invalid numbering policy %#', (input) => {
    const policy = plainToInstance(ProgrammeEntityNumberingDto, input);
    expect(validateSync(policy).length).toBeGreaterThan(0);
  });
});

describe('ProgrammeRepository identifier reservations', () => {
  it('keeps a previous identifier reserved to its programme', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ programme_slug: 'alpine' }] });
    const repository = new ProgrammeRepository(null);

    await expect(
      repository.reserveIdentifier(
        { query } as unknown as PoolClient,
        'alpine',
        'ALP',
      ),
    ).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).toContain(
      'programme_entity_identifier_reservation',
    );
  });
});
