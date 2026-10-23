import { describe, expect, it } from 'vitest';
import { validateCreate } from './geodata-upload.service.js';

describe('geodata upload metadata', () => {
  it.each([
    ['KML', 'parks.kml'],
    ['GPX', 'routes.gpx'],
    ['KML', 'parks.xml'],
    ['GPX', 'routes.data'],
  ])('accepts %s uploads', (format, filename) => {
    const result = validateCreate({
      adapter: 'MANUAL',
      source: { name: 'fixture' },
      filename,
      format,
      expectedSize: 128,
      entityTypes: ['PARK'],
    });
    expect(result.metadata.format).toBe(format);
    expect(result.filename).toBe(filename);
  });
});
