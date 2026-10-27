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

  it.each([
    ['A4', 'PORTRAIT', 1241, 1754],
    ['A4', 'LANDSCAPE', 1754, 1241],
    ['LETTER', 'PORTRAIT', 1275, 1650],
    ['LETTER', 'LANDSCAPE', 1650, 1275],
  ])(
    'resizes a mismatched source for %s %s at 150 DPI without modifying it',
    async (page, orientation, widthPx, heightPx) => {
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
      const resized = await resizeCertificateBackground(source, {
        page,
        orientation,
        dpi: 150,
      });
      const sourceMetadata = await sharp(source).metadata();
      const outputMetadata = await sharp(resized).metadata();

      expect({
        width: sourceMetadata.width,
        height: sourceMetadata.height,
      }).toEqual({
        width: 640,
        height: 480,
      });
      expect({
        width: outputMetadata.width,
        height: outputMetadata.height,
      }).toEqual({
        width: widthPx,
        height: heightPx,
      });
    },
  );

  it('rejects unsupported print profiles', () => {
    expect(() =>
      certificatePixelDimensions({
        page: 'A3',
        orientation: 'PORTRAIT',
        dpi: 300,
      }),
    ).toThrow('certificate print profile is invalid');
  });

  it.each([149, 301])('rejects %i DPI outside the supported range', (dpi) => {
    expect(() =>
      certificatePixelDimensions({
        page: 'A4',
        orientation: 'PORTRAIT',
        dpi,
      }),
    ).toThrow('certificate print profile is invalid');
  });

  it('returns a clear error for invalid background data', async () => {
    await expect(
      resizeCertificateBackground(Buffer.from('not an image'), {
        page: 'A4',
        orientation: 'PORTRAIT',
        dpi: 300,
      }),
    ).rejects.toThrow(
      'certificate background must be a valid PNG or JPEG image',
    );
  });

  it('rejects backgrounds above the processing pixel limit before resizing', async () => {
    const source = await sharp({
      create: {
        width: 4096,
        height: 4096,
        channels: 3,
        background: { r: 24, g: 92, b: 132 },
      },
    })
      .png()
      .toBuffer();

    await expect(
      resizeCertificateBackground(source, {
        page: 'A4',
        orientation: 'PORTRAIT',
        dpi: 300,
      }),
    ).rejects.toThrow(
      'certificate background exceeds the 16 million pixel processing limit',
    );
  });
});
