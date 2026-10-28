import { expect, test } from '@playwright/test';

test('reviews pasted GeoJSON candidates and promotes a selected set synchronously', async ({
  page,
}) => {
  const importRequests: Array<{ body: Record<string, any>; key: string }> = [];
  const run = {
    id: 'import-1',
    filename: 'summits.geojson',
    status: 'PREPROCESSED',
    adapter: 'MANUAL',
    format: 'GEOJSON',
    entityTypes: ['SOTA'],
    candidateCount: 259,
    pendingCount: 259,
  };
  const firstFeature = {
    id: 'candidate-1',
    ordinal: 1,
    name: 'Example summit to reject',
    validationStatus: 'PENDING',
    geometry: { type: 'Point', coordinates: [7.2, 46.1] },
  };
  const secondFeature = {
    id: 'candidate-2',
    ordinal: 2,
    name: 'Example summit to keep',
    validationStatus: 'PENDING',
    geometry: { type: 'Point', coordinates: [7.3, 46.2] },
  };
  const thirdFeature = {
    id: 'candidate-3',
    ordinal: 3,
    name: 'Example second summit to keep',
    validationStatus: 'PENDING',
    geometry: { type: 'Point', coordinates: [7.4, 46.3] },
  };
  let pendingCandidates = [
    firstFeature,
    secondFeature,
    thirdFeature,
    ...Array.from({ length: 256 }, (_, index) => ({
      id: `candidate-${index + 4}`,
      ordinal: index + 4,
      name: `Example summit ${index + 4}`,
      validationStatus: 'PENDING',
      geometry: {
        type: 'Point',
        coordinates: [7.5 + index / 10_000, 46.2],
      },
    })),
  ];
  const expectedPromotedCandidateIds = pendingCandidates
    .slice(1)
    .map((candidate) => candidate.id);
  const rejectionRequests: Array<{ body: unknown; key: string }> = [];
  const promotionRequests: Array<{ body: unknown; key: string }> = [];

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-import-access-token',
          refreshToken: 'admin-geodata-import-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'geodata-importer-1',
          email: 'geodata-importer@example.test',
          displayName: 'Geodata Importer',
          scopes: ['geodata.import'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({
        json: {
          items: [
            {
              code: 'SOTA',
              label: 'Summits on the Air',
              active: true,
              geometryTypes: ['POINT'],
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/imports' && method === 'GET') {
      const items = importRequests.length ? [run] : [];
      await route.fulfill({
        json: {
          items,
          page: 1,
          pageSize: 10,
          total: items.length,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/imports' && method === 'POST') {
      importRequests.push({
        body: request.postDataJSON() as Record<string, any>,
        key: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({ status: 201, json: run });
      return;
    }

    if (url.pathname === '/v1/geodata/imports/import-1/candidates') {
      const requestedPage = Number(url.searchParams.get('page') || 1);
      const requestedPageSize = Number(url.searchParams.get('pageSize') || 20);
      const offset = (requestedPage - 1) * requestedPageSize;
      await route.fulfill({
        json: {
          items: pendingCandidates.slice(offset, offset + requestedPageSize),
          page: requestedPage,
          pageSize: requestedPageSize,
          total: pendingCandidates.length,
          nextPage:
            offset + requestedPageSize < pendingCandidates.length
              ? requestedPage + 1
              : null,
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/imports/import-1/candidates/validate' &&
      method === 'POST'
    ) {
      const body = request.postDataJSON() as { candidateIds: string[] };
      rejectionRequests.push({
        body,
        key: request.headers()['idempotency-key'] || '',
      });
      pendingCandidates = pendingCandidates.filter(
        (candidate) => !body.candidateIds.includes(candidate.id),
      );
      await route.fulfill({
        json: {
          importRunId: 'import-1',
          candidateIds: body.candidateIds,
          validationStatus: 'REJECTED',
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/imports/import-1/process' &&
      method === 'POST'
    ) {
      const body = request.postDataJSON() as { candidateIds: string[] };
      promotionRequests.push({
        body,
        key: request.headers()['idempotency-key'] || '',
      });
      pendingCandidates = pendingCandidates.filter(
        (candidate) => !body.candidateIds.includes(candidate.id),
      );
      await route.fulfill({
        json: {
          importRunId: 'import-1',
          candidateIds: body.candidateIds,
          targetStatus: 'CANDIDATE',
          requestedBy: 'geodata-importer-1',
          status: 'COMPLETED',
          created: body.candidateIds.map((id) => `entity-${id}`),
          updated: [],
          completedAt: '2026-10-23T12:00:00.000000Z',
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/imports/import-1') {
      await route.fulfill({
        json: { ...run, pendingCount: pendingCandidates.length },
      });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/geodata-imports');
  await expect(page).toHaveURL(/\/login\?redirect=\/geodata-imports$/);
  await page.getByLabel('Email').fill('geodata-importer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/geodata-imports$/);

  await page.getByLabel('Feature category').selectOption('SOTA');
  await page.getByLabel('Source label').fill('Alpine manual source');
  await page.getByLabel('Licence').fill('CC BY 4.0');
  await page.getByLabel('Attribution').fill('Local mapping group');
  await page.getByLabel('Source filename').fill('summits.geojson');
  await page.getByLabel('Paste source document').fill(
    JSON.stringify({
      type: 'FeatureCollection',
      features: pendingCandidates.map((candidate) => ({
        type: 'Feature',
        properties: { name: candidate.name },
        geometry: candidate.geometry,
      })),
    }),
  );
  await page.getByRole('button', { name: 'Queue preprocessing' }).click();

  await expect(
    page.getByText('Dataset queued for preprocessing.'),
  ).toBeVisible();
  await expect(page.getByText('Review pre-processed records')).toBeVisible();
  await expect(
    page.getByRole('button', { name: firstFeature.name }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: secondFeature.name }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: thirdFeature.name }),
  ).toBeVisible();
  await page.getByRole('button', { name: firstFeature.name }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('PENDING');
  await dialog.getByRole('button', { name: 'Reject entity' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    `Next item: ${secondFeature.name}.`,
  );
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Select all pending records').check();
  await expect(
    page.getByText('258 pending records selected across all pages.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Promote selected to candidate' })
    .click();
  await expect(
    page.getByText('258 records were promoted to candidate successfully.'),
  ).toBeVisible();

  expect(importRequests).toHaveLength(1);
  expect(importRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(importRequests[0].body).toMatchObject({
    adapter: 'MANUAL',
    format: 'GEOJSON',
    entityTypes: ['SOTA'],
    filename: 'summits.geojson',
    content: expect.stringContaining('Example summit to reject'),
    source: {
      name: 'Alpine manual source',
      license: 'CC BY 4.0',
      attribution: 'Local mapping group',
    },
  });
  expect(rejectionRequests).toHaveLength(1);
  expect(rejectionRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(rejectionRequests[0].body).toEqual({
    candidateIds: ['candidate-1'],
    validationStatus: 'REJECTED',
    reviewerId: 'geodata-importer-1',
  });
  expect(promotionRequests).toHaveLength(1);
  expect(promotionRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(promotionRequests[0].body).toEqual({
    candidateIds: expectedPromotedCandidateIds,
    targetStatus: 'CANDIDATE',
    processorId: 'geodata-importer-1',
  });
});

test('suggests a non-reserving manual entity ID and submits the chosen assignment', async ({
  page,
}) => {
  const suggestionRequests: unknown[] = [];
  const promotionRequests: Array<Record<string, unknown>> = [];
  const run = {
    id: 'import-manual-id',
    programmeSlug: 'judicial',
    filename: 'district.geojson',
    status: 'PREPROCESSED',
    adapter: 'MANUAL',
    format: 'GEOJSON',
    candidateCount: 1,
    pendingCount: 1,
  };
  const candidate = {
    id: 'candidate-manual-id',
    programmeSlug: 'judicial',
    ordinal: 1,
    name: 'Test judicial district',
    validationStatus: 'PENDING',
    geometry: { type: 'Point', coordinates: [-3.7, 40.4] },
  };
  let importCreated = false;
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-geodata-import-access-token',
          refreshToken: 'admin-geodata-import-refresh-token',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'geodata-importer-1',
          email: 'geodata-importer@example.test',
          displayName: 'Geodata Importer',
          scopes: ['geodata.import'],
        },
      });
      return;
    }
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'judicial',
              name: 'Judicial districts',
              entityNumbering: {
                identifier: 'PJE',
                qualifierMode: 'MANUAL',
                serialWidth: 4,
                assignmentMode: 'MANUAL',
              },
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/entity-types') {
      await route.fulfill({
        json: {
          items: [
            {
              code: 'JUDICIAL_DISTRICT',
              label: 'Judicial district',
              active: true,
              geometryTypes: ['POINT'],
            },
          ],
        },
      });
      return;
    }
    if (url.pathname === '/v1/geodata/imports' && method === 'GET') {
      const items = importCreated ? [run] : [];
      await route.fulfill({
        json: { items, total: items.length, nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/geodata/imports' && method === 'POST') {
      importCreated = true;
      await route.fulfill({ status: 202, json: run });
      return;
    }
    if (url.pathname === '/v1/geodata/imports/import-manual-id/candidates') {
      await route.fulfill({
        json: { items: [candidate], total: 1, nextPage: null },
      });
      return;
    }
    if (url.pathname.endsWith('/entity-id-suggestion') && method === 'POST') {
      suggestionRequests.push(request.postDataJSON());
      await route.fulfill({
        json: {
          entityIdentifier: 'PJE-DISTRICT-0007',
          serial: 7,
          paddedSerial: '0007',
          qualifier: 'DISTRICT',
          assigned: false,
          reserved: false,
        },
      });
      return;
    }
    if (
      url.pathname === '/v1/geodata/imports/import-manual-id/process' &&
      method === 'POST'
    ) {
      promotionRequests.push(request.postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        json: {
          importRunId: run.id,
          candidateIds: [candidate.id],
          targetStatus: 'CANDIDATE',
          status: 'COMPLETED',
          created: ['entity-1'],
          updated: [],
        },
      });
      return;
    }
    if (url.pathname === `/v1/geodata/imports/${run.id}`) {
      await route.fulfill({ json: run });
      return;
    }
    await route.fulfill({ json: { items: [], total: 0, nextPage: null } });
  });

  await page.goto('/geodata-imports');
  await expect(page).toHaveURL(/\/login\?redirect=\/geodata-imports$/);
  await page.getByLabel('Email').fill('geodata-importer@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/geodata-imports$/);

  await page.getByLabel('Feature category').selectOption('JUDICIAL_DISTRICT');
  await page
    .getByLabel('Assign to programme (optional)')
    .selectOption('judicial');
  await page.getByLabel('Source label').fill('Browser manual ID fixture');
  await page.getByLabel('Licence').fill('CC BY 4.0');
  await page.getByLabel('Attribution').fill('Synthetic browser test');
  await page.getByLabel('Source filename').fill('district.geojson');
  await page.getByLabel('Paste source document').fill(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: candidate.name },
          geometry: candidate.geometry,
        },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Queue preprocessing' }).click();
  await expect(page.getByText('Review pre-processed records')).toBeVisible();
  await page
    .getByLabel('Entity ID qualifier for Test judicial district')
    .fill('District');
  await page.getByRole('button', { name: 'Suggest next free serial' }).click();
  await expect(
    page.getByText(
      'Suggested ID: PJE-DISTRICT-0007 (not reserved until promotion)',
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel('Entity ID serial for Test judicial district'),
  ).toHaveValue('7');
  await page.getByLabel('Select Test judicial district').check();
  await page
    .getByRole('button', { name: 'Promote selected to candidate' })
    .click();
  await expect(
    page.getByText('1 records were promoted to candidate successfully.'),
  ).toBeVisible();
  expect(suggestionRequests).toEqual([{ qualifier: 'District' }]);
  expect(promotionRequests[0]).toMatchObject({
    candidateIds: [candidate.id],
    manualAssignments: {
      [candidate.id]: { qualifier: 'District', serial: '7' },
    },
  });
});
