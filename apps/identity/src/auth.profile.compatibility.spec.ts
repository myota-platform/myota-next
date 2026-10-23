import type { Pool, PoolClient } from 'pg';
import { signAccessToken } from '../../../libs/platform/src/access-token.js';
import { IdentityAuthService } from './auth.service.js';

describe('Identity own-profile compatibility', () => {
  const accountId = '566b8475-bda2-4a2d-8ab8-d7a9a93c0041';

  function harness() {
    const statements: string[] = [];
    let websiteUrl: string | null = null;
    let biographyMarkdown: string | null = null;
    const client = {
      query: async (sql: string, values: unknown[] = []) => {
        statements.push(sql);
        if (sql.includes('FROM public.auth_revocation'))
          return { rows: [], rowCount: 0 };
        if (sql.includes('FROM public.account a'))
          return {
            rows: [
              {
                id: accountId,
                display_name: 'Profile User',
                email: 'user@example.test',
                participation_type: 'INDIVIDUAL',
                status: 'ACTIVE',
                password_hash: null,
                failed_attempts: 0,
                locked_until: null,
                website_url: websiteUrl,
                biography_markdown: biographyMarkdown,
                profile_image_id: null,
                profile_image_media_type: null,
                profile_image_updated_at: null,
              },
            ],
            rowCount: 1,
          };
        if (sql.includes('INSERT INTO public.identity_account_profile')) {
          if (values[3] === true) websiteUrl = values[1] as string | null;
          if (values[4] === true)
            biographyMarkdown = values[2] as string | null;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT p.website_url, p.biography_markdown'))
          return {
            rows: [
              {
                website_url: websiteUrl,
                biography_markdown: biographyMarkdown,
                updated_at: '2026-01-02T00:00:00.000000Z',
              },
            ],
            rowCount: 1,
          };
        return { rows: [], rowCount: 1 };
      },
      release: () => undefined,
    } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    const authorization = `Bearer ${signAccessToken(accountId, ['identity.me'])}`;
    return {
      service: new IdentityAuthService(pool),
      authorization,
      statements,
      get profile() {
        return { websiteUrl, biographyMarkdown };
      },
    };
  }

  it('normalizes the website URL and clears profile fields with empty values', async () => {
    const fixture = harness();

    const saved = await fixture.service.updateOwnProfile(
      fixture.authorization,
      {
        websiteUrl: ' HTTPS://example.test/about ',
        biographyMarkdown: '**Hello**\n\n[Site](https://example.test)',
      },
    );

    expect(saved).toMatchObject({
      websiteUrl: 'https://example.test/about',
      biographyMarkdown: '**Hello**\n\n[Site](https://example.test)',
    });
    expect(fixture.profile).toEqual({
      websiteUrl: 'https://example.test/about',
      biographyMarkdown: '**Hello**\n\n[Site](https://example.test)',
    });

    const cleared = await fixture.service.updateOwnProfile(
      fixture.authorization,
      { websiteUrl: '', biographyMarkdown: null },
    );
    expect(cleared).toMatchObject({
      websiteUrl: null,
      biographyMarkdown: null,
    });
    expect(fixture.profile).toEqual({
      websiteUrl: null,
      biographyMarkdown: null,
    });
    expect(fixture.statements.filter((sql) => sql === 'COMMIT')).toHaveLength(
      2,
    );
  });

  it('rejects unsafe profile values atomically before writing', async () => {
    const cases = [
      { websiteUrl: 'javascript:alert(1)' },
      { websiteUrl: 'https://user:pass@example.test' },
      { websiteUrl: 'ftp://example.test' },
      { websiteUrl: `https://example.test/${'a'.repeat(2048)}` },
      { biographyMarkdown: 'x'.repeat(2001) },
      { profileImage: { id: 'client-selected' } },
      {},
    ];

    for (const body of cases) {
      const fixture = harness();
      await expect(
        fixture.service.updateOwnProfile(fixture.authorization, body),
      ).rejects.toThrow();
      expect(
        fixture.statements.some((sql) =>
          sql.includes('INSERT INTO public.identity_account_profile'),
        ),
      ).toBe(false);
      expect(fixture.statements.at(-1)).toBe('ROLLBACK');
      expect(fixture.statements).not.toContain('COMMIT');
    }
  });
});
