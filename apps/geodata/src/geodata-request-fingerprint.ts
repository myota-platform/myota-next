import { createHash } from 'node:crypto';

class JsonNumber {
  constructor(
    readonly value: number | bigint,
    readonly floating: boolean,
  ) {}
}

export function fingerprintJsonRequest(
  body: unknown,
  rawBody?: string,
): string {
  const value = rawBody === undefined ? body : new JsonParser(rawBody).parse();
  return createHash('sha256').update(pythonJson(value)).digest('hex');
}

function pythonJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return pythonJsonString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof JsonNumber)
    return value.floating
      ? pythonFloat(value.value as number)
      : String(value.value);
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : pythonFloat(value);
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort(compareCodePoints)
      .map((key) => `${pythonJsonString(key)}: ${pythonJson(value[key])}`)
      .join(', ')}}`;
  return 'null';
}

function pythonJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function pythonFloat(value: number): string {
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

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) =>
    character.codePointAt(0)!,
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index])
      return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

class JsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const result = this.value();
    this.whitespace();
    if (this.index !== this.source.length)
      throw new Error('invalid JSON request body');
    return result;
  }

  private value(): unknown {
    this.whitespace();
    const character = this.source[this.index];
    if (character === '{') return this.object();
    if (character === '[') return this.array();
    if (character === '"') return this.string();
    if (character === 't') return this.literal('true', true);
    if (character === 'f') return this.literal('false', false);
    if (character === 'n') return this.literal('null', null);
    return this.number();
  }

  private object(): Record<string, unknown> {
    this.index += 1;
    this.whitespace();
    const result: Record<string, unknown> = Object.create(null);
    if (this.source[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (true) {
      this.whitespace();
      const key = this.string();
      this.whitespace();
      this.expect(':');
      result[key] = this.value();
      this.whitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return result;
      }
      this.expect(',');
    }
  }

  private array(): unknown[] {
    this.index += 1;
    this.whitespace();
    const result: unknown[] = [];
    if (this.source[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.whitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return result;
      }
      this.expect(',');
    }
  }

  private string(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        return JSON.parse(this.source.slice(start, this.index)) as string;
      }
      if (character === '\\') this.index += 1;
      this.index += 1;
    }
    throw new Error('invalid JSON request body');
  }

  private number(): JsonNumber {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) throw new Error('invalid JSON request body');
    this.index += match[0].length;
    const floating = /[.eE]/.test(match[0]);
    return new JsonNumber(
      floating ? Number(match[0]) : BigInt(match[0]),
      floating,
    );
  }

  private literal<T>(source: string, value: T): T {
    if (!this.source.startsWith(source, this.index))
      throw new Error('invalid JSON request body');
    this.index += source.length;
    return value;
  }

  private whitespace() {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }

  private expect(character: string) {
    if (this.source[this.index] !== character)
      throw new Error('invalid JSON request body');
    this.index += 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
