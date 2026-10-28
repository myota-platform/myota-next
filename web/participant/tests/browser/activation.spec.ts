import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

test('signs in, records an activation contact, and closes the activation', async ({
  page,
}) => {
  const activationPayloads: unknown[] = [];
  const qsoPayloads: unknown[] = [];
  const closePayloads: unknown[] = [];
  const adifPayloads: unknown[] = [];
  const profilePayloads: unknown[] = [];
  const authenticatedRequests: string[] = [];
  let adifSubmissionCount = 0;
  const adifStatusReads = new Map<string, number>();
  let activation: {
    id: string;
    operatorCallsign: string;
    status: 'OPEN' | 'CLOSED';
    qsoCount: number;
    startedAt: string;
  } | null = null;

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (
      url.pathname === '/v1/identity/me' ||
      url.pathname.startsWith('/v1/activations')
    )
      authenticatedRequests.push(
        request.headers().authorization || 'missing authorization',
      );

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
              theme: { primary: '#2367a8', accent: '#e38a32' },
              rules: {
                minimumQsos: { activation: 4, hunter: 1 },
                publicAccessRequired: true,
                requireLocation: true,
              },
              entityTypes: [{ code: 'SOTA', name: 'Summit' }],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'summit-1',
              name: 'Example Summit',
              entityType: 'SOTA',
              status: 'APPROVED',
              centroid: { lat: 46.1, lon: 7.2 },
              geometry: { type: 'Point', coordinates: [7.2, 46.1] },
            },
          ],
          page: 1,
          total: 1,
          nextPage: null,
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-browser-access-token',
          refreshToken: 'participant-browser-refresh-token',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          email: 'operator@example.test',
          callsigns: [
            { id: 'callsign-1', value: 'DL1ABC', status: 'VERIFIED' },
          ],
          primaryCallsignId: 'callsign-1',
        },
      });
      return;
    }

    if (url.pathname === '/v1/identity/me/profile' && method === 'PATCH') {
      profilePayloads.push(body);
      await route.fulfill({ json: body });
      return;
    }

    if (url.pathname === '/v1/activations' && method === 'GET') {
      await route.fulfill({
        json: { items: activation ? [activation] : [], nextPage: null },
      });
      return;
    }

    if (url.pathname === '/v1/activations' && method === 'POST') {
      activationPayloads.push(body);
      activation = {
        id: 'activation-1',
        operatorCallsign: 'DL1ABC',
        status: 'OPEN',
        qsoCount: 0,
        startedAt: (body as { startedAt: string }).startedAt,
      };
      await route.fulfill({ status: 201, json: activation });
      return;
    }

    if (url.pathname === '/v1/activations/activation-1/qsos') {
      qsoPayloads.push(body);
      if (activation) activation.qsoCount += 1;
      await route.fulfill({ status: 201, json: { id: 'qso-1' } });
      return;
    }

    if (url.pathname === '/v1/adif/imports' && method === 'POST') {
      adifPayloads.push(body);
      adifSubmissionCount += 1;
      await route.fulfill({
        status: 202,
        json: { id: `adif-import-${adifSubmissionCount}` },
      });
      return;
    }

    if (
      url.pathname === '/v1/adif/imports/adif-import-1' ||
      url.pathname === '/v1/adif/imports/adif-import-2'
    ) {
      const importId = url.pathname.split('/').at(-1)!;
      const reads = (adifStatusReads.get(importId) || 0) + 1;
      adifStatusReads.set(importId, reads);
      const status =
        importId === 'adif-import-2'
          ? 'COMPLETED'
          : reads === 1
            ? 'PROCESSING'
            : 'FAILED';
      await route.fulfill({
        json: {
          id: importId,
          filename: importId === 'adif-import-1' ? 'first.adi' : 'retry.adi',
          status,
          recordsSeen: 1,
          recordsAccepted: status === 'COMPLETED' ? 1 : 0,
          recordsRejected: status === 'COMPLETED' ? 0 : 1,
          errors:
            status === 'FAILED'
              ? ['record 1: unsupported QSO date', 'record 2: invalid band']
              : [],
        },
      });
      return;
    }

    if (url.pathname === '/v1/activations/activation-1' && method === 'PATCH') {
      closePayloads.push(body);
      if (activation) activation.status = 'CLOSED';
      await route.fulfill({ json: activation });
      return;
    }

    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('http://127.0.0.1:8091');
  await expect(page.locator('#activation-start-form')).toBeHidden();
  await expect(page.locator('#qso-form')).toBeHidden();
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();

  await expect(page.locator('#activation-start-form')).toBeVisible();
  await page.locator('#activation-entity').selectOption('summit-1');
  await page.getByLabel('Operator callsign').selectOption('callsign-1');
  await page.getByRole('button', { name: 'Start activation' }).click();
  await expect(page.locator('#activation-status')).toHaveText(
    'Activation started.',
  );
  await expect(page.locator('#qso-form')).toBeVisible();

  await page.getByLabel('Worked callsign').fill('F4XYZ');
  await page.getByLabel('Band').fill('20M');
  await page.getByLabel('Mode').fill('SSB');
  await page.getByRole('button', { name: 'Record contact' }).click();
  await expect(page.locator('#activation-status')).toHaveText(
    'Contact recorded.',
  );

  const importStatus = page.locator('#adif-import-status');
  await expect(importStatus).toHaveAttribute('role', 'status');
  await expect(importStatus).toHaveAttribute('aria-live', 'polite');
  await page.locator('#adif-file').setInputFiles({
    name: 'first.adi',
    mimeType: 'text/plain',
    buffer: Buffer.from('<ADIF_VER:5>3.1.4<EOH><EOR>'),
  });
  await page.locator('#adif-file').focus();
  await page.keyboard.press('Tab');
  const importButton = page.getByRole('button', { name: 'Import ADIF log' });
  await expect(importButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#adif-import-status')).toHaveText(
    'first.adi: PROCESSING · 0 accepted, 1 rejected',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh import status' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Refresh import status' }).click();
  await expect(page.locator('#adif-import-status')).toHaveText(
    'first.adi: FAILED · 0 accepted, 1 rejected · record 1: unsupported QSO date · 1 more errors',
  );
  await expect(
    page.getByRole('button', { name: 'Refresh import status' }),
  ).toBeHidden();
  await expectResponsiveAccessible(
    page,
    'Participant failed ADIF import announcement and recovery',
  );

  await page.locator('#adif-file').setInputFiles({
    name: 'retry.adi',
    mimeType: 'text/plain',
    buffer: Buffer.from('<ADIF_VER:5>3.1.4<EOH><EOR>'),
  });
  await page.getByRole('button', { name: 'Import ADIF log' }).click();
  await expect(page.locator('#adif-import-status')).toHaveText(
    'retry.adi: COMPLETED · 1 accepted, 0 rejected',
  );

  await page.getByRole('button', { name: 'Close activation' }).click();
  await expect(page.locator('#activation-status')).toHaveText(
    'Activation closed.',
  );
  await expect(page.locator('#qso-form')).toBeHidden();
  await expect(page.locator('#profile-form')).toBeVisible();

  await page.locator('#profile-website').fill('https://radio.example.test');
  await page.locator('#profile-biography').fill('I enjoy **mountain radio**.');
  await expect(page.locator('#profile-biography-preview strong')).toHaveText(
    'mountain radio',
  );
  await page.getByRole('button', { name: 'Save profile details' }).click();
  await expect(page.locator('#profile-status')).toHaveText('Profile saved.');

  expect(activationPayloads).toHaveLength(1);
  expect(activationPayloads[0]).toMatchObject({
    programmeSlug: 'alpine',
    entityId: 'summit-1',
    operatorId: 'participant-1',
    operatorCallsign: 'DL1ABC',
    callsignLifecycleStatus: 'VERIFIED',
    authorizedCallsigns: ['DL1ABC'],
    location: { latitude: 46.1, longitude: 7.2 },
  });
  expect(qsoPayloads).toHaveLength(1);
  expect(qsoPayloads[0]).toMatchObject({
    workedCallsign: 'F4XYZ',
    band: '20M',
    mode: 'SSB',
  });
  expect(closePayloads).toHaveLength(1);
  expect(closePayloads[0]).toMatchObject({ status: 'CLOSED' });
  expect(adifPayloads).toHaveLength(2);
  expect(adifPayloads).toEqual([
    expect.objectContaining({
      activationId: 'activation-1',
      filename: 'first.adi',
    }),
    expect.objectContaining({
      activationId: 'activation-1',
      filename: 'retry.adi',
    }),
  ]);
  expect(profilePayloads).toEqual([
    {
      websiteUrl: 'https://radio.example.test',
      biographyMarkdown: 'I enjoy **mountain radio**.',
    },
  ]);
  expect(authenticatedRequests.length).toBeGreaterThan(3);
  expect(
    authenticatedRequests.every(
      (header) => header === 'Bearer participant-browser-access-token',
    ),
  ).toBe(true);
  await expectResponsiveAccessible(
    page,
    'Participant activation, QSO, and profile workflow',
  );
});

