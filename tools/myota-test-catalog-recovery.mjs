export async function restorePreviousCatalogRelease({
  candidateError,
  previousChartVersion,
  restore,
}) {
  if (!candidateError.safeToRollback) {
    throw new Error(
      `Test catalog upgrade failed: ${candidateError.message}. Rancher did not provide a terminal failed operation, so no automatic rollback was attempted; inspect the release before retrying.`,
      { cause: candidateError },
    );
  }

  try {
    await restore();
  } catch (rollbackError) {
    throw new Error(
      `Test catalog upgrade failed: ${candidateError.message}. Automatic restoration to ${previousChartVersion} also failed: ${rollbackError.message}. Manual recovery is required.`,
      { cause: rollbackError },
    );
  }

  throw new Error(
    `Test catalog upgrade failed: ${candidateError.message}. Previous chart ${previousChartVersion} and its approved image digests were restored and verified; this workflow still exits as failed.`,
    { cause: candidateError },
  );
}
