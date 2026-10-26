import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { expect, test } from '@playwright/test';
import { expectResponsiveAccessible } from '../../../a11y';

const execFileAsync = promisify(execFile);

test('uploads and preprocesses GeoJSON, OSM, WFS, ArcGIS, KML, GPX, Shapefile, and ParkServe through the resumable live workflow', async ({
  page,
}) => {
  test.setTimeout(300_000);
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
  const configuredFeatureCount = Number(
    process.env.MYOTA_BROWSER_GEODATA_FEATURE_COUNT ?? '1',
  );
  const configuredPbfFeatureCount = Number(
    process.env.MYOTA_BROWSER_GEODATA_PBF_FEATURE_COUNT ?? '1',
  );
  if (
    !Number.isInteger(configuredFeatureCount) ||
    configuredFeatureCount < 1 ||
    configuredFeatureCount > 5000
  )
    throw new Error(
      'MYOTA_BROWSER_GEODATA_FEATURE_COUNT must be an integer from 1 to 5000',
    );
  if (
    !Number.isInteger(configuredPbfFeatureCount) ||
    configuredPbfFeatureCount < 1 ||
    configuredPbfFeatureCount > 5000
  )
    throw new Error(
      'MYOTA_BROWSER_GEODATA_PBF_FEATURE_COUNT must be an integer from 1 to 5000',
    );
  const useLoadTestCleanup =
    process.env.MYOTA_BROWSER_GEODATA_LOAD_TEST_CLEANUP === '1';
  const geodataPodUrls = (process.env.MYOTA_BROWSER_GEODATA_POD_URLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (useLoadTestCleanup && geodataPodUrls.length !== 2)
    throw new Error(
      'live Geodata qualification requires exactly two MYOTA_BROWSER_GEODATA_POD_URLS',
    );
  const loadTestRunId = `lt-${randomUUID()}`;

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
  const osmPbf =
    configuredPbfFeatureCount === 1
      ? await readFile(
          new URL(
            '../../../../apps/geodata-worker/src/fixtures/python-osm-parity.osm.pbf',
            import.meta.url,
          ),
        )
      : await createOsmPbfWorkload(configuredPbfFeatureCount);
  const sources = [
    {
      format: 'GEOJSON',
      filename: `browser-${suffix}.geojson`,
      mimeType: 'application/geo+json',
      featureName: `Uploaded GeoJSON ${suffix}`,
      content: JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from(
          { length: configuredFeatureCount },
          (_, index) => ({
            type: 'Feature',
            properties: {
              name:
                index === 0
                  ? `Uploaded GeoJSON ${suffix}`
                  : `Uploaded GeoJSON ${suffix} ${index + 1}`,
            },
            geometry: {
              type: 'Point',
              coordinates: [7.123456 + index / 100000, 46.234567],
            },
          }),
        ),
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
      format: 'WFS',
      filename: `browser-${suffix}-wfs.json`,
      mimeType: 'application/geo+json',
      adapter: 'GOVERNMENT_GIS',
      featureName: `Uploaded WFS ${suffix}`,
      content: JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: `Uploaded WFS ${suffix}`,
              sourceFormat: 'WFS',
            },
            geometry: { type: 'Point', coordinates: [7.123456, 46.234567] },
          },
        ],
      }),
    },
    {
      format: 'ARCGIS_FEATURESERVER',
      filename: `browser-${suffix}-arcgis.json`,
      mimeType: 'application/json',
      adapter: 'GOVERNMENT_GIS',
      featureName: `Uploaded ArcGIS ${suffix}`,
      content: JSON.stringify({
        spatialReference: { wkid: 4326 },
        features: [
          {
            attributes: {
              OBJECTID: 738291,
              name: `Uploaded ArcGIS ${suffix}`,
            },
            geometry: { x: 7.123456, y: 46.234567 },
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
      featureName:
        configuredPbfFeatureCount === 1 ? 'Node Park' : 'Node Park 1',
      content: osmPbf,
      minimumCandidates:
        configuredPbfFeatureCount === 1 ? 2 : configuredPbfFeatureCount,
    },
    {
      format: 'SHAPEFILE',
      filename: `browser-${suffix}.zip`,
      mimeType: 'application/zip',
      featureName: 'Unnamed candidate',
      content: shapefile,
    },
    {
      format: 'PARKSERVE_US',
      filename: `browser-${suffix}-parkserve.zip`,
      mimeType: 'application/zip',
      adapter: 'PARKSERVE_US',
      featureName: 'Unnamed candidate',
      content: shapefile,
    },
  ].map((source) => ({
    ...source,
    bytes: Buffer.from(source.content),
    adapter: 'adapter' in source ? source.adapter : 'MANUAL',
    storedFormat:
      source.format === 'OSM_GEOJSON'
        ? 'GEOJSON'
        : source.format === 'PARKSERVE_US'
          ? 'SHAPEFILE'
          : source.format,
    minimumCandidates:
      'minimumCandidates' in source ? source.minimumCandidates : 1,
  }));
  const uploadSessionIds: string[] = [];
  const uploadRequestsPerPod = geodataPodUrls.map(() => 0);
  let nextGeodataPod = 0;
  let simulatedPartFailures = 0;

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
    await page.waitForURL((url) => url.pathname === '/master-data');
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean(localStorage.getItem('myota_admin_access')),
        ),
      )
      .toBe(true);
    if (geodataPodUrls.length) {
      await page.route('**/v1/geodata/**', async (route) => {
        const requestUrl = new URL(route.request().url());
        const podIndex = nextGeodataPod++ % geodataPodUrls.length;
        const upstreamUrl = new URL(
          `${requestUrl.pathname}${requestUrl.search}`,
          geodataPodUrls[podIndex],
        ).toString();
        if (requestUrl.pathname.includes('/import-uploads'))
          uploadRequestsPerPod[podIndex] += 1;
        await route.fulfill({
          response: await route.fetch({ url: upstreamUrl }),
        });
      });
    }
    if (useLoadTestCleanup) {
      const cleanupGateStatus = await page.evaluate(async () => {
        const token = localStorage.getItem('myota_admin_access') ?? '';
        const response = await fetch('/v1/geodata/load-test-runs/invalid', {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ confirmation: 'invalid' }),
        });
        return response.status;
      });
      expect(cleanupGateStatus).toBe(400);
    }
    await page.route(
      '**/v1/geodata/import-uploads/*/parts/1',
      async (route) => {
        if (simulatedPartFailures < 3) {
          simulatedPartFailures += 1;
          await route.fulfill({
            status: 503,
            json: { message: 'Temporary upload interruption fixture.' },
          });
          return;
        }
        await route.fallback();
      },
    );
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
      const sourceStartedAt = performance.now();
      const uploadRequestCountsBefore = [...uploadRequestsPerPod];
      await page.goto('/geodata-imports');
      await expect(page).toHaveURL(/\/geodata-imports$/);
      await page
        .locator('form')
        .getByRole('combobox')
        .first()
        .selectOption(source.format);
      if (
        source.adapter === 'PARKSERVE_US' ||
        source.adapter === 'GOVERNMENT_GIS'
      )
        await page
          .locator('form')
          .getByRole('combobox')
          .nth(1)
          .selectOption(source.adapter);
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

      if (source.format === 'GEOJSON') {
        await expect(page.getByRole('alert')).toContainText(
          'Temporary upload interruption fixture.',
        );
        await expect(page.getByRole('status')).toContainText(
          'Upload interrupted',
        );
        await expect(
          page.getByRole('button', { name: 'Resume upload' }),
        ).toBeEnabled();
        expect(simulatedPartFailures).toBe(3);
        await page.getByRole('button', { name: 'Resume upload' }).click();
      }

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
        page.getByRole('button', { name: source.featureName, exact: true }),
      ).toBeVisible();
      if (source.format === 'GEOJSON')
        await expectResponsiveAccessible(
          page,
          'Live Admin resumable Geodata upload and preprocessing',
        );

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
      if (useLoadTestCleanup) {
        if (source.format === 'GEOJSON') {
          expect(uploadRequestsPerPod.every((count) => count > 0)).toBe(true);
          console.log(
            JSON.stringify({
              qualification: 'live-geodata-import',
              testRunId: loadTestRunId,
              format: source.format,
              uploadedBytes: source.bytes.length,
              expectedFeatures: configuredFeatureCount,
              preprocessedCandidates: persisted.rows[0]?.candidate_count,
              uploadRequestsPerPod,
              elapsedMilliseconds: Math.round(
                performance.now() - sourceStartedAt,
              ),
            }),
          );
        }
        if (source.format === 'OSM_PBF') {
          console.log(
            JSON.stringify({
              qualification: 'live-geodata-import',
              testRunId: loadTestRunId,
              format: source.format,
              uploadedBytes: source.bytes.length,
              expectedFeatures: configuredPbfFeatureCount,
              preprocessedCandidates: persisted.rows[0]?.candidate_count,
              uploadRequestsPerPod: uploadRequestsPerPod.map(
                (count, index) =>
                  count - (uploadRequestCountsBefore[index] ?? 0),
              ),
              elapsedMilliseconds: Math.round(
                performance.now() - sourceStartedAt,
              ),
            }),
          );
        }
      }
    }
  } finally {
    try {
      if (uploadSessionIds.length) {
        if (useLoadTestCleanup) {
          await fixture.query('BEGIN');
          await fixture.query(
            "SELECT set_config('myota.geodata_writer','row-v1',true)",
          );
          for (const uploadSessionId of uploadSessionIds) {
            await fixture.query(
              `UPDATE geodata_upload_session
               SET metadata=jsonb_set(metadata,'{source,loadTestRunId}',to_jsonb($2::text),true)
               WHERE id=$1::uuid`,
              [uploadSessionId, loadTestRunId],
            );
            await fixture.query(
              `UPDATE import_run run
               SET source_metadata=jsonb_set(run.source_metadata,'{source,loadTestRunId}',to_jsonb($2::text),true)
               FROM geodata_upload_session upload
               WHERE upload.id=$1::uuid AND run.id=upload.import_run_id`,
              [uploadSessionId, loadTestRunId],
            );
          }
          await fixture.query('COMMIT');
          const cleanup = await page.evaluate(async (testRunId) => {
            const token = localStorage.getItem('myota_admin_access') ?? '';
            const response = await fetch(
              `/v1/geodata/load-test-runs/${encodeURIComponent(testRunId)}`,
              {
                method: 'DELETE',
                headers: {
                  authorization: `Bearer ${token}`,
                  'content-type': 'application/json',
                },
                body: JSON.stringify({
                  confirmation: `DELETE LOAD TEST DATA ${testRunId}`,
                }),
              },
            );
            return {
              status: response.status,
              body: await response.json().catch(() => ({})),
            };
          }, loadTestRunId);
          if (cleanup.status !== 200 || cleanup.body.cleaned !== true)
            throw new Error(
              `isolated load-test cleanup failed with HTTP ${cleanup.status}`,
            );
        } else {
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

async function createOsmPbfWorkload(featureCount: number) {
  const directory = await mkdtemp(join(tmpdir(), 'myota-live-pbf-'));
  const xmlPath = join(directory, 'many-parks.osm');
  const pbfPath = join(directory, 'many-parks.osm.pbf');
  try {
    const nodes = Array.from({ length: featureCount }, (_, index) => {
      const id = 1_000_000_000 + index;
      const latitude = 37.39 + (index % 100) / 100_000;
      const longitude = -5.99 + Math.floor(index / 100) / 100_000;
      return `<node id="${id}" lat="${latitude}" lon="${longitude}"><tag k="leisure" v="park"/><tag k="name" v="Node Park ${index + 1}"/></node>`;
    }).join('');
    await writeFile(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?><osm version="0.6" generator="myota-live-qualification">${nodes}</osm>`,
      { mode: 0o600 },
    );
    await execFileAsync('osmium', [
      'cat',
      xmlPath,
      '--output',
      pbfPath,
      '--output-format',
      'pbf',
    ]);
    return await readFile(pbfPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
