import { Client } from 'pg';

const databaseUrl = process.env.GEO_PARITY_DATABASE_URL;
if (!databaseUrl) {
  throw new Error('GEO_PARITY_DATABASE_URL is required for this check');
}
const databaseHost = new URL(databaseUrl).hostname;
if (!['localhost', '127.0.0.1', '[::1]', 'geo-db'].includes(databaseHost)) {
  throw new Error(
    'GEO_PARITY_DATABASE_URL must point to a local test database',
  );
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  for (const database of ['myota_core', 'myota_activity']) {
    const result = await client.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [database],
    );
    if (!result.rowCount) await client.query(`CREATE DATABASE "${database}"`);
  }
} finally {
  await client.end();
}
