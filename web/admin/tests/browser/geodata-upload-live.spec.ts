import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';

test('uploads and preprocesses GeoJSON, OSM GeoJSON, KML, GPX, OSM PBF, and Shapefile through the resumable live workflow', async ({
  page,
}) => {
  test.setTimeout(120_000);
  test.skip(
    process.env.MYOTA_BROWSER_GEODATA_WORKERS !== '1',
    'requires the CI Geodata workers and JetStream topology',
  );
  const databaseUrl = process.env.GEO_DATABASE_URL;
  const coreDatabaseUrl = process.env.CORE_DATABASE_URL;
  test.skip(
    !databaseUrl || !coreDatabaseUrl,
    'requires the isolated Core and Geodata parity databases',
  );
  if (!databaseUrl || !coreDatabaseUrl) return;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const corePool = new Pool({ connectionString: coreDatabaseUrl, max: 1 });
  const fixture = await pool.connect();
  const suffix = randomUUID();
  const entityTypeCode = `LIVE_FILE_${suffix.replaceAll('-', '').slice(0, 14).toUpperCase()}`;
  const shapefile = await readFile(
    new URL(
      '../../../../apps/geodata-worker/src/fixtures/python-point-shapefile.zip',
      import.meta.url,
    ),
  );
  const osmPbf = await readFile(
    new URL(
      '../../../../apps/geodata-worker/src/fixtures/python-osm-parity.osm.pbf',
      import.meta.url,
    ),
  );
  const sources = [
    {
      format: 'GEOJSON',
      filename: `browser-${suffix}.geojson`,
      mimeType: 'application/geo+json',
      featureName: `Uploaded GeoJSON ${suffix}`,
      content: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: `Uploaded GeoJSON ${suffix}` },
            geometry: { type: 'Point', coordinates: [7.123456, 46.234567] },
          },
        ],
      }),
    },
    {
      format: 'OSM_GEOJSON',
      filename: `browser-${suffix}-osm.geojson`,
      mimeType: 'application/geo+json',
      adapter: 'OSM',
      featureName: `Uploaded OSM GeoJSON ${suffix}`,
      content: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: `Uploaded OSM GeoJSON ${suffix}`,
              leisure: 'park',
            },
            geometry: { type: 'Point', coordinates: [7.123456, 46.234567] },
          },
        ],
      }),
    },
    {
      format: 'KML',
      filename: `browser-${suffix}.kml`,
      mimeType: 'application/vnd.google-earth.kml+xml',
      featureName: `Uploaded KML ${suffix}`,
      content: `<?xml version="1.0"?><kml><Document><Placemark><name>Uploaded KML ${suffix}</name><Point><coordinates>7.123456,46.234567</coordinates></Point></Placemark></Document></kml>`,
    },
    {
      format: 'GPX',
      filename: `browser-${suffix}.gpx`,
      mimeType: 'application/gpx+xml',
      featureName: `Uploaded GPX ${suffix}`,
      content: `<?xml version="1.0"?><gpx version="1.1" creator="MyOTA"><wpt lat="46.234567" lon="7.123456"><name>Uploaded GPX ${suffix}</name></wpt></gpx>`,
    },
    {
      format: 'OSM_PBF',
      filename: `browser-${suffix}.osm.pbf`,
      mimeType: 'application/octet-stream',
      adapter: 'OSM',
      featureName: 'Node Park',
      content: osmPbf,
      minimumCandidates: 2,
    },
    {
      format: 'SHAPEFILE',
      filename: `browser-${suffix}.zip`,
      mimeType: 'application/zip',
      featureName: 'Unnamed candidate',
      content: shapefile,
    },
  ].map((source) => ({
    ...source,
    bytes: Buffer.from(source.content),
    adapter: 'adapter' in source ? source.adapter : 'MANUAL',
    storedFormat: source.format === 'OSM_GEOJSON' ? 'GEOJSON' : source.format,
    minimumCandidates:
      'minimumCandidates' in source ? source.minimumCandidates : 1,
  }));
  const uploadSessionIds: string[] = [];

  try {
    await page.goto('/master-data');
    await expect(page).toHaveURL(/\/login\?redirect=\/master-data$/);
    await page
      .getByLabel('Email')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_EMAIL ??
          'browser-e2e-admin@example.test',
      );
    await page
      .getByLabel('Password')
      .fill(
        process.env.MYOTA_BOOTSTRAP_ADMIN_PASSWORD ??
          'browser-e2e-password-7!Q',
      );
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/master-data$/);
    await page.getByRole('button', { name: 'New category' }).click();
    await page.getByLabel('Category code').fill(entityTypeCode);
    await page
      .getByLabel('Display name')
      .fill(`Live file category ${suffix.slice(0, 8)}`);
    for (const geometry of [
      'Point',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
    ]) {
      await page.getByRole('checkbox', { name: geometry, exact: true }).check();
    }
    await page
      .getByLabel('Description')
      .fill('Temporary category for the resumable file upload workflow.');
    await page.getByRole('button', { name: 'Save category' }).click();
    await expect(page.getByText('Category saved.')).toBeVisible();

    for (const source of sources) {
      await page.goto('/geodata-imports');
      await expect(page).toHaveURL(/\/geodata-imports$/);
      await page
        .locator('form')
        .getByRole('combobox')
        .first()
        .selectOption(source.format);
      await page.getByLabel('Feature category').selectOption(entityTypeCode);
      await page
        .getByLabel('Source label')
        .fill(`Browser ${source.format} source ${suffix}`);
      await page.getByLabel('Licence').fill('CC BY 4.0');
      await page
        .getByLabel('Attribution')
        .fill(`Browser ${source.format} multipart upload fixture`);
      await page.getByLabel('Upload file').setInputFiles({
        name: source.filename,
        mimeType: source.mimeType,
        buffer: source.bytes,
      });

      const uploadSessionResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          url.pathname === '/v1/geodata/import-uploads'
        );
      });
      const completionResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          /^\/v1\/geodata\/import-uploads\/[^/]+\/complete$/.test(url.pathname)
        );
      });
      await page.getByRole('button', { name: 'Queue preprocessing' }).click();
      const uploadSession = await uploadSessionResponse;
      const uploadSessionId = (await uploadSession.json()).uploadId as string;
      if (uploadSessionId) uploadSessionIds.push(uploadSessionId);
      expect(uploadSession.status()).toBe(201);
      expect(uploadSessionId).toMatch(/^[0-9a-f-]{36}$/i);

      const completion = await completionResponse;
      expect(completion.status()).toBe(202);
      const importRunId = (await completion.json()).importRun.id as string;
      expect(importRunId).toMatch(/^[0-9a-f-]{36}$/i);

      await expect(
        page.getByText('Dataset queued for preprocessing.'),
      ).toBeVisible();
      await expect(page.getByText('Review pre-processed records')).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page.getByRole('button', { name: source.featureName }),
      ).toBeVisible();

      const persisted = await fixture.query<{
        upload_status: string;
        filename: string;
        expected_size: string;
        import_status: string;
        adapter_code: string;
        format: string;
        object_key: string;
        source_hash: string;
        parts: number;
        part_size: string;
        candidate_names: string[];
        candidate_count: number;
      }>(
        `SELECT u.status AS upload_status,u.filename,u.expected_size::text,
              r.status AS import_status,
              r.adapter_code,
              r.source_metadata->>'format' AS format,
              r.source_metadata->'source'->>'objectKey' AS object_key,
              r.source_hash,
              (SELECT count(*)::int FROM geodata_upload_part p
                WHERE p.upload_session_id=u.id) AS parts,
              (SELECT size_bytes::text FROM geodata_upload_part p
                WHERE p.upload_session_id=u.id AND p.part_number=1) AS part_size,
              (SELECT array_agg(c.name ORDER BY c.ordinal)
                 FROM geodata_import_candidate c WHERE c.import_run_id=r.id)
                AS candidate_names,
              (SELECT count(*)::int FROM geodata_import_candidate c
                WHERE c.import_run_id=r.id) AS candidate_count
         FROM geodata_upload_session u
         JOIN import_run r ON r.id=u.import_run_id
          WHERE u.id=$1::uuid`,
        [uploadSessionId],
      );
      expect(persisted.rows).toEqual([
        {
          upload_status: 'COMPLETED',
          filename: source.filename,
          expected_size: String(source.bytes.length),
          import_status: 'PREPROCESSED',
          adapter_code: source.adapter,
          format: source.storedFormat,
          object_key: expect.stringContaining(
            `geodata-imports/${importRunId}-`,
          ),
          source_hash: expect.any(String),
          parts: 1,
          part_size: String(source.bytes.length),
          candidate_names: expect.arrayContaining([source.featureName]),
          candidate_count: expect.any(Number),
        },
      ]);
      expect(persisted.rows[0]?.candidate_count).toBeGreaterThanOrEqual(
        source.minimumCandidates ?? 1,
      );
    }
  } finally {
    try {
      if (uploadSessionIds.length) {
        await fixture.query('BEGIN');
        await fixture.query(
          "SELECT set_config('myota.geodata_writer','row-v1',true)",
        );
        for (const uploadSessionId of uploadSessionIds) {
          const linkedImport = await fixture.query<{
            import_run_id: string | null;
          }>(
            'SELECT import_run_id::text FROM geodata_upload_session WHERE id=$1::uuid',
            [uploadSessionId],
          );
          const importRunId = linkedImport.rows[0]?.import_run_id;
          await fixture.query(
            `DELETE FROM outbox_event
             WHERE aggregate_id=$1 OR aggregate_id IN (
               SELECT id::text FROM geodata_import_processing_queue
               WHERE import_run_id=$1::uuid
             )`,
            [importRunId ?? uploadSessionId],
          );
          if (importRunId) {
            await fixture.query(
              'DELETE FROM source_snapshot_manifest WHERE import_run_id=$1::uuid',
              [importRunId],
            );
            await fixture.query(
              'DELETE FROM geodata_import_candidate_stage WHERE import_run_id=$1::uuid',
              [importRunId],
            );
            await fixture.query('DELETE FROM import_run WHERE id=$1::uuid', [
              importRunId,
            ]);
          }
          await fixture.query(
            `DELETE FROM idempotency_record
             WHERE service='geodata-service' AND response->>'uploadId'=$1`,
            [uploadSessionId],
          );
          await fixture.query(
            'DELETE FROM geodata_upload_session WHERE id=$1::uuid',
            [uploadSessionId],
          );
        }
        await fixture.query('COMMIT');
      }
    } finally {
      await fixture.query('ROLLBACK').catch(() => undefined);
      fixture.release();
      await pool.end();
      await corePool.query('DELETE FROM programme_entity_type WHERE code=$1', [
        entityTypeCode,
      ]);
      await corePool.end();
    }
  }
});
