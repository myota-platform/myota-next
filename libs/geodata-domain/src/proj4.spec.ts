import proj4, { projectToWgs84 } from './proj4.js';

describe('shared EPSG projection definitions', () => {
  it.each([
    [3031, [500000, 5000000], [5.710593137499642, -45.96789506692622]],
    [3413, [500000, 5000000], [129.28940686250036, 45.84803175384291]],
    [27700, [500000, 500000], [-0.461660299329062, 54.385678863409]],
    [2193, [1600000, 5000000], [173, -45.15347718443478]],
    [5070, [0, 0], [-96.00000000000001, 23.000000000000007]],
    [2056, [2600000, 1200000], [7.43863242087181, 46.9510827718711]],
    [25830, [235294.6497475471, 4142334.0458576377], [-5.99, 37.39]],
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

  it.each([
    [4230, [-5.99, 37.39], [-5.991339397674241, 37.388740840920605]],
    [23030, [235000, 4140000], [-5.993670519717036, 37.367037324028914]],
    [23031, [430000, 4580000], [2.161899860653055, 41.36662235399315]],
  ] as const)(
    'uses the Spanish IGN ED50 grid to match PyProj for EPSG:%i',
    (epsg, coordinate, expected) => {
      const actual = projectToWgs84(`EPSG:${epsg}`, [...coordinate]);
      expect(actual[0]).toBeCloseTo(expected[0], 7);
      expect(actual[1]).toBeCloseTo(expected[1], 7);
    },
  );

  it('uses the Spanish IGN grid when ED50 UTM arrives as Shapefile WKT', () => {
    const wkt =
      'PROJCS["ED_1950_UTM_Zone_30N",GEOGCS["GCS_European_1950",DATUM["D_European_1950",SPHEROID["International_1924",6378388.0,297.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-3.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
    const actual = projectToWgs84(wkt, [235000, 4140000]);

    expect(actual[0]).toBeCloseTo(-5.993670519717036, 7);
    expect(actual[1]).toBeCloseTo(37.367037324028914, 7);
  });

  it('resolves the root EPSG authority when ED50 UTM arrives as WKT2', () => {
    const wkt =
      'PROJCRS["ED50 / UTM zone 30N",BASEGEOGCRS["ED50",DATUM["European Datum 1950",ELLIPSOID["International 1924",6378388,297,LENGTHUNIT["metre",1]]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",4230]],CONVERSION["UTM zone 30N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],PARAMETER["Longitude of natural origin",-3,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1],ID["EPSG",8805]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1],ID["EPSG",8806]],PARAMETER["False northing",0,LENGTHUNIT["metre",1],ID["EPSG",8807]]],CS[Cartesian,2],AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",23030]]';
    const actual = projectToWgs84(wkt, [235000, 4140000]);

    expect(actual[0]).toBeCloseTo(-5.993670519717036, 7);
    expect(actual[1]).toBeCloseTo(37.367037324028914, 7);
  });

  it('uses the Spanish IGN grid when geographic ED50 arrives as WKT', () => {
    const wkt =
      'GEOGCS["GCS_European_1950",DATUM["D_European_1950",SPHEROID["International_1924",6378388.0,297.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
    const actual = projectToWgs84(wkt, [-5.99, 37.39]);

    expect(actual[0]).toBeCloseTo(-5.991339397674241, 7);
    expect(actual[1]).toBeCloseTo(37.388740840920605, 7);
  });

  it('keeps the bundled ED50 fallback outside the PyProj Spain operation area', () => {
    const coordinate = [500000, 6000000];
    expect(projectToWgs84('EPSG:23030', coordinate)).toEqual(
      proj4('EPSG:23030', 'EPSG:4326', coordinate),
    );
  });
});
