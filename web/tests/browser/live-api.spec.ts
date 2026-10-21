import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const hasApiDatabases = Boolean(
  process.env.CORE_DATABASE_URL &&
  process.env.ACTIVITY_DATABASE_URL &&
  process.env.GEO_DATABASE_URL,
);

test('loads a real programme catalogue through Gateway and Geodata', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email, password } },
  );
  expect(login.ok()).toBeTruthy();
  const { accessToken } = await login.json();
  const slug = `browser-${randomUUID()}`;
  const created = await request.post('http://127.0.0.1:8080/v1/programmes', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': randomUUID(),
    },
    data: {
      slug,
      name: 'Browser integration programme',
      description: 'Served by the live NestJS APIs.',
      entityTypes: [
        {
          code: `E2E_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          label: 'Integration point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
    },
  });
  expect(created.status()).toBe(201);

  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  const contentResponse = page.waitForResponse((response) =>
    response.url().includes('/content'),
  );
  await page.goto(`http://127.0.0.1:8091/#${slug}`);
  expect((await contentResponse).ok()).toBeTruthy();

  await expect(page.locator('#programme-name')).toHaveText(
    'Browser integration programme',
  );
  await expect(page.locator('#entity-page-status')).toHaveText(
    'Page 1 · 0 entities',
  );
  expect(failedResponses).toEqual([]);
});

test('signs into Admin through Gateway and loads its live dashboard', async ({
  page,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('API connected')).toBeVisible();
  await expect(
    page.getByText('available programme configurations'),
  ).toBeVisible();
  expect(failedResponses).toEqual([]);
});

test('creates a participant account in Admin through the live Identity API', async ({
  page,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const accountName = `Browser participant ${randomUUID()}`;
  const accountEmail = `browser-participant-${randomUUID()}@example.test`;
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.goto('http://127.0.0.1:8090/identity');
  await expect(page).toHaveURL(/\/identity$/);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Display name').fill(accountName);
  await page.getByLabel('Email').last().fill(accountEmail);
  await page.getByLabel(/Activity administrator/).check();
  const creationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/v1/identity/accounts',
  );
  await page.getByRole('button', { name: 'Create account' }).last().click();

  const response = await creationResponse;
  expect(response.status()).toBe(201);
  await expect(
    page.getByText(
      'Account created with status PENDING_SETUP. No invitation was sent; invitation delivery is not available yet.',
    ),
  ).toBeVisible();
  await expect(page.getByText(accountEmail)).toBeVisible();
  const createdAccount = await response.json();
  expect(createdAccount).toMatchObject({
    displayName: accountName,
    email: accountEmail,
    status: 'PENDING_SETUP',
    roles: [{ role: 'PARTICIPANT' }, { role: 'ACTIVITY_ADMIN' }],
  });

  await page.getByRole('button', { name: new RegExp(accountName) }).click();
  const callsignRows = page.locator('.callsign-management .callsign-row');
  const callsignValue = `DL${randomUUID().replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const addCallsignForm = page.locator('.callsign-management form').first();
  await addCallsignForm.getByLabel('Callsign').fill(callsignValue);
  await addCallsignForm.getByLabel('Initial status').selectOption('UNVERIFIED');
  await addCallsignForm.getByLabel('Source').fill('operator-asserted');
  await addCallsignForm.getByRole('button', { name: 'Add callsign' }).click();
  await expect(callsignRows.filter({ hasText: callsignValue })).toBeVisible();

  const evidenceForm = page.locator('.callsign-management form').nth(1);
  await evidenceForm
    .getByLabel('Callsign')
    .selectOption({ label: callsignValue });
  await evidenceForm.getByLabel('Evidence type').fill('LICENSE');
  await evidenceForm.getByLabel('Source').fill('regulator record');
  await evidenceForm
    .getByLabel('Metadata JSON (optional)')
    .fill('{"reference":"browser-live"}');
  await evidenceForm.getByRole('button', { name: 'Submit evidence' }).click();
  await expect(
    callsignRows.filter({ hasText: '1 evidence record' }),
  ).toBeVisible();

  await page.getByLabel('Verification source').fill('manual-review');
  await callsignRows
    .filter({ hasText: callsignValue })
    .getByRole('button', { name: 'Verify' })
    .click();
  await expect(
    callsignRows.filter({ hasText: 'Verified by manual-review' }),
  ).toContainText(callsignValue);

  await page.getByLabel('Status').first().selectOption('ACTIVE');
  const activationResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'PATCH' &&
      new URL(candidate.url()).pathname ===
        `/v1/identity/accounts/${createdAccount.id}`,
  );
  await page.getByRole('button', { name: 'Save user' }).click();
  expect((await activationResponse).status()).toBe(200);
  await expect(
    page.getByText(
      'User saved. Existing scoped role assignments have been preserved.',
    ),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export account' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    `myota-account-${createdAccount.id}.json`,
  );
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(exported.account).toMatchObject({
    id: createdAccount.id,
    displayName: accountName,
    status: 'ACTIVE',
  });
  expect(exported.callsignEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: 'regulator record' }),
    ]),
  );

  const confirmations: string[] = [];
  page.once('dialog', async (dialog) => {
    confirmations.push(dialog.message());
    await dialog.accept();
  });
  const deactivationResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'PATCH' &&
      new URL(candidate.url()).pathname ===
        `/v1/identity/accounts/${createdAccount.id}`,
  );
  await page.getByRole('button', { name: 'Deactivate and anonymize' }).click();
  const deactivated = await deactivationResponse;
  expect(deactivated.status()).toBe(200);
  expect(await deactivated.json()).toMatchObject({
    id: createdAccount.id,
    displayName: 'Deactivated account',
    email: null,
    status: 'DEACTIVATED',
  });
  await expect(
    page.getByText('Account deactivated and anonymized.'),
  ).toBeVisible();
  expect(confirmations).toEqual([`Deactivate and anonymize ${accountName}?`]);
  expect(failedResponses).toEqual([]);
});

test('reviews a live QSO correction in Admin and verifies the updated QSO', async ({
  page,
  request,
}) => {
  test.skip(!hasApiDatabases, 'requires the CI PostgreSQL databases');

  const email =
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ?? 'browser-e2e-admin@example.test';
  const password =
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ?? 'browser-e2e-password-7!Q';
  const login = await request.post(
    'http://127.0.0.1:8080/v1/identity/auth/login',
    { data: { email, password } },
  );
  expect(login.ok()).toBeTruthy();
  const { accessToken, account } = await login.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const suffix = randomUUID();
  const programmeSlug = `browser-correction-${suffix}`;
  const startedAt = new Date().toISOString();
  const programme = await request.post('http://127.0.0.1:8080/v1/programmes', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: {
      slug: programmeSlug,
      name: 'Browser correction review programme',
      description: 'Created for the live Admin correction review workflow.',
      entityTypes: [
        {
          code: `E2E_${suffix.replaceAll('-', '').slice(0, 12)}`,
          label: 'Correction test point',
          geometryTypes: ['POINT'],
        },
      ],
      rules: {
        activationValidityDays: 7,
        minimumQsos: { activation: 1, hunter: 1 },
        publicAccessRequired: false,
      },
    },
  });
  expect(programme.status()).toBe(201);

  const activationResponse = await request.post(
    'http://127.0.0.1:8080/v1/activations',
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: {
        programmeSlug,
        entityId: `entity-${suffix}`,
        operatorId: account.id,
        operatorCallsign: 'EA0BROWSER',
        startedAt,
        programmeRules: {
          minimumQsos: { activation: 1, hunter: 1 },
        },
      },
    },
  );
  expect(activationResponse.status()).toBe(201);
  const activation = await activationResponse.json();
  const qsoResponse = await request.post(
    `http://127.0.0.1:8080/v1/activations/${activation.id}/qsos`,
    {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data: {
        workedCallsign: `F4${suffix.replaceAll('-', '').slice(0, 5).toUpperCase()}`,
        timestamp: startedAt,
        band: '20M',
        mode: 'SSB',
      },
    },
  );
  expect(qsoResponse.status()).toBe(201);
  const qso = (await qsoResponse.json()).qso;
  const originalCallsign = qso.workedCallsign as string;
  const correctedCallsign = `G4${suffix.replaceAll('-', '').slice(0, 5).toUpperCase()}`;
  const correctionResponse = await request.post(
    `http://127.0.0.1:8080/v1/qsos/${qso.id}/corrections`,
    {
      headers,
      data: {
        requestedBy: account.id,
        reason: 'Correct the worked callsign from the live browser test.',
        proposedValues: { workedCallsign: correctedCallsign },
      },
    },
  );
  expect(correctionResponse.status()).toBe(201);
  const correction = await correctionResponse.json();

  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/v1/') && response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('http://127.0.0.1:8090/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('http://127.0.0.1:8090/activity');

  const correctionCard = page
    .locator('.correction-card')
    .filter({ hasText: originalCallsign });
  await expect(correctionCard).toContainText(
    'Correct the worked callsign from the live browser test.',
  );
  await expect(correctionCard).toContainText(correctedCallsign);
  await correctionCard
    .getByLabel('Review note (optional)')
    .fill('Confirmed in the live Admin browser workflow.');
  const reviewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/qsos/${qso.id}/corrections/${correction.id}/review`,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await correctionCard
    .getByRole('button', { name: 'Apply correction' })
    .click();
  expect((await reviewResponse).status()).toBe(200);
  await expect(page.getByText('QSO correction applied.')).toBeVisible();

  await page.getByLabel('Status').selectOption('APPLIED');
  await expect(
    page.locator('.correction-card').filter({ hasText: correctedCallsign }),
  ).toContainText('APPLIED');
  const activationRead = await request.get(
    `http://127.0.0.1:8080/v1/activations/${activation.id}`,
    { headers },
  );
  expect(activationRead.status()).toBe(200);
  expect((await activationRead.json()).qsos).toMatchObject([
    { id: qso.id, workedCallsign: correctedCallsign, status: 'CORRECTED' },
  ]);
  expect(failedResponses).toEqual([]);
});
