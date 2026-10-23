const maxAttachments = 20;
const maxAttachmentBytes = 25 * 1024 * 1024;

export type AttachmentMetadata = {
  name: string;
  mediaType: string;
  sizeBytes: number;
  uri: unknown;
  sha256: unknown;
  license: unknown;
  caption: unknown;
};

export function normalizeAttachmentMetadata(
  value: unknown,
): AttachmentMetadata[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxAttachments)
    throw new Error(
      `attachments must be a list of at most ${maxAttachments} metadata records`,
    );
  return value.map((attachment) => {
    if (
      !isRecord(attachment) ||
      !pythonTruthy(attachment.name) ||
      !pythonTruthy(attachment.mediaType)
    )
      throw new Error('each attachment requires name and mediaType');
    const sizeBytes = parseAttachmentSize(attachment.sizeBytes);
    if (sizeBytes < 0 || sizeBytes > maxAttachmentBytes)
      throw new Error(
        `attachment size must be between 0 and ${maxAttachmentBytes} bytes`,
      );
    if (!pythonTruthy(attachment.uri) && !pythonTruthy(attachment.sha256))
      throw new Error(
        'each attachment requires a URI or sha256 content reference',
      );
    return {
      name: String(attachment.name),
      mediaType: String(attachment.mediaType),
      sizeBytes,
      uri: attachment.uri,
      sha256: attachment.sha256,
      license: attachment.license,
      caption: attachment.caption,
    };
  });
}

function parseAttachmentSize(value: unknown) {
  if (!pythonTruthy(value)) return 0;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error('attachment sizeBytes must be an integer');
}

function pythonTruthy(value: unknown) {
  if (value == null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
