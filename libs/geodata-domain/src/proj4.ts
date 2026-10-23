import proj4 from 'proj4';
import definitions from '../data/epsg-proj4-definitions.json' with { type: 'json' };

proj4.defs(definitions as [string, string][]);

export default proj4;
