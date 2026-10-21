import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool, types as pgTypes } from 'pg';
import { integerSetting } from './integer-setting.js';

export const DATABASE_HEALTH_POOL = Symbol('DATABASE_HEALTH_POOL');

@Injectable()
export class DatabaseHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseHealthService.name);

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {
    if (this.pool && typeof this.pool.on === 'function')
      this.pool.on('error', (error: Error) => {
        this.logger.warn(`PostgreSQL idle connection failed: ${error.message}`);
      });
  }

  async isReady(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}

@Module({})
export class DatabaseHealthModule {
  static forEnvironment(
    environmentVariable: string,
    parseJson?: (value: string) => unknown,
  ): DynamicModule {
    return {
      module: DatabaseHealthModule,
      providers: [
        {
          provide: DATABASE_HEALTH_POOL,
          useFactory: () => {
            const connectionString = process.env[environmentVariable];
            return connectionString
              ? new Pool({
                  connectionString,
                  max: poolMaximum(environmentVariable),
                  connectionTimeoutMillis: 2_000,
                  idleTimeoutMillis: 30_000,
                  ...(parseJson
                    ? {
                        types: {
                          getTypeParser: (
                            oid: number,
                            format?: 'text' | 'binary',
                          ) =>
                            (oid === 114 || oid === 3802) && format !== 'binary'
                              ? parseJson
                              : pgTypes.getTypeParser(oid, format),
                        },
                      }
                    : {}),
                })
              : null;
          },
        },
        DatabaseHealthService,
      ],
      exports: [DatabaseHealthService, DATABASE_HEALTH_POOL],
    };
  }
}

function poolMaximum(environmentVariable: string): number {
  const activityDatabase = environmentVariable === 'ACTIVITY_DATABASE_URL';
  const configuredMaximum = activityDatabase
    ? (process.env.MYOTA_ACTIVITY_DB_POOL_MAX ?? process.env.MYOTA_DB_POOL_MAX)
    : process.env.MYOTA_DB_POOL_MAX;
  return Math.max(
    1,
    integerSetting(configuredMaximum, activityDatabase ? 12 : 10),
  );
}
