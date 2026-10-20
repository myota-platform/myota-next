export function pythonStrip(value: string): string {
  const characters = Array.from(value);
  let start = 0;
  let end = characters.length;
  while (start < end && isPythonWhitespace(characters[start].codePointAt(0)!))
    start++;
  while (end > start && isPythonWhitespace(characters[end - 1].codePointAt(0)!))
    end--;
  return characters.slice(start, end).join('');
}

export function pythonCollapseWhitespace(value: string): string {
  let output = '';
  let pendingSpace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (isPythonWhitespace(codePoint)) {
      if (output) pendingSpace = true;
      continue;
    }
    if (pendingSpace) output += ' ';
    output += character;
    pendingSpace = false;
  }
  return output;
}

function isPythonWhitespace(codePoint: number): boolean {
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
