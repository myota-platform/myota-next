import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootstrapHttpService } from '../libs/platform/src/bootstrap.js';
import { integerSetting } from '../libs/platform/src/integer-setting.js';
import { ActivityModule } from '../apps/activity/src/activity.module.js';
import { GatewayModule } from '../apps/gateway/src/gateway.module.js';
import { IdentityModule } from '../apps/identity/src/identity.module.js';

const describeWithDatabases = describe.skipIf(
  !process.env.CORE_DATABASE_URL || !process.env.ACTIVITY_DATABASE_URL,
);

describeWithDatabases(
  'Gateway to Identity and Activity HTTP integration',
  () => {
    it('routes a real operator session through activation, QSO, and close', async () => {
      const email = `platform-e2e-${randomUUID()}@example.test`;
      const password = `MyOTA-e2e-${randomUUID()}!`;
      const envNames = [
        'MYOTA_BOOTSTRAP_ADMIN_EMAIL',
        'MYOTA_BOOTSTRAP_ADMIN_PASSWORD',
        'MYOTA_IDENTITY_URL',
        'MYOTA_ACTIVITY_URL',
        'PORT',
      ] as const;
      const previous = Object.fromEntries(
        envNames.map((name) => [name, process.env[name]]),
      );
      process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL = email;
      process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD = password;
      process.env.PORT = '0';

      let identityApp: INestApplication | undefined;
      let activityApp: INestApplication | undefined;
      let gatewayApp: INestApplication | undefined;
      try {
        identityApp = await startIdentity();
        activityApp = await startActivity();
        process.env.MYOTA_IDENTITY_URL = await listen(identityApp);
        process.env.MYOTA_ACTIVITY_URL = await listen(activityApp);
        gatewayApp = await startGateway();
        const gatewayUrl = await listen(gatewayApp);

        const login = await request(gatewayUrl)
          .post('/v1/identity/auth/login')
          .send({ email, password })
          .expect(200);
        expect(login.body.account.email).toBe(email);

        const current = await request(gatewayUrl)
          .get('/v1/identity/me')
          .set('Authorization', `Bearer ${login.body.accessToken}`)
          .expect(200);
        expect(current.body.id).toBe(login.body.account.id);
        expect(current.body.scopes).toContain('*');

        const refreshed = await request(gatewayUrl)
          .post('/v1/identity/auth/refresh')
          .send({ refreshToken: login.body.refreshToken })
          .expect(200);
        expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);
        await request(gatewayUrl)
          .post('/v1/identity/auth/refresh')
          .send({ refreshToken: login.body.refreshToken })
          .expect(401);

        const startedAt = new Date().toISOString();
        const activation = await request(gatewayUrl)
          .post('/v1/activations')
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            programmeSlug: 'gateway-e2e',
            entityId: `entity-${randomUUID()}`,
            operatorId: login.body.account.id,
            operatorCallsign: 'EA0E2E',
            startedAt,
          })
          .expect(201);
        expect(activation.body.status).toBe('OPEN');

        const qso = await request(gatewayUrl)
          .post(`/v1/activations/${activation.body.id}/qsos`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .set('Idempotency-Key', randomUUID())
          .send({
            workedCallsign: 'F4E2E',
            timestamp: startedAt,
            band: '20M',
            mode: 'SSB',
          })
          .expect(201);
        expect(qso.body.workedCallsign).toBe('F4E2E');

        const closed = await request(gatewayUrl)
          .patch(`/v1/activations/${activation.body.id}`)
          .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
          .send({ status: 'CLOSED', endedAt: new Date().toISOString() })
          .expect(200);
        expect(closed.body.status).toBe('CLOSED');
      } finally {
        await Promise.all(
          [gatewayApp, activityApp, identityApp]
            .filter((app): app is INestApplication => app !== undefined)
            .map((app) => app.close()),
        );
        for (const name of envNames) {
          const value = previous[name];
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  },
);

async function startIdentity() {
  return bootstrapHttpService(
    IdentityModule,
    0,
    undefined,
    [],
    [],
    true,
    'identity-api',
  );
}

async function startActivity() {
  return bootstrapHttpService(
    ActivityModule,
    0,
    integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 2),
    [],
    [],
    true,
    'activity-api',
    [
      {
        method: 'POST',
        path: '/v1/awards/previews',
        maxBytes: 64 * 1024,
        detail: 'preview design exceeds 64 KiB',
      },
    ],
  );
}

async function startGateway() {
  return bootstrapHttpService(
    GatewayModule,
    0,
    integerSetting(process.env.MYOTA_MAX_BODY_BYTES, 1024 ** 3),
    [],
    [{ path: '_internal/grafana/auth', method: RequestMethod.GET }],
    false,
    'gateway',
    [],
    false,
  );
}

async function listen(app: INestApplication) {
  const address = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
