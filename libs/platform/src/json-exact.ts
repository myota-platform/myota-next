export class JsonNumber {
  constructor(
    readonly value: number | bigint,
    readonly floating: boolean,
  ) {}
}

const floatingFields = new WeakMap<object, ReadonlySet<string>>();

export function isJsonFloatingField(value: object, field: string): boolean {
  return floatingFields.get(value)?.has(field) ?? false;
}

/** Parse JSON while keeping integer tokens exact outside JavaScript's safe range. */
export function parseJsonWithExactIntegers(rawBody: string): unknown {
  return parseJson(rawBody, true);
}

/** Preserve direct float-token metadata without changing JSON number values. */
export function parseJsonWithFloatMetadata(rawBody: string): unknown {
  return parseJson(rawBody, false);
}

function parseJson(rawBody: string, preserveLargeIntegers: boolean): unknown {
  const materialize = (value: unknown): unknown => {
    if (value instanceof JsonNumber) {
      if (value.floating) return value.value;
      const integer = value.value as bigint;
      if (
        !preserveLargeIntegers ||
        (integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
          integer <= BigInt(Number.MAX_SAFE_INTEGER))
      )
        return Number(integer);
      return integer;
    }
    if (Array.isArray(value)) {
      let floatKeys: Set<string> | undefined;
      const items = value.map((item, index) => {
        if (item instanceof JsonNumber && item.floating)
          (floatKeys ??= new Set()).add(String(index));
        return materialize(item);
      });
      if (floatKeys) floatingFields.set(items, floatKeys);
      return items;
    }
    if (isRecord(value)) {
      let floatKeys: Set<string> | undefined;
      for (const [key, item] of Object.entries(value)) {
        if (item instanceof JsonNumber && item.floating)
          (floatKeys ??= new Set()).add(key);
        value[key] = materialize(item);
      }
      if (floatKeys) floatingFields.set(value, floatKeys);
    }
    return value;
  };
  return materialize(new JsonParser(rawBody).parse());
}

export class JsonParser {
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
