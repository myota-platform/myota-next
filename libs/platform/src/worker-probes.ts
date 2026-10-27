import { createServer, type Server, type ServerResponse } from 'node:http';

export function workerProbePort(
  value: string | undefined,
  fallback: number,
  variable: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error(`${variable} must be a valid TCP port`);
  return parsed;
}

export class WorkerProbeServer {
  private server?: Server;
  private stopping = false;

  async listen(
    port: number,
    ready: () => Promise<boolean>,
    metrics: () => string,
    host = '0.0.0.0',
  ): Promise<number> {
    this.server = createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(404).end();
        return;
      }
      if (request.url === '/healthz') {
        this.respond(response, !this.stopping, 'ok', 'stopping');
        return;
      }
      if (request.url === '/readyz') {
        void ready()
          .then((isReady) =>
            this.respond(
              response,
              !this.stopping && isReady,
              'ready',
              'not ready',
            ),
          )
          .catch(() => this.respond(response, false, 'ready', 'not ready'));
        return;
      }
      if (request.url === '/metrics') {
        response.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        response.end(metrics());
        return;
      }
      response.writeHead(404).end();
    });
    return new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject).listen(port, host, () => {
        const address = this.server!.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
  }

  private respond(
    response: ServerResponse,
    success: boolean,
    okBody: string,
    errorBody: string,
  ): void {
    response.writeHead(success ? 200 : 503, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(`${success ? okBody : errorBody}\n`);
  }
}
