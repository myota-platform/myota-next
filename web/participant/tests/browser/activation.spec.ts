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
