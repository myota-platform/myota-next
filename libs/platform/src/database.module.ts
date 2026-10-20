import {
  DynamicModule,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import { Pool, types as pgTypes } from 'pg';

export const DATABASE_HEALTH_POOL = Symbol('DATABASE_HEALTH_POOL');

@Injectable()
export class DatabaseHealthService implements OnModuleDestroy {
  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

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
                  max: Number(process.env.MYOTA_DB_POOL_MAX ?? 10),
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
