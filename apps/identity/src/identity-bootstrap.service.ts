import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_HEALTH_POOL } from '@app/platform/database.module.js';
import { writeOutboxEvent, writeSecurityEvent } from '@app/platform/outbox.js';
import { trimPythonWhitespace } from '@app/platform/python-strings.js';
import { unicodeCaseFold } from '@app/platform/unicode-casefold.js';
import { hashPassword } from './auth.service.js';

const bootstrapOperatorScopes = [
  'identity.admin',
  'identity.roles.assign',
  'identity.roles.manage',
  'identity.oidc.configure',
  'identity.service.issue',
  'callsign.verify',
  'geodata.review',
  'geodata.import',
  'activity.admin',
  'activity.read',
  '*',
];

@Injectable()
export class IdentityBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(IdentityBootstrapService.name);

  constructor(
    @Inject(DATABASE_HEALTH_POOL) private readonly pool: Pool | null,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = unicodeCaseFold(
      trimPythonWhitespace(process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? ''),
    );
    const password = process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? '';
    if (!email || !password) return;
    if (!this.pool)
      throw new Error('CORE_DATABASE_URL is required to bootstrap Identity');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('identity-bootstrap-admin:' || $1, 0))",
        [email],
      );
      let selected = await client.query<{
        id: string;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id,
                to_char(created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                to_char(updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
           FROM public.account
          WHERE identity_email_key = $1 FOR UPDATE`,
        [email],
      );
      let created = false;
      if (!selected.rows[0]) {
        const inserted = await client.query<{
          id: string;
          created_at: string;
          updated_at: string;
        }>(
          `INSERT INTO public.account
             (display_name, email, identity_email_key, participation_type, status)
           VALUES ('Global Administrator', $1::public.citext, $1::text,
                   'OPERATOR', 'ACTIVE')
           ON CONFLICT (identity_email_key)
             WHERE identity_email_key IS NOT NULL DO NOTHING
           RETURNING id,
             to_char(created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
             to_char(updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`,
          [email],
        );
        if (inserted.rows[0]) {
          selected = inserted;
          created = true;
        } else {
          selected = await client.query<{
            id: string;
            created_at: string;
            updated_at: string;
          }>(
            `SELECT id,
                    to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
                    to_char(updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
               FROM public.account
              WHERE identity_email_key = $1 FOR UPDATE`,
            [email],
          );
        }
      }
      const account = selected.rows[0];
      if (!account) throw new Error('bootstrap account could not be resolved');

      const credential = await client.query<{
        password_hash: string | null;
      }>(
        `SELECT password_hash FROM public.account_credential
          WHERE account_id = $1 FOR UPDATE`,
        [account.id],
      );
      if (!credential.rows[0]?.password_hash) {
        await client.query(
          `INSERT INTO public.account_credential
             (account_id, password_hash, password_changed_at, failed_attempts, locked_until)
           VALUES ($1, $2, now(), 0, NULL)
           ON CONFLICT (account_id) DO UPDATE SET
             password_hash = EXCLUDED.password_hash,
             password_changed_at = EXCLUDED.password_changed_at,
             failed_attempts = 0,
             locked_until = NULL`,
          [account.id, await hashPassword(password)],
        );
      }

      if (created) {
        await writeOutboxEvent(client, {
          eventType: 'identity.account.created.v1',
          aggregateType: 'account',
          aggregateId: account.id,
          payload: {
            account: {
              id: account.id,
              displayName: 'Global Administrator',
              email,
              participationType: 'OPERATOR',
              status: 'ACTIVE',
              websiteUrl: null,
              biographyMarkdown: null,
              profileImage: null,
              callsigns: [],
              primaryCallsignId: null,
              createdAt: account.created_at,
              updatedAt: account.updated_at,
            },
            source: 'bootstrap',
          },
        });
      }

      const role = await client.query(
        `SELECT 1 FROM public.account_role
          WHERE account_id = $1 AND role_code = 'GLOBAL_OPERATOR'
            AND valid_to IS NULL
          LIMIT 1`,
        [account.id],
      );
      if (!role.rowCount) {
        await client.query(
          `INSERT INTO public.account_role
             (account_id, role_code, scopes)
           VALUES ($1, 'GLOBAL_OPERATOR', $2::jsonb)`,
          [account.id, JSON.stringify(bootstrapOperatorScopes)],
        );
        await writeSecurityEvent(
          client,
          'identity.bootstrap-admin.created.v1',
          { accountId: account.id, email },
        );
      }

      await client.query('COMMIT');
      if (created) this.logger.log('Bootstrap administrator account created');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
