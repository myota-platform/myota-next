import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function renderCertificatePdf(input: {
  printSpec: Record<string, unknown>;
  elements: Record<string, unknown>[];
  values: Record<string, string>;
  background?: Buffer;
  signature?: Buffer;
}) {
  const pageValue = input.printSpec.page;
  const page = typeof pageValue === 'string' ? pageValue.toUpperCase() : 'A4';
  const orientationValue = input.printSpec.orientation;
  const orientation =
    typeof orientationValue === 'string'
      ? orientationValue.toUpperCase()
      : 'PORTRAIT';
  let [widthMm, heightMm] = page === 'LETTER' ? [215.9, 279.4] : [210, 297];
  if (orientation === 'LANDSCAPE') [widthMm, heightMm] = [heightMm, widthMm];
  const width = (widthMm / 25.4) * 72;
  const height = (heightMm / 25.4) * 72;
  const document = await PDFDocument.create();
  const sheet = document.addPage([width, height]);
  if (input.background) {
    const background = await embedImage(document, input.background);
    sheet.drawImage(background, { x: 0, y: 0, width, height });
  }
  const signature = input.signature
    ? await embedImage(document, input.signature)
    : undefined;
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const item of input.elements) {
    const x = Number(item.x) * width;
    const boxWidth = Number(item.width) * width;
    const boxHeight = Number(item.height) * height;
    const top = Number(item.y) * height;
    const y = height - top - boxHeight;
    if (item.kind === 'MANAGER_SIGNATURE' && signature) {
      const scale = Math.min(
        boxWidth / signature.width,
        boxHeight / signature.height,
      );
      const imageWidth = signature.width * scale;
      const imageHeight = signature.height * scale;
      sheet.drawImage(signature, {
        x: x + (boxWidth - imageWidth) / 2,
        y: y + (boxHeight - imageHeight) / 2,
        width: imageWidth,
        height: imageHeight,
      });
      continue;
    }
    const text = (
      input.values[String(item.kind)] ??
      (item.kind === 'MANAGER_SIGNATURE'
        ? 'Signature preview'
        : typeof item.label === 'string'
          ? item.label
          : '')
    ).slice(0, 200);
    if (!text) continue;
    let fontSize = Math.max(8, boxHeight * 0.55);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    if (textWidth > boxWidth)
      fontSize = Math.max(7, (fontSize * boxWidth) / textWidth);
    const drawnWidth = font.widthOfTextAtSize(text, fontSize);
    sheet.drawText(text, {
      x: x + Math.max(0, (boxWidth - drawnWidth) / 2),
      y: y + Math.max(0, (boxHeight - fontSize) / 2),
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
      maxWidth: boxWidth,
    });
  }
  return Buffer.from(await document.save());
}

async function embedImage(document: PDFDocument, content: Buffer) {
  if (
    content
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return document.embedPng(content);
  if (content[0] === 0xff && content[1] === 0xd8)
    return document.embedJpg(content);
  throw new Error('certificate asset must be PNG or JPEG');
}
