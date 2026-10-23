import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import type { ActivityRepository } from './activity.repository.js';
import type { ActivityAwardsRepository } from './activity-awards.repository.js';
import { AwardsService } from './awards.service.js';

describe('AwardsService synchronous and asynchronous boundaries', () => {
  it('saves one subject progress synchronously and queues broad recalculation', async () => {
    const award = {
      id: 'award-1',
      programmeSlug: 'field-day',
      category: 'HUNTER',
      version: 3,
      achievementMetric: 'QSO_COUNT',
      condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 3 },
      levels: [{ id: 'level-1', name: 'Three contacts', threshold: 3 }],
    };
    const subjectFacts = vi.fn(async () => ({ qsoCount: 5 }));
    const saveAwardProgress = vi.fn(async () => undefined);
    const enqueueJob = vi.fn(async () => ({
      id: 'job-1',
      kind: 'AWARD_RECALCULATE',
      status: 'QUEUED',
    }));
    const repository = {
      subjectFacts,
      saveAwardProgress,
      enqueueJob,
    } as unknown as ActivityRepository;
    const awardsRepository = {
      getAwardDefinition: async () => award,
    } as unknown as ActivityAwardsRepository;
    const service = new AwardsService(repository, awardsRepository);
    const authorization = `Bearer ${signAccessToken('admin-1', ['awards.admin'])}`;

    const progress = await service.progress(
      authorization,
      award.id,
      'participant-1',
    );

    expect(progress).toMatchObject({
      awardId: award.id,
      subjectId: 'participant-1',
      conditionMet: true,
      metric: 'QSO_COUNT',
      progress: 5,
      levels: [{ id: 'level-1', eligible: true }],
    });
    expect(saveAwardProgress).toHaveBeenCalledTimes(1);
    expect(enqueueJob).not.toHaveBeenCalled();

    const queued = await service.recalculate(
      authorization,
      undefined,
      award.id,
      { subjectIds: ['subject-b', 'subject-a'] },
    );

    expect(queued).toMatchObject({
      awardId: award.id,
      ruleVersion: 3,
      jobId: 'job-1',
      status: 'QUEUED',
    });
    expect(enqueueJob).toHaveBeenCalledWith(
      'AWARD_RECALCULATE',
      {
        programmeSlug: 'field-day',
        subjectIds: ['subject-b', 'subject-a'],
        awardId: award.id,
        ruleVersion: 3,
      },
      'award-recalculate:award-1:3:subject-a,subject-b',
    );
    expect(subjectFacts).toHaveBeenCalledTimes(1);
    expect(saveAwardProgress).toHaveBeenCalledTimes(1);
  });
});
