/** Round a binary64 value to decimal places using Python's ties-to-even rule. */
export function pythonRound(value: number, decimalPlaces: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  if (
    !Number.isInteger(decimalPlaces) ||
    decimalPlaces < 0 ||
    decimalPlaces > 15
  )
    throw new RangeError('decimalPlaces must be an integer from 0 to 15');

  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const negative = bits >> 63n !== 0n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1075;

  let numerator = significand * 10n ** BigInt(decimalPlaces);
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);

  let rounded = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (
    twiceRemainder > denominator ||
    (twiceRemainder === denominator && rounded % 2n === 1n)
  )
    rounded += 1n;

  let decimal = rounded.toString();
  if (decimalPlaces > 0) {
    decimal = decimal.padStart(decimalPlaces + 1, '0');
    decimal = `${decimal.slice(0, -decimalPlaces)}.${decimal.slice(-decimalPlaces)}`;
  }
  const result = Number(decimal);
  return negative ? -result : result;
}
