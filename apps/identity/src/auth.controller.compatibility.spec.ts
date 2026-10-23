import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller.js';

describe('AuthController reference compatibility', () => {
  it('keeps public participant registration disabled with the reference response', () => {
    const controller = new AuthController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    let error: unknown;

    try {
      controller.register();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).message).toBe(
      'public participant registration is unavailable until email verification and abuse controls are deployed',
    );
  });
});
