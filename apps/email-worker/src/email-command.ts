const MAX_COMMAND_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEMPLATES = new Set([
  'account-created-participant.v1',
  'account-created-administrator.v1',
  'participant-email-verification.v1',
]);

export type EmailCommand = {
  workId: string;
  recipientAccountId: string;
  templateId: string;
  templateData: Record<string, unknown>;
};

export function parseEmailCommand(raw: Uint8Array): EmailCommand {
  if (raw.byteLength > MAX_COMMAND_BYTES)
    throw new Error('email command exceeds contract limit');
  const envelope: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw),
  );
  if (
    !isRecord(envelope) ||
    !hasOnly(envelope, [
      'envelopeVersion',
      'workId',
      'workType',
      'createdAt',
      'producer',
      'aggregate',
      'correlationId',
      'causationId',
      'payload',
    ]) ||
    envelope.envelopeVersion !== 1 ||
    envelope.workType !== 'email.send.v1' ||
    !isStringWithinLength(envelope.producer, 1, 80) ||
    !UUID.test(String(envelope.workId)) ||
    typeof envelope.createdAt !== 'string' ||
    !isValidUtcDateTime(envelope.createdAt) ||
    (envelope.aggregate !== undefined && !isRecord(envelope.aggregate)) ||
    (envelope.correlationId !== undefined &&
      !isStringWithinLength(envelope.correlationId, 0, 200)) ||
    (envelope.causationId !== undefined &&
      !isStringWithinLength(envelope.causationId, 0, 200)) ||
    !isRecord(envelope.payload)
  )
    throw new Error('invalid email command envelope');
  const payload = envelope.payload;
  if (
    !hasOnly(payload, [
      'requestId',
      'recipientAccountId',
      'templateId',
      'templateData',
    ]) ||
    !UUID.test(String(payload.requestId)) ||
    String(payload.requestId).toLowerCase() !==
      String(envelope.workId).toLowerCase() ||
    !UUID.test(String(payload.recipientAccountId)) ||
    typeof payload.templateId !== 'string' ||
    !TEMPLATES.has(payload.templateId) ||
    !isRecord(payload.templateData)
  )
    throw new Error('invalid email command payload');
  const data = payload.templateData;
  if (payload.templateId === 'account-created-participant.v1') {
    if (!hasOnly(data, ['displayName']) || !validText(data.displayName, 120))
      throw new Error('invalid participant email data');
  } else if (payload.templateId === 'account-created-administrator.v1') {
    if (
      !hasOnly(data, ['createdAccountName', 'createdAccountRole']) ||
      !validText(data.createdAccountName, 120) ||
      !['PARTICIPANT', 'ADMINISTRATOR'].includes(
        String(data.createdAccountRole),
      )
    )
      throw new Error('invalid administrator email data');
  } else {
    if (
      !hasOnly(data, ['displayName', 'verificationUrl']) ||
      !validText(data.displayName, 120) ||
      !validText(data.verificationUrl, 2048) ||
      !isSafeVerificationUrl(data.verificationUrl)
    )
      throw new Error('invalid participant verification email data');
  }
  return {
    workId: String(envelope.workId).toLowerCase(),
    recipientAccountId: String(payload.recipientAccountId).toLowerCase(),
    templateId: payload.templateId,
    templateData: data,
  };
}

export function renderEmailMessage(command: EmailCommand) {
  if (command.templateId === 'account-created-participant.v1') {
    const name = String(command.templateData.displayName);
    return {
      subject: 'Your MyOTA account is ready',
      text: `Hello ${name},\n\nYour MyOTA participant account has been created.\n`,
      html: `<p>Hello ${escapeHtml(name)},</p><p>Your MyOTA participant account has been created.</p>`,
    };
  }
  if (command.templateId === 'participant-email-verification.v1') {
    const name = String(command.templateData.displayName);
    const verificationUrl = String(command.templateData.verificationUrl);
    return {
      subject: 'Verify your MyOTA email address',
      text: `Hello ${name},\n\nVerify your email address to activate your MyOTA participant account:\n${verificationUrl}\n\nThis link expires after 24 hours and can only be used once. If you did not request this account, you can ignore this message.\n`,
      html: `<p>Hello ${escapeHtml(name)},</p><p>Verify your email address to activate your MyOTA participant account:</p><p><a href="${escapeHtml(verificationUrl)}">Verify email address</a></p><p>This link expires after 24 hours and can only be used once. If you did not request this account, you can ignore this message.</p>`,
    };
  }
  const name = String(command.templateData.createdAccountName);
  const role = String(command.templateData.createdAccountRole).toLowerCase();
  return {
    subject: 'A MyOTA account was created',
    text: `Hello,\n\nA ${role} account for ${name} was created.\n`,
    html: `<p>Hello,</p><p>A ${escapeHtml(role)} account for ${escapeHtml(name)} was created.</p>`,
  };
}

function isSafeVerificationUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.username === '' &&
      url.password === '' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function isValidUtcDateTime(value: string) {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(
      value,
    );
  if (!match || match[0] !== value) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
    };
    return entities[character];
  });
}

function validText(value: unknown, maxLength: number): value is string {
  return isStringWithinLength(value, 1, maxLength);
}

function isStringWithinLength(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  if (typeof value !== 'string') return false;
  const characterCount = Array.from(value).length;
  return characterCount >= minLength && characterCount <= maxLength;
}

function hasOnly(record: Record<string, unknown>, keys: string[]) {
  return Object.keys(record).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
