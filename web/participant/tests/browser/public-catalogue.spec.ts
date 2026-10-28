import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

const programmes = [
  {
    slug: 'alpine',
    name: 'Alpine Summits',
    description: 'Radio from the high country.',
    theme: { primary: '#2367a8', accent: '#e38a32' },
    rules: {
      minimumQsos: { activation: 4, hunter: 1 },
      publicAccessRequired: true,
    },
    entityTypes: [
      { code: 'SOTA', name: 'Summit', geometryTypes: ['POINT'] },
      { code: 'TRAIL', name: 'Trail', geometryTypes: ['LINESTRING'] },
    ],
  },
  {
    slug: 'coast',
    name: 'Coastal Parks',
    description: 'Radio from protected shorelines.',
    theme: { primary: '#176f72', accent: '#efb04d' },
    rules: {
      minimumQsos: { activation: 3, hunter: 1 },
      publicAccessRequired: false,
    },
    entityTypes: [
      { code: 'PARK', name: 'Coastal park', geometryTypes: ['POINT'] },
    ],
  },
];

test('selects a programme and renders its public content and entity catalogue', async ({
  page,
}) => {
  const entityRequests: string[] = [];
  const proposalRequests: Array<{
    body: unknown;
    idempotencyKey: string;
  }> = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: programmes, nextPage: null },
      });
      return;
    }

    if (url.pathname.endsWith('/content')) {
      const slug = url.pathname.split('/')[4];
      await route.fulfill({
        json: {
          items: [
            { key: 'eligibility', locale: 'en', value: `${slug} eligibility` },
            {
              key: 'eligibility',
              locale: 'fr',
              value: `${slug} admissibilite`,
            },
          ],
        },
      });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      const slug = url.searchParams.get('programme') || '';
      entityRequests.push(slug);
      await route.fulfill({
        json: {
          items: [
            {
              id: `${slug}-entity-1`,
              name: `${slug} reference site`,
              entityType: slug === 'alpine' ? 'SOTA' : 'PARK',
              status: 'APPROVED',
              provenance: { adapter: 'programme catalogue' },
              geometry: { type: 'Point', coordinates: [7, 46] },
            },
            {
              id: `${slug}-entity-2`,
              name: `${slug} candidate site`,
              entityType: slug === 'alpine' ? 'SOTA' : 'PARK',
              status: 'CANDIDATE',
              provenance: { adapter: 'community proposal' },
              geometry: { type: 'Point', coordinates: [7.1, 46.1] },
            },
          ],
          page: 1,
          total: 2,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-proposal-access-token',
          refreshToken: 'participant-proposal-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          email: 'operator@example.test',
          displayName: 'Operator One',
          callsigns: [],
        },
      });
      return;
    }

    if (
      url.pathname === '/v1/geodata/proposals' &&
      request.method() === 'POST'
    ) {
      proposalRequests.push({
        body: request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'] || '',
      });
      await route.fulfill({ status: 201, json: { id: 'proposal-1' } });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await expect(page.locator('#programme-name')).toHaveText('Alpine Summits');
  await expect(page.locator('#entities')).toContainText(
    'alpine reference site',
  );
  await expect(page.locator('#entities')).toContainText(
    'alpine candidate site',
  );
  await expect(page.locator('#programme-content')).toContainText(
    'alpine eligibility',
  );
  await expect(page.locator('#programme-content')).not.toContainText(
    'alpine admissibilite',
  );

  await page.getByLabel('Programme').selectOption('coast');

  await expect(page.locator('#programme-name')).toHaveText('Coastal Parks');
  await expect(page.locator('#rules')).toContainText('Programme-defined');
  await expect(page.locator('#entities')).toContainText('coast reference site');
  await expect(page.locator('#programme-content')).toContainText(
    'coast eligibility',
  );

  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#profile-status')).toHaveText('Profile loaded.');
  await page.locator('button.propose[data-id="coast-entity-2"]').click();
  await expect(page.locator('#proposal-status')).toHaveText(
    'Proposal submitted for review.',
  );

  await page.getByRole('button', { name: 'Pick coordinates on map' }).click();
  await expect(
    page.getByRole('button', { name: 'Cancel map selection' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#map').scrollIntoViewIfNeeded();
  const mapBounds = await page.locator('#public-map-overlay').boundingBox();
  expect(mapBounds).not.toBeNull();
  await page.mouse.click(
    mapBounds!.x + mapBounds!.width / 2,
    mapBounds!.y + mapBounds!.height / 2,
  );
  await expect(page.locator('#proposal-status')).toContainText('Selected ');
  const latitude = Number(
    await page.locator('#proposal-latitude').inputValue(),
  );
  const longitude = Number(
    await page.locator('#proposal-longitude').inputValue(),
  );
  expect(latitude).toBeGreaterThanOrEqual(-90);
  expect(latitude).toBeLessThanOrEqual(90);
  expect(longitude).toBeGreaterThanOrEqual(-180);
  expect(longitude).toBeLessThanOrEqual(180);

  await page.locator('#proposal-name').fill('Map-picked shelter');
  await page.getByRole('button', { name: 'Submit location proposal' }).click();
  await expect(page.locator('#proposal-status')).toHaveText(
    'Proposal submitted for review.',
  );

  await page.getByRole('button', { name: 'Reset map view' }).click();
  expect(entityRequests).toEqual(['alpine', 'coast', 'coast', 'coast']);
  expect(proposalRequests).toHaveLength(2);
  expect(proposalRequests[0].idempotencyKey).not.toBe('');
  expect(proposalRequests[0].body).toMatchObject({
    programmeSlug: 'coast',
    entityTypes: ['PARK'],
    source: {
      name: 'Participant community proposal',
      license: 'programme-supplied',
    },
    feature: {
      type: 'Feature',
      properties: { name: 'coast candidate site' },
      geometry: { type: 'Point', coordinates: [7.1, 46.1] },
    },
  });
  expect(proposalRequests[1].idempotencyKey).not.toBe('');
  expect(proposalRequests[1].body).toMatchObject({
    programmeSlug: 'coast',
    entityTypes: ['PARK'],
    source: {
      name: 'Participant community proposal',
      license: 'programme-supplied',
    },
    feature: {
      type: 'Feature',
      properties: { name: 'Map-picked shelter' },
      geometry: {
        type: 'Point',
        coordinates: [longitude, latitude],
      },
    },
  });
  expect(pageErrors).toEqual([]);
  await expect(page).toHaveURL(/#coast$/);

  await expectResponsiveAccessible(page, 'Participant public catalogue');
});

test('recovers from unavailable programme and entity catalogues', async ({
  page,
}) => {
  let programmeReads = 0;
  let entityReads = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v1/programmes') {
      programmeReads += 1;
      if (programmeReads === 1) {
        await route.fulfill({
          status: 503,
          json: { message: 'catalogue temporarily unavailable' },
        });
        return;
      }
      await route.fulfill({ json: { items: programmes, nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      entityReads += 1;
      if (entityReads === 1 || entityReads === 3) {
        await route.fulfill({
          status: 503,
          json: { message: 'entity service temporarily unavailable' },
        });
        return;
      }
      await route.fulfill({
        json: {
          items: [
            {
              id: `${url.searchParams.get('programme')}-recovered-entity`,
              name: `${url.searchParams.get('programme')} recovered entity`,
              entityType:
                url.searchParams.get('programme') === 'alpine'
                  ? 'SOTA'
                  : 'PARK',
              status: 'APPROVED',
              geometry: { type: 'Point', coordinates: [7, 46] },
            },
          ],
          page: 1,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await expect(page.locator('#programme-status')).toContainText(
    'catalogue temporarily unavailable',
  );
  await page.getByRole('button', { name: 'Retry programme catalogue' }).click();
  await expect(page.locator('#programme-name')).toHaveText('Alpine Summits');
  await expect(page.locator('#loading')).toContainText(
    'entity catalogue is temporarily unavailable',
  );
  await expect(page.locator('#entities')).toBeEmpty();
  await expectResponsiveAccessible(page, 'Participant catalogue recovery');
  await page.getByRole('button', { name: 'Retry entity catalogue' }).click();
  await expect(page.locator('#entities')).toContainText(
    'alpine recovered entity',
  );
  await expect(page.locator('#entity-retry')).toBeHidden();

  await page.getByLabel('Programme').selectOption('coast');
  await expect(page.locator('#programme-name')).toHaveText('Coastal Parks');
  await expect(page.locator('#loading')).toContainText(
    'entity catalogue is temporarily unavailable',
  );
  await expect(page.locator('#entities')).toBeEmpty();
  await page.getByRole('button', { name: 'Retry entity catalogue' }).click();
  await expect(page.locator('#entities')).toContainText(
    'coast recovered entity',
  );
  expect(programmeReads).toBe(2);
  expect(entityReads).toBe(4);
  expect(pageErrors).toEqual([]);
});

test('shows live community activations, rankings, and programme exports', async ({
  page,
}, testInfo) => {
  const leaderboardCategories: string[] = [];
  let exportReads = 0;
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [programmes[0]], nextPage: null } });
      return;
    }
    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({ json: { items: [], page: 1, total: 0 } });
      return;
    }
    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === '/v1/public/activations') {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'public-activation-1',
              operatorCallsign: 'N0***L',
              status: 'CLOSED',
              qsoCount: 8,
              startedAt: '2026-10-28T09:30:00Z',
            },
          ],
          page: 1,
          pageSize: 5,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/public/results') {
      exportReads += 1;
      expect(url.searchParams.get('programme')).toBe('alpine');
      expect(url.searchParams.get('format')).toBe('csv');
      await route.fulfill({
        json: {
          format: 'csv',
          contentType: 'text/csv',
          downloadName: 'myota-results-alpine.csv',
          content: 'programme,entityId\nalpine,ALP-001\n',
        },
      });
      return;
    }
    if (url.pathname === '/v1/public/leaderboards') {
      const category = url.searchParams.get('category') || '';
      leaderboardCategories.push(category);
      await route.fulfill({
        json: {
          programme: url.searchParams.get('programme'),
          category,
          items: [
            {
              subject_id: 'private-subject-id-must-not-render',
              qso_count: category === 'HUNTER' ? 12 : 6,
              activation_count: 3,
              unique_call_sign_count: 4,
              unique_entity_count: 2,
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await expect(
    page.getByRole('navigation', { name: 'Participant navigation' }),
  ).toContainText('Explore');
  await expect(page.locator('#public-activations')).toContainText('N0***L');
  await expect(page.locator('#public-activations')).toContainText('8 QSOs');
  await expect(page.locator('#public-leaderboard')).toContainText('Hunter 1');
  await expect(page.locator('#public-leaderboard')).toContainText('12 QSOs');
  await expect(page.locator('#public-leaderboard')).not.toContainText(
    'private-subject-id-must-not-render',
  );

  await page.getByLabel('Rankings for').selectOption('ACTIVATOR');
  await expect(page.locator('#leaderboard-heading')).toHaveText(
    'Top activators',
  );
  await expect(page.locator('#public-leaderboard')).toContainText('6 QSOs');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#public-results-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('myota-results-alpine.csv');
  await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
  await expect(page.locator('#public-results-status')).toContainText(
    'Downloaded myota-results-alpine.csv',
  );
  expect(exportReads).toBe(1);
  expect(
    await readFile(testInfo.outputPath(download.suggestedFilename()), 'utf8'),
  ).toBe('programme,entityId\nalpine,ALP-001\n');
  expect(leaderboardCategories).toEqual(['HUNTER', 'ACTIVATOR']);
  await expectResponsiveAccessible(page, 'Participant community workspace');
});
