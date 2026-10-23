import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { JetStreamManager, StreamConfig } from '@nats-io/jetstream';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';

export type TestJetStreamCluster = {
  natsUrl: string;
  serverNames: string[];
  stopNode: (serverName: string) => Promise<void>;
  stopAll: () => Promise<void>;
};

export async function addTestStreamWithPlacementRetry(
  manager: JetStreamManager,
  config: StreamConfig,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastPlacementError: unknown;
  while (Date.now() < deadline) {
    try {
      await manager.streams.add(config);
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('no suitable peers for placement')
      )
        throw error;
      lastPlacementError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    'JetStream cluster did not become ready for replicated stream placement',
    { cause: lastPlacementError },
  );
}

export async function startTestJetStreamCluster(
  directory: string,
  clusterName: string,
  nodePrefix: string,
  size = 3,
): Promise<TestJetStreamCluster> {
  if (!Number.isInteger(size) || size < 3 || size % 2 === 0)
    throw new Error(
      'JetStream recovery clusters require an odd size of at least three',
    );

  const ports = await reserveDistinctLocalPorts(size * 2);
  const clientPorts = ports.slice(0, size);
  const clusterPorts = ports.slice(size);
  const serverNames = Array.from(
    { length: size },
    (_, index) => `${nodePrefix}-${index + 1}`,
  );
  const processes = new Map<string, ChildProcess>();
  const natsUrl = clientPorts
    .map((port) => `nats://127.0.0.1:${port}`)
    .join(',');

  const stopNode = async (serverName: string) => {
    const process = processes.get(serverName);
    if (!process) return;
    processes.delete(serverName);
    await stopProcess(process);
  };
  const stopAll = async () => {
    await Promise.all(
      [...processes.values()].map((process) => stopProcess(process)),
    );
    processes.clear();
  };

  try {
    for (let index = 0; index < size; index++) {
      const serverName = serverNames[index]!;
      const routes = clusterPorts
        .filter((_, routeIndex) => routeIndex !== index)
        .map((port) => `nats://127.0.0.1:${port}`)
        .join(',');
      const process = spawn(
        'nats-server',
        [
          '-js',
          '-sd',
          join(directory, serverName),
          '-p',
          String(clientPorts[index]),
          '-n',
          serverName,
          '--cluster',
          `nats://127.0.0.1:${clusterPorts[index]}`,
          '--cluster_name',
          clusterName,
          '--routes',
          routes,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      processes.set(serverName, process);
      await waitForServerReady(process, serverName);
    }
    const connection = await connect({
      servers: natsUrl,
      name: `${nodePrefix}-readiness-probe`,
      timeout: 1000,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 100,
    });
    try {
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          await jetstreamManager(connection, { timeout: 1000 });
          ready = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!ready)
        throw new Error(
          'JetStream cluster metadata leader did not become ready',
        );
    } finally {
      await connection.drain();
    }
  } catch (error) {
    await stopAll();
    throw error;
  }

  return { natsUrl, serverNames, stopNode, stopAll };
}

async function reserveDistinctLocalPorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await reserveLocalPort());
  return [...ports];
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('could not reserve a local JetStream port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForServerReady(process: ChildProcess, serverName: string) {
  let output = '';
  process.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  process.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null)
      throw new Error(
        `JetStream cluster node ${serverName} exited during startup: ${output}`,
      );
    if (output.includes('Server is ready')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `JetStream cluster node ${serverName} did not start: ${output}`,
  );
}

async function stopProcess(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('JetStream cluster node did not stop')),
      5000,
    );
    process.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
