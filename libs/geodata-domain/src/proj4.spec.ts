import proj4 from './proj4.js';

describe('shared EPSG projection definitions', () => {
  it.each([
    [3031, [500000, 5000000], [5.710593137499642, -45.96789506692622]],
    [3413, [500000, 5000000], [129.28940686250036, 45.84803175384291]],
    [27700, [500000, 500000], [-0.461660299329062, 54.385678863409]],
    [2193, [1600000, 5000000], [173, -45.15347718443478]],
    [5070, [0, 0], [-96.00000000000001, 23.000000000000007]],
    [2056, [2600000, 1200000], [7.43863242087181, 46.9510827718711]],
    [25832, [500000, 5000000], [9, 45.15347718443478]],
    [28992, [155000, 463000], [5.3872035084137675, 52.15517230119224]],
  ] as const)(
    'matches PyProj for EPSG:%i within coordinate precision',
    (epsg, coordinate, expected) => {
      const actual = proj4(`EPSG:${epsg}`, 'EPSG:4326', [...coordinate]);
      expect(actual[0]).toBeCloseTo(expected[0], 7);
      expect(actual[1]).toBeCloseTo(expected[1], 7);
    },
  );
});
