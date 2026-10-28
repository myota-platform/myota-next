import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('queues broad award progress recalculation and shows terminal job state', async ({
  page,
}) => {
  const requests: Array<{
    method: string;
    body?: Record<string, unknown>;
    key?: string;
  }> = [];
  const statusReads: Record<string, number> = {};
  const award = {
    id: 'award-live-1',
    programmeSlug: 'alpine',
    code: 'ALPINE-LIVE',
    name: 'Alpine award',
    category: 'HUNTER',
    status: 'PUBLISHED',
    version: 3,
    condition: {},
    levels: [],
    template: { elements: [] },
  };

  page.on('dialog', (dialog) => dialog.accept());
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({ json: { accessToken: 'award-admin-token' } });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'award-admin',
          email: 'award-admin@example.test',
          displayName: 'Award Admin',
          scopes: ['awards.admin'],
        },
      });
      return;
    }
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: [{ slug: 'alpine', name: 'Alpine' }], nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/awards' && method === 'GET') {
      await route.fulfill({
        json: {
          items: [award],
          page: 1,
          pageSize: 50,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/awards/award-live-1' && method === 'GET') {
      await route.fulfill({ json: award });
      return;
    }
    if (url.pathname === '/v1/awards/assets') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }
    if (
      url.pathname === '/v1/awards/requests' ||
      url.pathname === '/v1/awards/issuances'
    ) {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0 },
      });
      return;
    }
    if (
      url.pathname === '/v1/awards/award-live-1/recalculation-jobs' &&
      method === 'POST'
    ) {
      requests.push({
        method,
        body: request.postDataJSON() as Record<string, unknown>,
        key: request.headers()['idempotency-key'],
      });
      const jobId = `award-job-${requests.length}`;
      await route.fulfill({
        status: 202,
        json: {
          awardId: award.id,
          jobId,
          status: 'QUEUED',
          attempts: 0,
        },
      });
      return;
    }
    if (
      url.pathname.startsWith('/v1/awards/award-live-1/recalculation-jobs/')
    ) {
      const jobId = url.pathname.split('/').at(-1)!;
      statusReads[jobId] = (statusReads[jobId] || 0) + 1;
      const failed = jobId === 'award-job-2';
      await route.fulfill({
        json: {
          id: jobId,
          status: failed
            ? 'FAILED'
            : statusReads[jobId] === 1
              ? 'RUNNING'
              : 'SUCCEEDED',
          attempts: failed ? 2 : 1,
          lastError: failed ? 'award worker rejected the queued job' : null,
          completedAt:
            failed || statusReads[jobId] > 1
              ? '2026-10-23T10:00:00.000Z'
              : null,
        },
      });
      return;
    }
    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/awards');
  await page.getByLabel('Email').fill('award-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/awards$/);
  await page.getByRole('button', { name: /Alpine award/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Participant progress' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recalculate all progress' }).click();
  await expect(page.getByText('QUEUED', { exact: true })).toBeVisible();
  const announcement = page.locator('.award-recalculation-message');
  await expect(announcement).toHaveAttribute('role', 'status');
  await expect(announcement).toHaveAttribute('aria-live', 'polite');
  await expect(announcement).toHaveAttribute('aria-atomic', 'true');
  await expect(announcement).toHaveText(
    'Request accepted; recalculation is queued.',
  );
  await expect.poll(() => requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    method: 'POST',
    body: { subjectIds: [] },
  });
  expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('RUNNING', { exact: true })).toBeVisible();
  await expect(announcement).toHaveText('Recalculation is in progress.');
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('SUCCEEDED', { exact: true })).toBeVisible();
  await expect(announcement).toHaveText('Recalculation completed.');

  await page.getByRole('button', { name: 'Recalculate all progress' }).click();
  await expect(announcement).toHaveText(
    'Request accepted; recalculation is queued.',
  );
  await expect.poll(() => requests).toHaveLength(2);
  expect(requests[1].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(requests[1].key).not.toBe(requests[0].key);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('FAILED', { exact: true })).toBeVisible();
  await expect(announcement).toHaveText('Recalculation failed.');
  await expect(page.getByRole('alert')).toContainText(
    'award worker rejected the queued job',
  );
  await expect(
    page.getByRole('button', { name: 'Recalculate all progress' }),
  ).toBeEnabled();
  await expectResponsiveAccessible(
    page,
    'Admin broad award recalculation failure and retry',
  );
});

