import { Controller, Get, Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { BaseRpcContext, EventPattern } from '@nestjs/microservices';
import { NestFactory } from '@nestjs/core';
import { TracerService } from '@nestjs/observe';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { ObserveInstrument, ObserveModule, observeOptions } from './observe.js';
import { ObserveEventBridge } from './observe-event-bridge.js';

type CollectorRequest = {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type TelemetryBatch = {
  serviceId: string;
  serviceVersion?: string;
  forwardLogs?: boolean;
  snapshots: Array<{ ti: string; a?: { ou?: string } }>;
  logs?: Array<{ text: string; traceId?: string }>;
};

const RPC_TRACE_ID = '11111111-2222-4333-8444-555555555555';
let eventTracer: TracerService | undefined;

class ObserveSmokeEventContext extends BaseRpcContext<[string]> {
  readonly headers = { 'x-request-id': RPC_TRACE_ID };

  getPattern(): string {
    return this.getArgByIndex(0);
  }
}

class ObserveSmokeEventHandler {
  async handle(): Promise<void> {
    eventTracer
      ?.counter('observe.smoke.worker.events', { labels: ['status'] })
      .increment({ status: 'accepted' });
    process.stdout.write('observe-worker-log-sentinel\n');
  }
}

Controller()(ObserveSmokeEventHandler);
EventPattern('observe-smoke.event')(
  ObserveSmokeEventHandler.prototype,
  'handle',
  Object.getOwnPropertyDescriptor(
    ObserveSmokeEventHandler.prototype,
    'handle',
  )!,
);

class ObserveSmokeController {
  probe() {
    process.stdout.write('observe-smoke-log-sentinel\n');
    return { status: 'observed' };
  }
}

Controller('observe-smoke')(ObserveSmokeController);
Get('probe')(
  ObserveSmokeController.prototype,
  'probe',
  Object.getOwnPropertyDescriptor(ObserveSmokeController.prototype, 'probe')!,
);

function createProbeModule(options: ReturnType<typeof observeOptions>) {
  class ObserveSmokeModule {}
  Module({
    imports: [ObserveModule.forRoot({ ...options, flushInterval: 1000 })],
    controllers: [ObserveSmokeController],
  })(ObserveSmokeModule);

  return ObserveSmokeModule;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function collectorServer(received: CollectorRequest[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        body: gunzipSync(Buffer.concat(chunks)).toString('utf8'),
      });
      response.writeHead(200);
      response.end();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('@nestjs/observe integration', () => {
  let application: INestApplicationContext | undefined;
  let collector: Server | undefined;

  afterEach(async () => {
    await application?.close();
    application = undefined;
    eventTracer = undefined;
    if (collector) await closeServer(collector);
    collector = undefined;
  });

  it('sends instrumented HTTP telemetry to the configured local collector', async () => {
    const received: CollectorRequest[] = [];
    collector = collectorServer(received);
    const collectorPort = await listen(collector);
    const options = observeOptions('observe-smoke-api', {
      OBSERVE_APP_KEY: 'integration-test-app-key',
      OBSERVE_APP_SECRET: 'integration-test-app-secret',
      OBSERVE_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
      MYOTA_BUILD_VERSION: 'integration-test',
    });

    application = await NestFactory.create(createProbeModule(options), {
      logger: false,
      instrument: ObserveInstrument,
    });
    await application.listen(0, '127.0.0.1');
    const appAddress = application.getHttpServer().address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${appAddress.port}/observe-smoke/probe`,
    );

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const correlatedBatch = () =>
      received.find((batch) => {
        const payload = JSON.parse(batch.body) as TelemetryBatch;
        return (
          payload.snapshots.some(
            (snapshot) => snapshot.a?.ou === '/observe-smoke/probe',
          ) &&
          payload.logs?.some((log) =>
            log.text.includes('observe-smoke-log-sentinel'),
          )
        );
      });
    const receivedCorrelatedBatch = await waitFor(
      () => correlatedBatch() !== undefined,
    );

    expect(receivedCorrelatedBatch).toBe(true);
    const batch = correlatedBatch()!;
    const payload = JSON.parse(batch.body) as TelemetryBatch;
    const snapshot = payload.snapshots.find(
      (candidate) => candidate.a?.ou === '/observe-smoke/probe',
    )!;
    const log = payload.logs!.find((candidate) =>
      candidate.text.includes('observe-smoke-log-sentinel'),
    )!;

    expect(batch.path).toBe('/applications/telemetry');
    expect(batch.headers['content-encoding']).toBe('gzip');
    expect(batch.headers['x-api-key']).toBe('integration-test-app-key');
    expect(batch.headers['x-api-secret']).toBe('integration-test-app-secret');
    expect(payload.serviceId).toBe('observe-smoke-api');
    expect(payload.serviceVersion).toBe('integration-test');
    expect(payload.forwardLogs).toBe(true);
    expect(log.traceId).toBe(snapshot.ti);
  }, 15000);

  it('starts and serves requests without sending when credentials are absent', async () => {
    const received: CollectorRequest[] = [];
    collector = collectorServer(received);
    const collectorPort = await listen(collector);
    const options = observeOptions('observe-smoke-api', {
      OBSERVE_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
    });

    application = await NestFactory.create(createProbeModule(options), {
      logger: false,
      instrument: ObserveInstrument,
    });
    await application.listen(0, '127.0.0.1');
    const appAddress = application.getHttpServer().address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${appAddress.port}/observe-smoke/probe`,
    );

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(received).toHaveLength(0);
  }, 10000);

  it('traces a custom JetStream event handler and correlates its worker log', async () => {
    const received: CollectorRequest[] = [];
    collector = collectorServer(received);
    const collectorPort = await listen(collector);
    const options = observeOptions('observe-smoke-worker', {
      OBSERVE_APP_KEY: 'integration-test-app-key',
      OBSERVE_APP_SECRET: 'integration-test-app-secret',
      OBSERVE_ENDPOINT: `http://127.0.0.1:${collectorPort}`,
    });
    class ObserveSmokeWorkerModule {}
    Module({
      imports: [ObserveModule.forRoot({ ...options, flushInterval: 1000 })],
      controllers: [ObserveSmokeEventHandler],
    })(ObserveSmokeWorkerModule);

    const transport = new ObserveEventBridge();
    application = await NestFactory.createMicroservice(
      ObserveSmokeWorkerModule,
      { logger: false, strategy: transport, instrument: ObserveInstrument },
    );
    await application.listen();
    eventTracer = application.get(TracerService);
    await transport.dispatch(
      'observe-smoke.event',
      { eventId: 'test-event' },
      new ObserveSmokeEventContext(['observe-smoke.event']),
    );

    const correlatedBatch = () =>
      received.find((batch) => {
        const payload = JSON.parse(batch.body) as TelemetryBatch;
        return (
          payload.snapshots.some((snapshot) => snapshot.ti === RPC_TRACE_ID) &&
          payload.logs?.some((log) =>
            log.text.includes('observe-worker-log-sentinel'),
          )
        );
      });
    const receivedWorkerBatch = await waitFor(
      () => correlatedBatch() !== undefined,
    );
    expect(receivedWorkerBatch).toBe(true);
    const payload = JSON.parse(correlatedBatch()!.body) as TelemetryBatch;
    const log = payload.logs!.find((candidate) =>
      candidate.text.includes('observe-worker-log-sentinel'),
    )!;

    expect(payload.serviceId).toBe('observe-smoke-worker');
    expect(log.traceId).toBe(RPC_TRACE_ID);
    expect(correlatedBatch()!.body).toContain('observe.smoke.worker.events');
  }, 15000);
});
