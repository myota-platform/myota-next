import { expect, test } from '@playwright/test';

test('previews and synchronously assigns selected approved entities with permanent IDs', async ({
  page,
}) => {
  const assignmentRequests: Array<{
    body: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
  const programme = {
    slug: 'partidos-judiciales',
    name: 'Partidos Judiciales',
    status: 'ACTIVE',
    entityTypes: [{ code: 'PART_JUD' }],
    entityNumbering: {
      identifier: 'PJES',
      qualifierMode: 'NONE',
      serialWidth: 3,
      assignmentMode: 'PROGRAMME_SEQUENCE',
    },
  };
  const entities = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'District One',
      status: 'APPROVED',
      entityTypes: ['PART_JUD'],
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      name: 'District Two',
      status: 'APPROVED',
      entityTypes: ['PART_JUD'],
    },
  ];

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
      await route.fulfill({ json: { items: [{ code: 'PART_JUD' }] } });
      return;
    }
    if (url.pathname === '/v1/geodata/location-options') {
      await route.fulfill({ json: { continents: [] } });
      return;
    }
    if (url.pathname === '/v1/geodata/entities' && method === 'GET') {
      await route.fulfill({
        json: {
          items: entities,
          total: entities.length,
          page: 1,
          pageSize: 25,
          nextPage: null,
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/geodata/entity-programme-assignment-preview' &&
      method === 'POST'
    ) {
      await route.fulfill({
        json: {
          programmeSlug: programme.slug,
          assignmentMode: 'PROGRAMME_SEQUENCE',
          entityCount: 2,
          items: entities.map((entity, index) => ({
            entityId: entity.id,
            name: entity.name,
            entityIdentifier: `PJES-00${index + 1}`,
            qualifier: null,
            serial: index + 1,
            entityTypeCodes: ['PART_JUD'],
          })),
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/geodata/entity-programme-assignments' &&
      method === 'POST'
    ) {
      assignmentRequests.push({
        body: body as Record<string, unknown>,
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({ status: 200, json: { assignedCount: 2 } });
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

  await page.getByRole('checkbox', { name: 'Select District One' }).check();
  await page.getByRole('checkbox', { name: 'Select District Two' }).check();
  await page
    .getByRole('button', { name: 'Assign selected to programme (2)' })
    .click();
  await page.getByLabel('Target programme').selectOption(programme.slug);
  await page.getByRole('button', { name: 'Preview IDs' }).click();

  await expect(page.getByText('PJES-001')).toBeVisible();
  await expect(page.getByText('PJES-002')).toBeVisible();
  await page
    .getByRole('button', { name: 'Confirm assignment of 2 entities' })
    .click();

  await expect(
    page.getByText(
      '2 entities assigned to partidos-judiciales with permanent IDs.',
    ),
  ).toBeVisible();
  expect(assignmentRequests).toHaveLength(1);
  expect(assignmentRequests[0]).toMatchObject({
    body: {
      programmeSlug: programme.slug,
      entityIds: entities.map((entity) => entity.id),
      expectedIdentifiers: [
        { entityId: entities[0]?.id, entityIdentifier: 'PJES-001' },
        { entityId: entities[1]?.id, entityIdentifier: 'PJES-002' },
      ],
    },
  });
  expect(assignmentRequests[0]?.idempotencyKey).not.toBe('');
});
