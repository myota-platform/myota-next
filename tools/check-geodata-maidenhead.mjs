import { Pool } from 'pg';

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

const fixtures = [
  {
    name: 'point',
    geometry: { type: 'Point', coordinates: [2.2945, 48.8584] },
    cells4: ['JN18'],
    cells6: ['JN18du'],
  },
  {
    name: 'polygon contained in one cell',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-6.02, 37.38],
          [-6.01, 37.38],
          [-6.01, 37.39],
          [-6.02, 37.39],
          [-6.02, 37.38],
        ],
      ],
    },
    cells4: ['IM67'],
    cells6: ['IM67xj'],
  },
  {
    name: 'polygon crossing cell boundaries',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-0.01, -0.01],
          [0.01, -0.01],
          [0.01, 0.01],
          [-0.01, 0.01],
          [-0.01, -0.01],
        ],
      ],
    },
    cells4: ['II99', 'IJ90', 'JI09', 'JJ00'],
    cells6: ['II99xx', 'IJ90xa', 'JI09ax', 'JJ00aa'],
  },
  {
    name: 'line crossing subsquare boundaries',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-5.995, 37.401],
        [-5.9, 37.401],
      ],
    },
    cells4: ['IM77'],
    cells6: ['IM77aj', 'IM77bj'],
  },
];

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  for (const fixture of fixtures) {
    const result = await pool.query(
      `SELECT public.myota_maidenhead_cells_for_geometry(
                ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 4
              ) AS cells4,
              public.myota_maidenhead_cells_for_geometry(
                ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326), 6
              ) AS cells6`,
      [JSON.stringify(fixture.geometry)],
    );
    const actual = result.rows[0];
    if (
      JSON.stringify(actual.cells4) !== JSON.stringify(fixture.cells4) ||
      JSON.stringify(actual.cells6) !== JSON.stringify(fixture.cells6)
    ) {
      throw new Error(
        `${fixture.name}: expected ${JSON.stringify({ cells4: fixture.cells4, cells6: fixture.cells6 })}, got ${JSON.stringify({ cells4: actual.cells4, cells6: actual.cells6 })}`,
      );
    }
  }
  process.stdout.write(
    `Maidenhead PostGIS parity verified against ${fixtures.length} Python fixtures.\n`,
  );
} finally {
  await pool.end();
}
