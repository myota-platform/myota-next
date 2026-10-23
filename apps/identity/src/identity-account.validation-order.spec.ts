import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { IdentityAuthService } from './auth.service.js';
import type { IdentityRoleService } from './identity-role.service.js';
import type { IdentityProfileImageService } from './identity-profile-image.service.js';
import { IdentityAccountService } from './identity-account.service.js';

describe('IdentityAccountService update validation order', () => {
  it('rolls back an account update when the later role-grant check fails', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111';
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public.account a')) {
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Participant',
                email: 'participant@example.test',
                participation_type: 'OPERATOR',
                status: 'ACTIVE',
                website_url: null,
                biography_markdown: null,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
                primary_callsign_id: null,
                created_at: '2026-01-01T00:00:00.000000Z',
                updated_at: '2026-01-01T00:00:00.000000Z',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO public.security_event')) {
          return {
            rows: [{ occurred_at: '2026-01-01T00:00:00.000000Z' }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const service = new IdentityAccountService(
      { connect: async () => client } as unknown as Pool,
      {
        currentAccount: async () => ({
          id: 'admin-1',
          scopes: ['identity.admin'],
        }),
      } as unknown as IdentityAuthService,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount('Bearer admin', accountId, {
        displayName: 'Changed before role authorization',
        roles: [{ code: 'PARTICIPANT' }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(
      queries.some((sql) => sql.includes('UPDATE public.account SET')),
    ).toBe(true);
    expect(queries).toContain('ROLLBACK');
    expect(
      queries.some((sql) => sql.includes('UPDATE public.account_role')),
    ).toBe(false);
    expect(queries).not.toContain('COMMIT');
  });

  it('checks admin permission before looking up the account or validating the body', async () => {
    const connect = vi.fn();
    const auth = {
      currentAccount: async () => ({ id: 'reader-1', scopes: [] }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      { connect } as unknown as Pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount('Bearer reader', 'missing-account', {
        status: 'INVALID',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(connect).not.toHaveBeenCalled();
  });

  it('prevents an administrator from changing their own role assignments', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111';
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public.account a'))
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Administrator',
                email: 'admin@example.test',
                participation_type: 'OPERATOR',
                status: 'ACTIVE',
                website_url: null,
                biography_markdown: null,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
                primary_callsign_id: null,
                created_at: '2026-01-01T00:00:00.000000Z',
                updated_at: '2026-01-01T00:00:00.000000Z',
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('INSERT INTO public.security_event'))
          return {
            rows: [{ occurred_at: '2026-01-01T00:00:00.000000Z' }],
            rowCount: 1,
          };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const auth = {
      currentAccount: async () => ({
        id: accountId,
        scopes: ['identity.admin', 'identity.roles.assign'],
      }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      { connect: async () => client } as unknown as Pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount(
        'Bearer admin',
        accountId,
        {
          roles: [{ code: 'PARTICIPANT' }],
        },
        true,
      ),
    ).rejects.toThrow('actors cannot change their own role assignments');
    expect(queries).toContain('ROLLBACK');
    expect(
      queries.some((sql) => sql.includes('UPDATE public.account_role')),
    ).toBe(false);
  });

  it('resolves the account before validating the body', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({ id: 'admin-1', scopes: ['*'] }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount(
        'Bearer admin',
        '66666666-6666-4666-8666-666666666666',
        {
          status: 'INVALID',
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(queries[0]).toBe('BEGIN');
    expect(queries.some((sql) => sql.includes('FROM public.account a'))).toBe(
      true,
    );
    expect(
      queries.some((sql) => sql.includes('UPDATE public.account SET')),
    ).toBe(false);
  });

  it('reports an email conflict before validating status, matching Python', async () => {
    const queries: string[] = [];
    const accountId = '11111111-1111-4111-8111-111111111111';
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public.account a')) {
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Participant',
                email: 'participant@example.test',
                participation_type: 'OPERATOR',
                status: 'ACTIVE',
                website_url: null,
                biography_markdown: null,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
                primary_callsign_id: null,
                created_at: new Date('2025-01-01T00:00:00.000Z'),
                updated_at: new Date('2025-01-01T00:00:00.000Z'),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT 1 FROM public.account'))
          return { rows: [{}], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({ id: 'admin-1', scopes: ['*'] }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount('Bearer admin', accountId, {
        email: 'existing@example.test',
        status: 'INVALID',
      }),
    ).rejects.toThrow('email already exists');

    expect(
      queries.findIndex((sql) => sql.includes('SELECT 1 FROM public.account')),
    ).toBeGreaterThan(
      queries.findIndex((sql) => sql.includes('FROM public.account a')),
    );
    expect(
      queries.some((sql) => sql.includes('UPDATE public.account SET')),
    ).toBe(false);
  });

  it('validates profile fields before checking an email conflict, matching Python', async () => {
    const queries: string[] = [];
    const accountId = '11111111-1111-4111-8111-111111111111';
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public.account a')) {
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Participant',
                email: 'participant@example.test',
                participation_type: 'OPERATOR',
                status: 'ACTIVE',
                website_url: null,
                biography_markdown: null,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
                primary_callsign_id: null,
                created_at: new Date('2025-01-01T00:00:00.000Z'),
                updated_at: new Date('2025-01-01T00:00:00.000Z'),
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('SELECT 1 FROM public.account'))
          return { rows: [{}], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const auth = {
      currentAccount: async () => ({ id: 'admin-1', scopes: ['*'] }),
    } as unknown as IdentityAuthService;
    const service = new IdentityAccountService(
      pool,
      auth,
      {} as IdentityRoleService,
      {} as IdentityProfileImageService,
    );

    await expect(
      service.updateAccount('Bearer admin', accountId, {
        websiteUrl: 'ftp://example.test',
        email: 'existing@example.test',
      }),
    ).rejects.toThrow(
      'websiteUrl must be an HTTP or HTTPS URL without credentials',
    );

    expect(
      queries.some((sql) => sql.includes('SELECT 1 FROM public.account')),
    ).toBe(false);
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
});
