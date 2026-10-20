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

/** Format a finite binary64 value like Python's `repr(float)`. */
export function pythonFloatString(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0 || Object.is(value, -0);
  const absolute = Math.abs(value);
  if (absolute === 0) return negative ? '-0.0' : '0.0';

  const [mantissa, exponentText] = absolute.toString().toLowerCase().split('e');
  const explicitExponent = exponentText ? Number(exponentText) : 0;
  const dot = mantissa.indexOf('.');
  const decimalPosition = dot < 0 ? mantissa.length : dot;
  let digits = mantissa.replace('.', '');
  let adjustedPosition = decimalPosition + explicitExponent;
  const leadingZeroes = digits.match(/^0+/)?.[0].length ?? 0;
  digits = digits.slice(leadingZeroes);
  adjustedPosition -= leadingZeroes;
  digits = digits.replace(/0+$/, '');
  const scientificExponent = adjustedPosition - 1;
  const sign = negative ? '-' : '';

  if (scientificExponent >= 16 || scientificExponent < -4) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    const exponentSign = scientificExponent >= 0 ? '+' : '-';
    const exponent = String(Math.abs(scientificExponent)).padStart(2, '0');
    return `${sign}${digits[0]}${fraction}e${exponentSign}${exponent}`;
  }

  const point = scientificExponent + 1;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length)
    return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
