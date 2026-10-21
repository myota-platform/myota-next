import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ActivityModule } from '../apps/activity/src/activity.module.js';
import { IdentityModule } from '../apps/identity/src/identity.module.js';

const describeWithCoreDatabase = describe.skipIf(
  !process.env.CORE_DATABASE_URL || !process.env.ACTIVITY_DATABASE_URL,
);

describeWithCoreDatabase('MyOTA APIs with PostgreSQL', () => {
  it('completes bootstrap, Identity session, and Activity activation/QSO workflows over HTTP', async () => {
    const email = `identity-e2e-${randomUUID()}@example.test`;
    const password = `MyOTA-e2e-${randomUUID()}!`;
    const previousEmail = process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL;
    const previousPassword = process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD;
    process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL = email;
    process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD = password;

    const module = await Test.createTestingModule({
      imports: [IdentityModule, ActivityModule],
    }).compile();
    const app = module.createNestApplication();
    try {
      await app.init();
      const server = app.getHttpServer();
      const login = await request(server)
        .post('/identity/auth/login')
        .send({ email, password })
        .expect(200);

      expect(login.body.account.email).toBe(email);
      expect(login.body.account.id).toEqual(expect.any(String));
      expect(login.body.accessToken).toEqual(expect.any(String));
      expect(login.body.refreshToken).toEqual(expect.any(String));

      const current = await request(server)
        .get('/identity/me')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .expect(200);
      expect(current.body.id).toBe(login.body.account.id);
      expect(current.body.scopes).toContain('*');

      const refreshed = await request(server)
        .post('/identity/auth/refresh')
        .send({ refreshToken: login.body.refreshToken })
        .expect(200);
      expect(refreshed.body.accessToken).toEqual(expect.any(String));
      expect(refreshed.body.refreshToken).toEqual(expect.any(String));
      expect(refreshed.body.refreshToken).not.toBe(login.body.refreshToken);

      await request(server)
        .post('/identity/auth/refresh')
        .send({ refreshToken: login.body.refreshToken })
        .expect(401);

      const startedAt = new Date().toISOString();
      const activation = await request(server)
        .post('/activations')
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          programmeSlug: 'identity-e2e',
          entityId: `entity-${randomUUID()}`,
          operatorId: login.body.account.id,
          operatorCallsign: 'EA0E2E',
          startedAt,
        })
        .expect(201);
      expect(activation.body.status).toBe('OPEN');
      expect(activation.body.operatorId).toBe(login.body.account.id);

      const qso = await request(server)
        .post(`/activations/${activation.body.id}/qsos`)
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

      const closed = await request(server)
        .patch(`/activations/${activation.body.id}`)
        .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
        .send({ status: 'CLOSED', endedAt: new Date().toISOString() })
        .expect(200);
      expect(closed.body.status).toBe('CLOSED');
    } finally {
      await app.close();
      if (previousEmail === undefined) {
        delete process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL;
      } else {
        process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL = previousEmail;
      }
      if (previousPassword === undefined) {
        delete process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD;
      } else {
        process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD = previousPassword;
      }
    }
  });
});
