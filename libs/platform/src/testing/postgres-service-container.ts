import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function stopPostgresServiceContainer(containerId: string) {
  await runDocker(['stop', '--time', '1', containerId]);
}

export async function startPostgresServiceContainer(containerId: string) {
  await runDocker(['start', containerId]);
}

async function runDocker(arguments_: string[]) {
  const containerId = arguments_.at(-1);
  if (!containerId || !/^[a-f0-9]{12,64}$/i.test(containerId))
    throw new Error('PostgreSQL recovery requires a Docker container ID');
  await execFileAsync('docker', arguments_, { timeout: 20_000 });
}
