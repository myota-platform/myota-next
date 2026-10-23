import { createHash } from 'node:crypto';
import { scheduledFeatureHashOverrides } from '../../geodata/src/geodata-request-fingerprint.js';
import { featuresFromDocument } from './geodata-importer-document.js';

describe('Geodata scheduled import document parsing', () => {
  it('passes malformed FeatureCollection members through for per-record handling', () => {
    const features = featuresFromDocument(
      { type: 'FeatureCollection', features: [null, 17] },
      'GEOJSON',
    );

    expect(features).toEqual([null, 17]);
  });

  it('converts ArcGIS attribute pairs with Python dict semantics', () => {
    const features = featuresFromDocument(
      {
        features: [
          {
            attributes: [
              ['OBJECTID', 17],
              ['name', 'Regional trailhead'],
            ],
            geometry: { x: 7.2, y: 46.1 },
          },
        ],
      },
      'ARCGIS_FEATURESERVER',
    );

    expect(features).toEqual([
      {
        type: 'Feature',
        properties: { OBJECTID: 17, name: 'Regional trailhead' },
        geometry: { type: 'Point', coordinates: [7.2, 46.1] },
      },
    ]);
  });

  it('hashes the normalized features that the importer posts', () => {
    const features = featuresFromDocument(
      {
        features: [
          {
            attributes: [['name', 'Trailhead']],
            geometry: { x: 7, y: 46 },
          },
        ],
      },
      'ARCGIS_FEATURESERVER',
    );
    const canonical =
      '{"geometry":{"coordinates":[7,46],"type":"Point"},"properties":{"name":"Trailhead"},"type":"Feature"}';

    expect(scheduledFeatureHashOverrides(features)).toEqual([
      createHash('sha256').update(canonical, 'utf8').digest('hex'),
    ]);
  });
});
