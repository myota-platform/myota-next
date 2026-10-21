import { describe, expect, it } from 'vitest';
import { parseXmlImport } from './geodata-xml-import.js';

describe('parseXmlImport', () => {
  it('parses GPX waypoint and track coordinates from SAX attributes', () => {
    expect(
      parseXmlImport(
        'GPX',
        '<gpx><wpt lat="37.39" lon="-5.99"><name>Waypoint</name></wpt><trk><trkseg><trkpt lat="37.39" lon="-5.99"/><trkpt lat="37.40" lon="-5.98"/></trkseg></trk></gpx>',
      ),
    ).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-5.99, 37.39] },
        properties: { name: 'Waypoint' },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-5.99, 37.39],
            [-5.98, 37.4],
          ],
        },
        properties: {},
      },
    ]);
  });
});
