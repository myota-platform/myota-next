import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import {
  certificatePixelDimensions,
  renderCertificatePdf,
  resizeCertificateBackground,
} from './certificate-renderer.js';

describe('certificate print profiles', () => {
  it.each([
    ['A4', 'PORTRAIT', 2481, 3508],
    ['A4', 'LANDSCAPE', 3508, 2481],
    ['LETTER', 'PORTRAIT', 2550, 3300],
    ['LETTER', 'LANDSCAPE', 3300, 2550],
  ])(
    'calculates %s %s output pixels at 300 DPI',
    (page, orientation, widthPx, heightPx) => {
      expect(
        certificatePixelDimensions({ page, orientation, dpi: 300 }),
      ).toEqual({
        widthPx,
        heightPx,
      });
    },
  );

  it('resizes a source image without changing it and renders Award Text', async () => {
    const source = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: { r: 24, g: 92, b: 132 },
      },
    })
      .png()
      .toBuffer();
    const spec = { page: 'LETTER', orientation: 'LANDSCAPE', dpi: 150 };
    const before = await sharp(source).metadata();
    const resized = await resizeCertificateBackground(source, spec);
    const after = await sharp(source).metadata();
    const output = await sharp(resized).metadata();

    expect({ width: before.width, height: before.height }).toEqual({
      width: 640,
      height: 480,
    });
    expect({ width: after.width, height: after.height }).toEqual({
      width: 640,
      height: 480,
    });
    expect({ width: output.width, height: output.height }).toEqual({
      width: 1650,
      height: 1275,
    });

    const pdf = await renderCertificatePdf({
      printSpec: spec,
      elements: [
        { kind: 'AWARD_NAME', x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
        { kind: 'AWARD_TEXT', x: 0.1, y: 0.2, width: 0.8, height: 0.1 },
      ],
      values: { AWARD_NAME: 'Test Award', AWARD_TEXT: 'Award Text' },
      background: source,
    });
    const document = await PDFDocument.load(pdf);
    const size = document.getPage(0).getSize();
    expect(size.width).toBeGreaterThan(size.height);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('rejects unsupported print profiles', () => {
    expect(() =>
      certificatePixelDimensions({
        page: 'A3',
        orientation: 'PORTRAIT',
        dpi: 300,
      }),
    ).toThrow('certificate print profile is invalid');
  });
});