test('validates award JSON locally with accessible field-specific feedback', async ({
  page,
}) => {
  const createRequests: unknown[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({ json: { accessToken: 'award-admin-token' } });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'award-admin',
          email: 'award-admin@example.test',
          displayName: 'Award Admin',
          scopes: ['awards.admin'],
        },
      });
      return;
    }
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: [{ slug: 'alpine', name: 'Alpine' }], nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/awards' && request.method() === 'GET') {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0, nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/awards/assets') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }
    if (
      url.pathname === '/v1/awards/requests' ||
      url.pathname === '/v1/awards/issuances'
    ) {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0 },
      });
      return;
    }
    if (url.pathname === '/v1/awards' && request.method() === 'POST') {
      createRequests.push(request.postDataJSON());
      await route.fulfill({ status: 201, json: { id: 'unexpected' } });
      return;
    }
    await route.fulfill({ json: { items: [], page: 1, total: 0 } });
  });

  await page.goto('/awards');
  await page.getByLabel('Email').fill('award-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/awards$/);
  await expect(
    page.getByRole('link', {
      name: 'Award JSON reference (opens in a new tab)',
    }),
  ).toHaveAttribute('href', '/award-configuration-reference.html');
  await page.getByRole('button', { name: 'New award draft' }).click();
  await page.getByLabel('Code').fill('ALPINE-10');
  await page.getByLabel('Name', { exact: true }).fill('Alpine Ten');
  const invalidCondition =
    '{"kind":"QSO_COUNT","operator":"GTE","value":"many"}';
  await page.getByLabel('Condition JSON').fill(invalidCondition);
  await page.getByRole('button', { name: 'Save award draft' }).click();

  const validation = page.getByRole('alert').filter({
    hasText: 'Check these award configuration fields before saving:',
  });
  await expect(validation).toContainText(
    'Condition JSON (value): must be a finite number',
  );
  await expect(validation.getByRole('link')).toHaveAttribute(
    'href',
    '#award-condition',
  );
  await expect(page.locator('#award-condition')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.locator('#award-condition')).toHaveValue(invalidCondition);
  expect(createRequests).toHaveLength(0);
  await expectResponsiveAccessible(page, 'Admin award JSON validation');
});

