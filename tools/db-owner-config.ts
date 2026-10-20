export type OwnerDatabaseConfig = {
  database: string;
  environment: NodeJS.ProcessEnv;
};

export function assertDistinctDatabaseTargets(
  ownerNames: readonly string[],
  configs: Record<string, OwnerDatabaseConfig>,
): void {
  const seen = new Map<string, string>();
  for (const owner of ownerNames) {
    const config = configs[owner];
    const target = `${config.environment.PGHOST?.toLowerCase()}:${config.environment.PGPORT}/${config.database}`;
    const previous = seen.get(target);
    if (previous)
      throw new Error(
        `${previous} and ${owner} database URLs target the same PostgreSQL database`,
      );
    seen.set(target, owner);
  }
}
