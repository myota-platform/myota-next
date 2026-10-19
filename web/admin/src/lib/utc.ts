/** Radio operation times are UTC regardless of browser timezone or locale. */
export function utcIso(value: string): string {
  const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()))
    throw new Error('Enter a valid UTC date and time.');
  return date.toISOString();
}

export function utcInput(value?: string): string {
  return value ? utcIso(value).slice(0, 16) : '';
}

export function utcInputValue(value: string, original?: string): string | null {
  if (!value) return null;
  return original && value === utcInput(original)
    ? utcIso(original)
    : utcIso(value);
}

export function utcDisplay(value?: string): string {
  if (!value) return 'Not sampled yet';
  try {
    return `${utcIso(value)
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '')
      .replace(/Z$/, '')} UTC`;
  } catch {
    return 'Invalid timestamp';
  }
}
