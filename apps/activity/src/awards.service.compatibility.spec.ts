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

  it('creates a new draft version when editing a published award', async () => {
    const published = {
      id: 'award-1',
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-10',
      name: 'Field Day Ten',
      description: 'Original description',
      awardText: '',
      category: 'HUNTER',
      version: 3,
      status: 'PUBLISHED',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 10 },
      levels: [{ id: 'level-10', name: 'Ten', threshold: 10 }],
      backgroundAsset: {
        id: 'background-1',
        objectKey: 'awards/field-day.png',
        mediaType: 'image/png',
        widthPx: 2481,
        heightPx: 3508,
      },
      printSpec: { page: 'A4', orientation: 'PORTRAIT', dpi: 300 },
      template: {
        elements: [
          { kind: 'AWARD_NAME', x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
          { kind: 'CALLSIGN', x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
          { kind: 'PERSON_NAME', x: 0.1, y: 0.3, width: 0.8, height: 0.1 },
          { kind: 'DATE_OBTAINED', x: 0.1, y: 0.4, width: 0.8, height: 0.1 },
          { kind: 'MANAGER_NAME', x: 0.1, y: 0.5, width: 0.8, height: 0.1 },
          {
            kind: 'MANAGER_SIGNATURE',
            x: 0.1,
            y: 0.6,
            width: 0.8,
            height: 0.1,
          },
        ],
      },
    };
    const createPublishedAwardRevision = vi.fn(
      async (_id, _version, record) => record,
    );
    const awardsRepository = {
      getAwardDefinition: vi.fn(async () => published),
      findAwardAsset: vi.fn(async () => ({
        id: 'background-1',
        kind: 'BACKGROUND',
        objectKey: 'awards/field-day.png',
        mediaType: 'image/png',
        widthPx: 640,
        heightPx: 480,
      })),
      utcTimestamp: vi.fn(async () => '2026-10-27T00:00:00.000Z'),
      createPublishedAwardRevision,
    } as unknown as ActivityAwardsRepository;
    const service = new AwardsService(
      {} as ActivityRepository,
      awardsRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['awards.admin'])}`;

    const saved = await service.patch(
      authorization,
      'revision-key',
      published.id,
      {
        awardId: published.id,
        expectedVersion: 3,
        awardText: 'For ten successful contacts',
      },
    );

    expect(saved).toMatchObject({
      programmeSlug: published.programmeSlug,
      code: published.code,
      version: 4,
      status: 'DRAFT',
      revisionOf: published.id,
      awardText: 'For ten successful contacts',
      description: published.description,
      levels: published.levels,
    });
    expect(saved.id).not.toBe(published.id);
    expect(createPublishedAwardRevision).toHaveBeenCalledWith(
      published.id,
      3,
      saved,
      'revision-key',
    );
  });

  it('rejects a published award edit based on a stale version', async () => {
    const published = {
      id: 'award-1',
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-10',
      version: 3,
      status: 'PUBLISHED',
    };
    const createPublishedAwardRevision = vi.fn();
    const service = new AwardsService(
      {} as ActivityRepository,
      {
        getAwardDefinition: vi.fn(async () => published),
        createPublishedAwardRevision,
      } as unknown as ActivityAwardsRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['awards.admin'])}`;

    await expect(
      service.patch(authorization, 'revision-key', published.id, {
        expectedVersion: 2,
      }),
    ).rejects.toThrow(
      'award changed since it was loaded; reload before editing',
    );
    expect(createPublishedAwardRevision).not.toHaveBeenCalled();
  });

  it('denies published award edits without awards.admin', async () => {
    const published = {
      id: 'award-1',
      programmeSlug: 'field-day',
      code: 'FIELD-DAY-10',
      version: 3,
      status: 'PUBLISHED',
    };
    const createPublishedAwardRevision = vi.fn();
    const service = new AwardsService(
      {} as ActivityRepository,
      {
        getAwardDefinition: vi.fn(async () => published),
        createPublishedAwardRevision,
      } as unknown as ActivityAwardsRepository,
    );
    const readOnlyAuthorization = `Bearer ${signAccessToken('reader-1', ['awards.read'])}`;

    await expect(
      service.patch(readOnlyAuthorization, 'revision-key', published.id, {
        expectedVersion: 3,
        name: 'Unauthorized edit',
      }),
    ).rejects.toThrow('award scope is required');
    expect(createPublishedAwardRevision).not.toHaveBeenCalled();
  });

  it('rejects invalid award image data before sending it to object storage', async () => {
    const saveAwardAsset = vi.fn();
    const service = new AwardsService(
      {} as ActivityRepository,
      {
        getAwardAsset: vi.fn(async () => ({
          id: 'asset-1',
          kind: 'BACKGROUND',
          objectKey: 'test/background.png',
          bucket: 'test-award-assets',
        })),
        saveAwardAsset,
      } as unknown as ActivityAwardsRepository,
    );
    const authorization = `Bearer ${signAccessToken('admin-1', ['awards.admin'])}`;

    await expect(
      service.putAssetContent(
        authorization,
        'asset-1',
        'image/png',
        Buffer.from('not an image'),
      ),
    ).rejects.toThrow('image content is invalid');
    expect(saveAwardAsset).not.toHaveBeenCalled();
  });
});
