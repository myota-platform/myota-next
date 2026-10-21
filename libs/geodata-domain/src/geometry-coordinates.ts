export function collectCoordinatePairs(value: unknown): [number, number][] {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    isPythonNumber(value[0]) &&
    isPythonNumber(value[1])
  )
    return [[Number(value[0]), Number(value[1])]];
  if (!Array.isArray(value)) return [];
  return value.flatMap(collectCoordinatePairs);
}

export function validateGeometryCoordinates(
  type: string,
  coordinates: unknown,
  maxCoordinates: number,
): [number, number][] {
  const pairs = collectCoordinatePairs(coordinates);
  if (pairs.length === 0 || pairs.length > maxCoordinates)
    throw new Error(
      `geometry must contain between 1 and ${maxCoordinates} coordinates`,
    );
  if (
    type === 'Point' &&
    (!Array.isArray(coordinates) || coordinates.length < 2)
  )
    throw new Error('Point geometry must contain longitude and latitude');
  if (type === 'LineString' && !isLine(coordinates))
    throw new Error(
      'LineString (way) geometry must contain at least two coordinates',
    );
  if (type === 'MultiLineString' && !isMultiLine(coordinates))
    throw new Error(
      'MultiLineString geometry must contain one or more lines with at least two coordinates',
    );
  if (type === 'Polygon' && !isPolygon(coordinates))
    throw new Error(
      'Polygon geometry must contain closed rings with at least four points',
    );
  if (type === 'MultiPolygon' && !isMultiPolygon(coordinates))
    throw new Error('MultiPolygon geometry must contain closed polygon rings');
  return pairs;
}

function isLine(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((point) => Array.isArray(point) && point.length >= 2)
  );
}

function isMultiLine(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.every((line) => isLine(line))
  );
}

function isRing(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 4 &&
    pythonEqual(value[0], value[value.length - 1]) &&
    value.every((point) => Array.isArray(point) && point.length >= 2)
  );
}

function isPythonNumber(value: unknown): value is number | boolean | bigint {
  return (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

function pythonEqual(left: unknown, right: unknown): boolean {
  if (isPythonNumber(left) && isPythonNumber(right)) {
    const leftNumber = typeof left === 'boolean' ? Number(left) : left;
    const rightNumber = typeof right === 'boolean' ? Number(right) : right;
    if (typeof leftNumber === 'bigint')
      return typeof rightNumber === 'bigint'
        ? leftNumber === rightNumber
        : Number.isInteger(rightNumber) && BigInt(rightNumber) === leftNumber;
    if (typeof rightNumber === 'bigint')
      return Number.isInteger(leftNumber) && BigInt(leftNumber) === rightNumber;
    return leftNumber === rightNumber;
  }
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((value, index) => pythonEqual(value, right[index]))
    );
  return left === right;
}

function isPolygon(value: unknown): boolean {
  return Array.isArray(value) && value.every((ring) => isRing(ring));
}

function isMultiPolygon(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (polygon) =>
        Array.isArray(polygon) && polygon.every((ring) => isRing(ring)),
    )
  );
}
