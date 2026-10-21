import type { Pool } from 'pg';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseHealthService } from './database.module.js';
import { HealthController } from './health.controller.js';

describe('health and readiness', () => {
  it('answers liveness without a database', () => {
    expect(new HealthController().health()).toEqual({ status: 'ok' });
  });

  it('checks the owning database before reporting readiness', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const pool = { query };
    const database = new DatabaseHealthService(pool as unknown as Pool);
    const controller = new HealthController(database);
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const response = {
      status,
      json,
    } as unknown as Response;

    await controller.readiness(response);

    expect(query).toHaveBeenCalledWith('SELECT 1');
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('returns not-ready while the database is unavailable', async () => {
    const query = vi.fn().mockRejectedValue(new Error('offline'));
    const pool = { query };
    const database = new DatabaseHealthService(pool as unknown as Pool);
    const controller = new HealthController(database);
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const response = {
      status,
      json,
    } as unknown as Response;

    await controller.readiness(response);

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({ status: 'not-ready' });
  });

  it('handles errors from idle database connections', () => {
    const on = vi.fn();
    new DatabaseHealthService({ on } as unknown as Pool);

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    const [, handlePoolError] = on.mock.calls[0]!;
    expect(() => handlePoolError(new Error('connection reset'))).not.toThrow();
  });
});
