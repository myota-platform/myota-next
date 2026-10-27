import { restorePreviousCatalogRelease } from './myota-test-catalog-recovery.mjs';

describe('restorePreviousCatalogRelease', () => {
  it('restores a known failed operation and still fails the workflow', async () => {
    const restore = vi.fn().mockResolvedValue(undefined);
    const candidateError = Object.assign(new Error('operation stalled'), {
      safeToRollback: true,
    });

    await expect(
      restorePreviousCatalogRelease({
        candidateError,
        previousChartVersion: '1.1.6-testing.cfb1af644f91.1',
        restore,
      }),
    ).rejects.toThrow(
      'Previous chart 1.1.6-testing.cfb1af644f91.1 and its approved image digests were restored and verified',
    );
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('does not start a competing rollback when the operation outcome is unknown', async () => {
    const restore = vi.fn();

    await expect(
      restorePreviousCatalogRelease({
        candidateError: new Error('operation timed out while still running'),
        previousChartVersion: '1.1.6-testing.cfb1af644f91.1',
        restore,
      }),
    ).rejects.toThrow('no automatic rollback was attempted');
    expect(restore).not.toHaveBeenCalled();
  });

  it('reports both the failed update and failed restoration', async () => {
    const candidateError = Object.assign(new Error('operation stalled'), {
      safeToRollback: true,
    });
    const restore = vi
      .fn()
      .mockRejectedValue(new Error('previous chart is unavailable'));

    await expect(
      restorePreviousCatalogRelease({
        candidateError,
        previousChartVersion: '1.1.6-testing.cfb1af644f91.1',
        restore,
      }),
    ).rejects.toThrow(
      'Automatic restoration to 1.1.6-testing.cfb1af644f91.1 also failed: previous chart is unavailable',
    );
  });
});