test('serves the readable award JSON reference without horizontal page overflow', async ({
  page,
}) => {
  await page.goto('/award-configuration-reference.html');
  await expect(
    page.getByRole('heading', { name: 'Award JSON configuration' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Condition kinds' }),
  ).toBeVisible();
  await expect(page.locator('#canonical-award-example')).toContainText(
    'FIELD-DAY-10',
  );
  await expectResponsiveAccessible(page, 'Award JSON configuration reference');
});

test('saves an award draft and submits it for review', async ({ page }) => {
  const saveRequests: Array<{ body: Record<string, any>; key: string }> = [];
  const actionRequests: unknown[] = [];
  let award: Record<string, any> | null = null;
  let failFirstSave = true;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'admin-awards-access-token',
          refreshToken: 'admin-awards-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'awards-admin-1',
          email: 'awards-admin@example.test',
          displayName: 'Awards Admin',
          scopes: ['awards.admin'],
        },
      });
      return;
    }

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [{ slug: 'alpine', name: 'Alpine Summits', description: '' }],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/awards' && method === 'GET') {
      await route.fulfill({
        json: {
          items: award ? [award] : [],
          page: 1,
          pageSize: 50,
          total: award ? 1 : 0,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/awards/assets') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }

    if (url.pathname === '/v1/awards/requests') {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/awards/issuances') {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0, nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/awards' && method === 'POST') {
      saveRequests.push({
        body: body as Record<string, any>,
        key: request.headers()['idempotency-key'] || '',
      });
      award = {
        ...(body as Record<string, unknown>),
        id: 'award-1',
        status: 'DRAFT',
      };
      if (failFirstSave) {
        failFirstSave = false;
        await route.fulfill({
          status: 503,
          json: { message: 'temporary award save response failure' },
        });
        return;
      }
      await route.fulfill({ status: 201, json: award });
      return;
    }

    if (url.pathname === '/v1/awards/award-1' && method === 'GET') {
      await route.fulfill({ json: award });
      return;
    }

    if (url.pathname === '/v1/awards/award-1' && method === 'PATCH') {
      actionRequests.push(body);
      award = { ...award, ...(body as Record<string, unknown>) };
      await route.fulfill({ json: award });
      return;
    }

    await route.fulfill({
      json: { items: [], page: 1, total: 0, nextPage: null },
    });
  });

  await page.goto('/awards');
  await expect(page).toHaveURL(/\/login\?redirect=\/awards$/);
  await page.getByLabel('Email').fill('awards-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/awards$/);

  await page.getByLabel('Code', { exact: true }).fill('ALPINE-10');
  await page.getByLabel('Name', { exact: true }).fill('Alpine Ten Contacts');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Complete ten eligible contacts.');
  await page.getByRole('button', { name: 'Save award draft' }).click();
  await expect(
    page.getByText('temporary award save response failure'),
  ).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/awards$/);
  await page.getByLabel('Code', { exact: true }).fill('ALPINE-10');
  await page.getByLabel('Name', { exact: true }).fill('Alpine Ten Contacts');
  await page
    .getByLabel('Description', { exact: true })
    .fill('Complete ten eligible contacts.');
  await page.getByRole('button', { name: 'Save award draft' }).click();

  await expect(page.getByText('Award draft saved.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Submit for review' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('status')).toHaveText('Award submitted.');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  await page.getByLabel('Effective from (UTC)').fill('2026-10-21T12:00');
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Award published.')).toBeVisible();

  expect(saveRequests).toHaveLength(2);
  expect(saveRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(saveRequests[1].key).toBe(saveRequests[0].key);
  expect(saveRequests[1].body).toEqual(saveRequests[0].body);
  expect(saveRequests[0].body).toMatchObject({
    programmeSlug: 'alpine',
    code: 'ALPINE-10',
    name: 'Alpine Ten Contacts',
    category: 'HUNTER',
    achievementMetric: 'QSO_COUNT',
    condition: {
      kind: 'AND',
      conditions: [{ kind: 'QSO_COUNT', operator: 'GTE', value: 10 }],
    },
    levels: [{ id: 'level-10', name: '10 contacts', threshold: 10 }],
  });
  expect(actionRequests).toEqual([
    { status: 'UNDER_REVIEW', submitterId: 'awards-admin-1' },
    {
      status: 'APPROVED',
      reviewerId: 'awards-admin-1',
    },
    {
      status: 'PUBLISHED',
      effectiveFrom: '2026-10-21T12:00:00.000Z',
      publisherId: 'awards-admin-1',
    },
  ]);
});

test('creates a version from a published award and derives landscape print dimensions', async ({
  page,
}) => {
  const published = {
    id: 'award-published-1',
    programmeSlug: 'alpine',
    code: 'ALPINE-10',
    name: 'Alpine Ten',
    description: 'Original description',
    awardText: '',
    category: 'HUNTER',
    status: 'PUBLISHED',
    version: 2,
    achievementMetric: 'QSO_COUNT',
    condition: { kind: 'QSO_COUNT', operator: 'GTE', value: 10 },
    levels: [{ id: 'level-10', name: 'Ten contacts', threshold: 10 }],
    backgroundAsset: {
      id: 'background-1',
      kind: 'BACKGROUND',
      name: 'Alpine background',
      objectKey: 'awards/alpine.png',
      mediaType: 'image/png',
      widthPx: 1200,
      heightPx: 800,
    },
    printSpec: { page: 'A4', orientation: 'PORTRAIT', dpi: 300 },
    template: {
      elements: [
        { kind: 'AWARD_NAME', x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
        { kind: 'CALLSIGN', x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
        { kind: 'PERSON_NAME', x: 0.1, y: 0.3, width: 0.8, height: 0.1 },
        { kind: 'DATE_OBTAINED', x: 0.1, y: 0.4, width: 0.8, height: 0.1 },
        { kind: 'MANAGER_NAME', x: 0.1, y: 0.5, width: 0.8, height: 0.1 },
        { kind: 'MANAGER_SIGNATURE', x: 0.1, y: 0.6, width: 0.8, height: 0.1 },
      ],
    },
    signatureAssetId: null,
    managerName: 'Award Manager',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
  };
  let revision: Record<string, unknown> | null = null;
  let revisionRequest: Record<string, any> | null = null;
  let saveAttempts = 0;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'award-admin-token',
          refreshToken: 'refresh-token',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'award-admin-1',
          email: 'award-admin@example.test',
          displayName: 'Award Admin',
          scopes: ['awards.admin'],
        },
      });
      return;
    }
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: { items: [{ slug: 'alpine', name: 'Alpine' }], nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/awards' && method === 'GET') {
      await route.fulfill({
        json: {
          items: [published],
          page: 1,
          pageSize: 50,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/awards/assets') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }
    if (
      url.pathname === '/v1/awards/requests' ||
      url.pathname === '/v1/awards/issuances'
    ) {
      await route.fulfill({
        json: { items: [], page: 1, pageSize: 50, total: 0, nextPage: null },
      });
      return;
    }
    if (url.pathname === `/v1/awards/${published.id}` && method === 'GET') {
      await route.fulfill({ json: published });
      return;
    }
    if (url.pathname === `/v1/awards/${published.id}` && method === 'PATCH') {
      revisionRequest = request.postDataJSON() as Record<string, any>;
      saveAttempts += 1;
      if (saveAttempts === 1) {
        await route.fulfill({
          status: 400,
          json: {
            statusCode: 400,
            message: 'choose a registered background asset',
          },
        });
        return;
      }
      if (saveAttempts === 2) {
        await route.fulfill({
          status: 409,
          json: {
            statusCode: 409,
            message: 'award changed since it was loaded; reload before editing',
          },
        });
        return;
      }
      revision = {
        ...published,
        ...revisionRequest,
        id: 'award-version-3',
        version: 3,
        status: 'DRAFT',
      };
      await route.fulfill({ status: 201, json: revision });
      return;
    }
    if (url.pathname === '/v1/awards/award-version-3' && method === 'GET') {
      await route.fulfill({ json: revision });
      return;
    }
    await route.fulfill({ json: { items: [], page: 1, total: 0 } });
  });

  await page.goto('/awards');
  await page.getByLabel('Email').fill('award-admin@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: /Alpine Ten/ }).click();
  await expect(page.getByText(/This award version is read-only/)).toBeVisible();
  await page.getByRole('button', { name: 'Create editable version' }).click();
  const awardForm = page.locator('form.form-grid').first();
  const pageSize = awardForm.locator('select').nth(3);
  const orientation = awardForm.locator('select').nth(4);
  const backgroundWidth = page.getByLabel('Print background width (pixels)');
  const backgroundHeight = page.getByLabel('Print background height (pixels)');
  await expect(backgroundWidth).toHaveValue('2481');
  await expect(backgroundHeight).toHaveValue('3508');
  await pageSize.selectOption('LETTER');
  await expect(backgroundWidth).toHaveValue('2550');
  await expect(backgroundHeight).toHaveValue('3300');
  await orientation.selectOption('LANDSCAPE');
  await expect(backgroundWidth).toHaveValue('3300');
  await expect(backgroundHeight).toHaveValue('2550');
  await pageSize.selectOption('A4');
  await expect(backgroundWidth).toHaveValue('3508');
  await expect(backgroundHeight).toHaveValue('2481');
  await page.getByLabel('Award Text').fill('For ten successful contacts');
  const saveButton = page.getByRole('button', {
    name: 'Save new version as draft',
  });
  await saveButton.click();
  await expect(page.getByRole('alert')).toHaveText(
    'choose a registered background asset',
  );
  await saveButton.click();
  await expect(page.getByRole('alert')).toHaveText(
    'award changed since it was loaded; reload before editing',
  );
  await saveButton.click();
  await expect(
    page.getByText('Award version 3 saved as a draft.'),
  ).toBeVisible();
  expect(revisionRequest).toMatchObject({
    expectedVersion: 2,
    programmeSlug: 'alpine',
    code: 'ALPINE-10',
    awardText: 'For ten successful contacts',
    description: 'Original description',
    printSpec: { page: 'A4', orientation: 'LANDSCAPE', dpi: 300 },
    backgroundAsset: {
      objectKey: 'awards/alpine.png',
      widthPx: 3508,
      heightPx: 2481,
    },
    template: {
      elements: expect.arrayContaining([
        expect.objectContaining({ kind: 'AWARD_TEXT', y: 0.21 }),
      ]),
    },
  });
  await expect(
    page.getByRole('button', { name: 'Submit for review' }),
  ).toBeVisible();
  await expectResponsiveAccessible(page, 'editing a published award version');
});
