import { expect, test } from '@playwright/test';

test('creates one managed Geodata candidate with a suggested manual programme ID', async ({
  page,
}) => {
  const previews: unknown[] = [];
  const creates: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
  const programme = {
    slug: 'partidos-judiciales',
    name: 'Partidos Judiciales',
    status: 'ACTIVE',
    entityNumbering: {
      identifier: 'PJES',
      qualifierMode: 'MANUAL',
      serialWidth: 3,
      assignmentMode: 'MANUAL',
    },
  };

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-access-token',
          refreshToken: 'admin-geodata-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'global-admin-1',
          email: 'admin@example.test',
          displayName: 'Global Admin',
          scopes: ['*'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes' && method === 'GET') {
      await route.fulfill({ json: { items: [programme], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({
        json: { items: [{ code: 'DISTRICT', label: 'District' }] },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({ json: { continents: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      await route.fulfill({
        json: { items: [], total: 0, page: 1, pageSize: 100, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/entity-id-preview' && method === 'POST') {
      previews.push(body);
      const qualifier = (body as { qualifier?: string }).qualifier;
      await route.fulfill({
        json: {
          entityIdentifier: `PJES-${qualifier}-001`,
          qualifier,
          serial: 1,
          assignmentMode: 'MANUAL',
          reserved: false,
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/entities' && method === 'POST') {
      creates.push({
        body: body as Record<string, unknown>,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({
        status: 201,
        json: {
          id: 'manual-entity-1',
          name: 'Judicial district example',
          entityIdentifier: 'PJES-G-001',
          status: 'CANDIDATE',
        },
      });
      return;
    }

    await route.fulfill({ json: { items: [], total: 0, nextPage: null } });
  });

  await page.goto('/entity-management');
  await expect(page).toHaveURL(/\/login\?redirect=\/entity-management$/);
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/entity-management$/);

  await page.getByRole('button', { name: 'New Candidate' }).click();
  await page.getByLabel('Name').fill('Judicial district example');
  await page.getByLabel('Programme scope').selectOption(programme.slug);
  await page.getByRole('checkbox', { name: 'District' }).check();
  await page.getByLabel('ID qualifier').fill('G');
  await expect(page.getByText('Suggested programme ID:')).toBeVisible();
  await expect(page.getByLabel('ID serial')).toHaveValue('1');
  await expect(page.getByText('PJES-G-001')).toBeVisible();

  await page.getByRole('button', { name: 'Submit candidate' }).click();

  await expect(
    page.getByText('Candidate created synchronously as PJES-G-001.'),
  ).toBeVisible();
  expect(
    previews.some((body) => (body as { qualifier?: string }).qualifier === 'G'),
  ).toBe(true);
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    body: {
      name: 'Judicial district example',
      programmeSlug: programme.slug,
      entityTypeCodes: ['DISTRICT'],
      qualifier: 'G',
      serial: '1',
      geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
    },
  });
  expect(creates[0]?.idempotencyKey).not.toBe('');
});
