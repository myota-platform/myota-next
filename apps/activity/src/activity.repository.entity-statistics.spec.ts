import { ActivityRepository } from './activity.repository.js';

describe('ActivityRepository.entityStatistics', () => {
  it('returns public valid activation and QSO totals for requested entities', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            entity_id: 'entity-1',
            activation_count: '3',
            activation_qso_count: '21',
            hunter_qso_count: '8',
            qso_count: '28',
            last_activation_at: '2026-05-01T12:00:00.000Z',
          },
          {
            entity_id: 'entity-2',
            activation_count: '0',
            activation_qso_count: '0',
            hunter_qso_count: '0',
            qso_count: '0',
            last_activation_at: null,
          },
        ],
      }),
      release: vi.fn(),
    };
    const repository = new ActivityRepository({
      connect: vi.fn().mockResolvedValue(client),
    } as never);

    const result = await repository.entityStatistics('worldwide', [
      'entity-1',
      'entity-2',
    ]);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("programme_slug=$1 AND status='CLOSED'"),
      ['worldwide', ['entity-1', 'entity-2']],
    );
    const query = client.query.mock.calls[0][0] as string;
    expect(query).toContain("q.status IN ('VALID','CORRECTED')");
    expect(query).toContain('q.worked_entity_id=ANY($2::text[])');
    expect(result).toEqual([
      {
        entityId: 'entity-1',
        activationCount: 3,
        activationQsoCount: 21,
        hunterQsoCount: 8,
        qsoCount: 28,
        lastActivationAt: '2026-05-01T12:00:00Z',
      },
      {
        entityId: 'entity-2',
        activationCount: 0,
        activationQsoCount: 0,
        hunterQsoCount: 0,
        qsoCount: 0,
        lastActivationAt: null,
      },
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
