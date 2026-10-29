import { describe, expect, it, vi } from 'vitest';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import {
  loadProgrammeNumberingPolicy,
  loadProgrammePolicy,
} from './programme-policy-client.js';

describe('programme policy client', () => {
  const numbering = {
    identifier: 'PJES',
    qualifierMode: 'LOCATION',
    qualifierField: 'provinceCode',
    serialWidth: 3,
    assignmentMode: 'QUALIFIER_SEQUENCE',
  };

  function requestWith(body: unknown) {
    return vi.fn(
      async () =>
        new Response(stringifyJsonWithBigInts(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  }

  it('keeps numbering reads compatible when legacy programmes omit entity types', async () => {
    const request = requestWith({ entityNumbering: numbering });

    await expect(
      loadProgrammeNumberingPolicy('partidos', 'http://programmes', request),
    ).resolves.toEqual(numbering);
    await expect(
      loadProgrammePolicy('partidos', 'http://programmes', request),
    ).resolves.toEqual({
      entityNumbering: numbering,
      entityTypeCodes: [],
    });
  });

  it('returns configured entity type codes with the numbering policy', async () => {
    const request = requestWith({
      entityNumbering: numbering,
      entityTypes: [{ code: 'district' }, { code: 'SUMMIT' }],
    });

    await expect(
      loadProgrammePolicy('partidos', 'http://programmes', request),
    ).resolves.toEqual({
      entityNumbering: numbering,
      entityTypeCodes: ['district', 'SUMMIT'],
    });
  });
});
