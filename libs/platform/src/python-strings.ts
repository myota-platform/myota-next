import { isJsonFloatingField } from './json-exact.js';
import { pythonFloatString } from './python-number.js';

export function isPythonWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x09 && codePoint <= 0x0d) ||
    (codePoint >= 0x1c && codePoint <= 0x20) ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

export function trimPythonWhitespace(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && isPythonWhitespace(characters[start].codePointAt(0)!))
    start += 1;
  while (end > start && isPythonWhitespace(characters[end - 1].codePointAt(0)!))
    end -= 1;
  return characters.slice(start, end).join('');
}

export function pythonKeyErrorDetail(key: string): string {
  const quote = key.includes("'") && !key.includes('"') ? '"' : "'";
  let escaped = '';
  for (const character of key) {
    if (character === '\\') escaped += '\\\\';
    else if (character === quote) escaped += `\\${quote}`;
    else if (character === '\n') escaped += '\\n';
    else if (character === '\r') escaped += '\\r';
    else if (character === '\t') escaped += '\\t';
    else if (/[\p{C}\p{Zl}\p{Zp}]/u.test(character)) {
      const codePoint = character.codePointAt(0)!;
      if (codePoint <= 0xff) escaped += `\\x${codePoint.toString(16).padStart(2, '0')}`;
      else if (codePoint <= 0xffff)
        escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
      else escaped += `\\U${codePoint.toString(16).padStart(8, '0')}`;
    } else escaped += character;
  }
  return `${quote}${escaped}${quote}`;
}

export function pythonString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value))
    return `[${value
      .map((item, index) => pythonRepr(item, value, String(index)))
      .join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(
        ([key, item]) =>
          `${pythonKeyErrorDetail(key)}: ${pythonRepr(item, value, key)}`,
      )
      .join(', ')}}`;
  }
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  if (typeof value === 'symbol' || typeof value === 'function')
    return String(value);
  return 'None';
}

export function pythonStringJsonField(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value === 'number' && isJsonFloatingField(record, field))
    return pythonFloatString(value);
  return pythonString(value);
}

function pythonRepr(value: unknown, parent: object, field: string): string {
  if (typeof value === 'number' && isJsonFloatingField(parent, field))
    return pythonFloatString(value);
  return typeof value === 'string' ? pythonKeyErrorDetail(value) : pythonString(value);
}

export function collapsePythonWhitespace(value: string): string {
  const output: string[] = [];
  let pendingSpace = false;
  for (const character of value) {
    if (isPythonWhitespace(character.codePointAt(0)!)) {
      pendingSpace ||= output.length > 0;
      continue;
    }
    if (pendingSpace) output.push(' ');
    output.push(character);
    pendingSpace = false;
  }
  return output.join('');
}
