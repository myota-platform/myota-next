import { Pool } from 'pg';
import { stringifyJsonWithBigInts } from '../../../libs/platform/src/json-bigint.js';
import { GeodataQueryMetrics } from './geodata-query-metrics.service.js';
import { GeodataRepository } from './geodata.repository.js';

const databaseUrl = process.env.GEO_DATABASE_URL;
const describeWithPostgis = databaseUrl ? describe : describe.skip;

describeWithPostgis('PostGIS map geometry generalization', () => {
  it('keeps complex multipart boundaries valid while reducing low-zoom detail', async () => {
    if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');

    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: 'myota-geodata-map-generalization-test',
    });
    const outerRing = Array.from({ length: 80 }, (_, index) => {
      const angle = (index / 80) * Math.PI * 2;
      const radius = index % 2 === 0 ? 5_000 : 4_850;
      return [
        15_000 + Math.cos(angle) * radius,
        15_000 + Math.sin(angle) * radius,
      ];
    });
    outerRing.push(outerRing[0]!);
    const hole = [
      [14_500, 14_500],
      [15_500, 14_500],
      [15_500, 15_500],
      [14_500, 15_500],
      [14_500, 14_500],
    ];
    const secondIsland = [
      [25_000, 24_000],
      [26_000, 24_000],
      [26_000, 25_000],
      [25_000, 25_000],
      [25_000, 24_000],
    ];
    const fixture = {
      type: 'MultiPolygon',
      coordinates: [[outerRing, hole], [secondIsland]],
    };

    try {
      const result = await pool.query<{
        low_valid: boolean;
        high_valid: boolean;
        low_components: number;
        high_components: number;
        low_holes: number;
        high_holes: number;
        low_points: number;
        high_points: number;
      }>(
        `WITH fixture AS (
           SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),3857) AS geom
         ), clipped AS (
           SELECT ST_Intersection(geom,ST_MakeEnvelope(0,0,30000,30000,3857)) AS geom
           FROM fixture
         ), variants AS (
           SELECT ST_SimplifyPreserveTopology(geom,500) AS low_zoom,
                  ST_SimplifyPreserveTopology(geom,0.05) AS high_zoom
           FROM clipped
         )
         SELECT ST_IsValid(low_zoom) AS low_valid,
                ST_IsValid(high_zoom) AS high_valid,
                ST_NumGeometries(low_zoom) AS low_components,
                ST_NumGeometries(high_zoom) AS high_components,
                ST_NumInteriorRings(ST_GeometryN(low_zoom,1)) AS low_holes,
                ST_NumInteriorRings(ST_GeometryN(high_zoom,1)) AS high_holes,
                ST_NumPoints(ST_ExteriorRing(ST_GeometryN(low_zoom,1))) AS low_points,
                ST_NumPoints(ST_ExteriorRing(ST_GeometryN(high_zoom,1))) AS high_points
         FROM variants`,
        [stringifyJsonWithBigInts(fixture)],
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        low_valid: true,
        high_valid: true,
        low_components: 2,
        high_components: 2,
        low_holes: 1,
        high_holes: 1,
      });
      expect(result.rows[0]!.low_points).toBeLessThan(
        result.rows[0]!.high_points,
      );
    } finally {
      await pool.end();
    }
  });

  it('generalizes caller-supplied map geometry through the repository query', async () => {
    if (!databaseUrl) throw new Error('GEO_DATABASE_URL is required');

    const pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: 'myota-geodata-admin-map-simplification-test',
    });
    const repository = new GeodataRepository(pool, new GeodataQueryMetrics());
    const ring = Array.from({ length: 80 }, (_, index) => {
      const angle = (index / 80) * Math.PI * 2;
      return [Math.cos(angle) * 0.2, Math.sin(angle) * 0.2];
    });
    ring.push(ring[0]!);
    const geometry = { type: 'Polygon', coordinates: [ring] };
    const items = [{ id: 'viewport-fixture', geometry }];

    try {
      const viewport = await repository.getAdminMapEntities({
        bbox: '-1,-1,1,1',
        zoom: '5',
      });
      expect(viewport).toMatchObject({
        limit: 500,
        zoom: 5,
        bbox: [-1, -1, 1, 1],
      });
      expect(viewport.items.length).toBeLessThanOrEqual(500);

      const [lowZoom, highZoom] = await Promise.all([
        repository.simplifyMapGeometries({ zoom: 5, items }),
        repository.simplifyMapGeometries({ zoom: 16, items }),
      ]);
      const lowCoordinates = lowZoom.items[0]?.geometry.coordinates[0];
      const highCoordinates = highZoom.items[0]?.geometry.coordinates[0];

      expect(Array.isArray(lowCoordinates)).toBe(true);
      expect(Array.isArray(highCoordinates)).toBe(true);
      expect((lowCoordinates as unknown[]).length).toBeGreaterThan(3);
      expect((lowCoordinates as unknown[]).length).toBeLessThan(
        (highCoordinates as unknown[]).length,
      );

      const validity = await pool.query<{
        low_valid: boolean;
        high_valid: boolean;
      }>(
        `SELECT ST_IsValid(ST_GeomFromGeoJSON($1)) AS low_valid,
                ST_IsValid(ST_GeomFromGeoJSON($2)) AS high_valid`,
        [
          stringifyJsonWithBigInts(lowZoom.items[0]?.geometry),
          stringifyJsonWithBigInts(highZoom.items[0]?.geometry),
        ],
      );
      expect(validity.rows[0]).toEqual({ low_valid: true, high_valid: true });
    } finally {
      await pool.end();
    }
  });
});
