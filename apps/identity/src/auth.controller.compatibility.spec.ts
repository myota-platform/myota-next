import { vi } from 'vitest';
import { AuthController } from './auth.controller.js';

describe('AuthController registration delegation', () => {
  it('passes registration details and the resolved client address to Identity', async () => {
    const registration = {
      register: vi.fn().mockResolvedValue({
        message:
          'If registration can proceed, a verification email will be sent.',
      }),
    };
    const controller = new AuthController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      registration as never,
      {} as never,
    );
    const body = {
      displayName: 'Casey Operator',
      email: 'casey@example.test',
      password: 'long-enough-test-password',
      participationType: 'OPERATOR',
    };
    const request = {
      get: () => undefined,
      socket: { remoteAddress: '192.0.2.10' },
    } as never;

    await expect(controller.register(body, request)).resolves.toEqual({
      message:
        'If registration can proceed, a verification email will be sent.',
    });
    expect(registration.register).toHaveBeenCalledWith(body, '192.0.2.10');
  });

  it('passes the recovery request address to the abuse limiter', async () => {
    const auth = {
      requestRecovery: vi.fn().mockResolvedValue({ status: 'accepted' }),
    };
    const controller = new AuthController(
      auth as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const request = {
      get: () => undefined,
      socket: { remoteAddress: '192.0.2.11' },
    } as never;

    await expect(
      controller.requestRecovery({ email: 'casey@example.test' }, request),
    ).resolves.toEqual({ status: 'accepted' });
    expect(auth.requestRecovery).toHaveBeenCalledWith(
      'casey@example.test',
      '192.0.2.11',
    );
  });
});
