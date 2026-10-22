import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';

export type PostgresFaultProxy = {
  connectionString: string;
  rejectedConnections: () => number;
  setAvailable: (available: boolean) => void;
  close: () => Promise<void>;
};

export async function startPostgresFaultProxy(
  databaseUrl: string,
): Promise<PostgresFaultProxy> {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  let available = true;
  let rejected = 0;
  const server = createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    if (!available) {
      rejected++;
      client.destroy();
      return;
    }
    const upstream = createConnection({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: Number(target.port || 5432),
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    client.once('error', () => upstream.destroy());
    upstream.once('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('could not start the PostgreSQL fault proxy'));
        return;
      }
      resolve(address.port);
    });
  });
  const proxiedUrl = new URL(databaseUrl);
  proxiedUrl.hostname = '127.0.0.1';
  proxiedUrl.port = String(port);
  return {
    connectionString: proxiedUrl.toString(),
    rejectedConnections: () => rejected,
    setAvailable(next) {
      available = next;
      if (!available) for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
