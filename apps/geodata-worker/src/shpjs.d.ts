declare module 'shpjs' {
  type ShapefileParts = {
    shp: Uint8Array;
    shx: Uint8Array;
    dbf: Uint8Array;
    prj?: Uint8Array;
    cpg?: Uint8Array;
  };

  type FeatureCollection = {
    type: 'FeatureCollection';
    features: unknown[];
  };

  function shp(parts: ShapefileParts): Promise<FeatureCollection>;

  export default shp;
}