test('shows the participant their activation QSOs and ADIF outcomes', async ({
  page,
}) => {
  const detailRequests: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({
        json: {
          items: [
            {
              slug: 'alpine',
              name: 'Alpine Summits',
              description: 'Radio from the high country.',
              rules: { minimumQsos: { activation: 1, hunter: 1 } },
              entityTypes: [{ code: 'SOTA', name: 'Summit' }],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({
        json: { items: [], page: 1, total: 0, nextPage: null },
      });
      return;
    }
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-detail-access-token',
          refreshToken: 'participant-detail-refresh-token',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          email: 'operator@example.test',
          roles: [{ role: 'PARTICIPANT' }],
          callsigns: [
            { id: 'callsign-1', value: 'DL1ABC', status: 'VERIFIED' },
          ],
        },
      });
      return;
    }
    if (url.pathname === '/v1/activations' && request.method() === 'GET') {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'activation-1',
              programmeSlug: 'alpine',
              operatorId: 'participant-1',
              operatorCallsign: 'DL1ABC',
              status: 'CLOSED',
              qsoCount: 1,
              startedAt: '2026-10-27T06:00:00Z',
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/activations/activation-1') {
      detailRequests.push(request.headers().authorization || '');
      await route.fulfill({
        json: {
          id: 'activation-1',
          programmeSlug: 'alpine',
          entityType: 'SOTA',
          operatorId: 'participant-1',
          operatorCallsign: 'DL1ABC',
          status: 'CLOSED',
          qsoCount: 1,
          startedAt: '2026-10-27T06:00:00Z',
          endedAt: '2026-10-27T07:00:00Z',
          qsos: [
            {
              id: 'qso-1',
              workedCallsign: 'F4XYZ',
              timestamp: '2026-10-27T06:30:00Z',
              band: '20M',
              mode: 'SSB',
              source: 'ADIF',
              sourceImportId: 'import-1',
              status: 'ACTIVE',
            },
          ],
          imports: [
            {
              id: 'import-1',
              filename: 'contacts<operator>.adi',
              status: 'COMPLETED',
              recordsSeen: 1,
              recordsAccepted: 1,
              recordsRejected: 0,
            },
          ],
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#activations-list')).toContainText('1 QSOs');
  const details = page.locator(
    'details.activation-history-detail[data-activation-id="activation-1"]',
  );
  await expect(details).toHaveCount(1);
  await expect(details.locator('.activation-history-content')).toContainText(
    'Open to load activation and QSO details.',
  );
  expect(detailRequests).toHaveLength(0);

  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  const detailPanel = details.locator('.activation-history-content');
  await expect(detailPanel).toContainText('F4XYZ');
  await expect(detailPanel).toContainText('20M · SSB');
  await expect(detailPanel).toContainText('ADIF · contacts<operator>.adi');
  await expect(detailPanel).toContainText('COMPLETED');
  await expect(detailPanel).toContainText(
    '1 accepted · 0 rejected of 1 records',
  );
  await expect(detailPanel.locator('script, img')).toHaveCount(0);
  await expect(details.locator('summary')).toHaveAttribute('aria-controls');
  expect(detailRequests).toEqual(['Bearer participant-detail-access-token']);
  await expectResponsiveAccessible(
    page,
    'Participant activation history details',
  );
});

test('does not render another participant activation when details are denied', async ({
  page,
}) => {
  const detailRequests: string[] = [];
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }
    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'other-participant-access-token',
          refreshToken: 'other-participant-refresh-token',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-2',
          email: 'other@example.test',
          roles: [{ role: 'PARTICIPANT' }],
          callsigns: [],
        },
      });
      return;
    }
    if (url.pathname === '/v1/activations' && request.method() === 'GET') {
      await route.fulfill({
        json: {
          items: [
            {
              id: 'activation-owned-by-someone-else',
              programmeSlug: 'alpine',
              operatorId: 'participant-1',
              operatorCallsign: 'DL1ABC',
              status: 'CLOSED',
              qsoCount: 1,
              startedAt: '2026-10-27T06:00:00Z',
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/activations/activation-owned-by-someone-else') {
      detailRequests.push(request.headers().authorization || '');
      await route.fulfill({
        status: 404,
        json: { statusCode: 404, detail: 'Activation not found' },
      });
      return;
    }
    await route.fulfill({ json: { items: [], nextPage: null } });
  });

  await page.goto('http://127.0.0.1:8091');
  await page.locator('#award-email').fill('other@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  const details = page.locator(
    'details.activation-history-detail[data-activation-id="activation-owned-by-someone-else"]',
  );
  await expect(details).toHaveCount(1);
  const deniedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === '/v1/activations/activation-owned-by-someone-else' &&
      response.status() === 404
    );
  });
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  expect((await deniedResponse).status()).toBe(404);

  const detailPanel = details.locator('.activation-history-content');
  await expect(detailPanel).toContainText(
    'Unable to load activation details. Activation not found',
  );
  await expect(detailPanel).not.toContainText('F4XYZ');
  expect(detailRequests).toEqual(['Bearer other-participant-access-token']);
  await expectResponsiveAccessible(
    page,
    'Denied Participant activation history details',
  );
});

