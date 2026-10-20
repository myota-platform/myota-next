import { expect, test } from '@playwright/test';

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
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
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
  await page.getByRole('button', { name: 'Reset map view' }).click();
  expect(entityRequests).toEqual(['alpine', 'coast']);
  expect(pageErrors).toEqual([]);
  await expect(page).toHaveURL(/#coast$/);
});