test('clears stale programme activity and retries failed award and QSO reads', async ({
  page,
}) => {
  let coastAwardFails = true;
  let coastActivityFails = true;
  let activationDetailFails = true;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const programmes = ['alpine', 'coast'].map((slug) => ({
    slug,
    name: slug === 'alpine' ? 'Alpine Summits' : 'Coastal Parks',
    description: `${slug} programme`,
    theme: { primary: '#2367a8', accent: '#e38a32' },
    rules: {
      minimumQsos: { activation: 4, hunter: 1 },
      publicAccessRequired: true,
    },
    entityTypes: [{ code: 'PARK', name: 'Park', geometryTypes: ['POINT'] }],
  }));

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/v1/programmes') {
      await route.fulfill({ json: { items: programmes, nextPage: null } });
      return;
    }
    if (url.pathname.endsWith('/content')) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (url.pathname === '/v1/geodata/entities') {
      await route.fulfill({ json: { items: [], page: 1, total: 0 } });
      return;
    }
    if (url.pathname === '/v1/identity/auth/login') {
      await route.fulfill({
        json: {
          accessToken: 'participant-recovery-access-token',
          refreshToken: 'participant-recovery-refresh-token',
        },
      });
      return;
    }
    if (url.pathname === '/v1/identity/me') {
      await route.fulfill({
        json: {
          id: 'participant-1',
          email: 'operator@example.test',
          callsigns: [
            { id: 'callsign-1', value: 'EA1ABC', status: 'VERIFIED' },
          ],
          primaryCallsignId: 'callsign-1',
        },
      });
      return;
    }
    if (url.pathname === '/v1/awards/requests') {
      await route.fulfill({ json: { items: [], nextPage: null } });
      return;
    }
    if (url.pathname === '/v1/awards') {
      const slug = url.searchParams.get('programme');
      if (slug === 'coast' && coastAwardFails) {
        coastAwardFails = false;
        await route.fulfill({
          status: 503,
          json: { message: 'award service unavailable' },
        });
        return;
      }
      await route.fulfill({
        json: {
          items: [
            {
              id: `${slug}-award`,
              name: `${slug} award`,
              category: 'activator',
              achievementMetric: 'QSOs',
              levels: [{ id: 'bronze', name: 'Bronze', threshold: 5 }],
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/activations' && method === 'GET') {
      const slug = url.searchParams.get('programme');
      if (slug === 'coast' && coastActivityFails) {
        coastActivityFails = false;
        await route.fulfill({
          status: 503,
          json: { message: 'activity service unavailable' },
        });
        return;
      }
      const id = `${slug}-activation`;
      await route.fulfill({
        json: {
          items: [
            {
              id,
              operatorCallsign: slug === 'coast' ? 'EA1ABC' : 'EA2XYZ',
              status: 'CLOSED',
              qsoCount: 1,
              startedAt: '2026-10-28T10:00:00Z',
            },
          ],
          nextPage: null,
        },
      });
      return;
    }
    if (url.pathname === '/v1/activations/coast-activation') {
      if (activationDetailFails) {
        activationDetailFails = false;
        await route.fulfill({
          status: 503,
          json: { message: 'QSO detail service unavailable' },
        });
        return;
      }
      await route.fulfill({
        json: {
          id: 'coast-activation',
          entityType: 'PARK',
          startedAt: '2026-10-28T10:00:00Z',
          qsos: [
            {
              workedCallsign: 'F4XYZ',
              timestamp: '2026-10-28T10:30:00Z',
              band: '20M',
              mode: 'SSB',
            },
          ],
          imports: [],
        },
      });
      return;
    }
    await route.fulfill({ json: { items: [], nextPage: null, total: 0 } });
  });

  await page.goto('http://127.0.0.1:8091');
  await expect(page.locator('#public-awards')).toContainText('alpine award');
  await page.locator('#award-email').fill('operator@example.test');
  await page.locator('#award-password').fill('test-password');
  await page.locator('#participant-login button[type="submit"]').click();
  await expect(page.locator('#activations-list')).toContainText('EA2XYZ');

  await page.getByLabel('Programme').selectOption('coast');
  await expect(page.locator('#activations-list')).toContainText(
    'temporarily unavailable',
  );
  await expect(page.locator('#activations-list')).not.toContainText('EA2XYZ');
  await expect(page.locator('#public-awards')).toContainText(
    'Awards are temporarily unavailable',
  );
  await expect(page.locator('#public-awards')).not.toContainText(
    'alpine award',
  );
  await expect(page.locator('#activation-status')).toContainText(
    'Refresh programme data',
  );

  await page.getByRole('button', { name: 'Refresh programme data' }).click();
  await expect(page.locator('#activations-list')).toContainText('EA1ABC');
  await expect(page.locator('#public-awards')).toContainText('coast award');
  await expect(page.locator('#activations-list')).not.toContainText('EA2XYZ');

  const coastDetails = page.locator(
    'details.activation-history-detail[data-activation-id="coast-activation"]',
  );
  await coastDetails.locator('summary').click();
  const detailPanel = coastDetails.locator('.activation-history-content');
  await expect(detailPanel).toContainText(
    'Unable to load activation details. QSO detail service unavailable',
  );
  await detailPanel
    .getByRole('button', { name: 'Retry activity and QSO details' })
    .click();
  await expect(detailPanel).toContainText('F4XYZ');
  expect(pageErrors).toEqual([]);
});
