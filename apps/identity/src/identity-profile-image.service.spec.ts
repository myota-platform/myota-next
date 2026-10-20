import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { IdentityProfileImageService } from './identity-profile-image.service.js';
import type { IdentityAuthService } from './auth.service.js';

describe('IdentityProfileImageService Pillow compatibility', () => {
  it('keeps a transparent gradient crop within decoded-pixel tolerance', async () => {
    const source = await readFile(
      new URL('./fixtures/profile-image-rgba.png', import.meta.url),
    );
    const expected = await readFile(
      new URL('./fixtures/profile-image-rgba-pillow.webp', import.meta.url),
    );
    const service = new IdentityProfileImageService(
      null,
      null as unknown as IdentityAuthService,
    );
    const internal = service as unknown as {
      normalize: (
        contentType: string,
        input: AsyncIterable<Uint8Array>,
      ) => Promise<Buffer>;
    };
    const input = (async function* () {
      yield source;
    })();

    const actual = await internal.normalize('image/png', input);
    const expectedPixels = await sharp(expected).ensureAlpha().raw().toBuffer();
    const actualPixels = await sharp(actual).ensureAlpha().raw().toBuffer();
    const metadata = await sharp(actual).metadata();
    let visibleRgbDifference = 0;
    let visibleRgbValues = 0;
    let alphaDifference = 0;
    let maximumAlphaDifference = 0;
    const visibleRgbDifferences: number[] = [];
    const alphaDifferences: number[] = [];
    for (let index = 0; index < expectedPixels.length; index += 4) {
      const expectedAlpha = expectedPixels[index + 3]!;
      const actualAlpha = actualPixels[index + 3]!;
      const alphaDelta = Math.abs(expectedAlpha - actualAlpha);
      alphaDifference += alphaDelta;
      alphaDifferences.push(alphaDelta);
      maximumAlphaDifference = Math.max(maximumAlphaDifference, alphaDelta);
      if (expectedAlpha && actualAlpha) {
        for (let channel = 0; channel < 3; channel++) {
          const difference = Math.abs(
            expectedPixels[index + channel]! - actualPixels[index + channel]!,
          );
          visibleRgbDifference += difference;
          visibleRgbValues++;
          visibleRgbDifferences.push(difference);
        }
      }
    }

    const percentile = (values: number[], fraction: number) =>
      values.sort((left, right) => left - right)[
        Math.floor((values.length - 1) * fraction)
      ];

    expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(actual.byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(visibleRgbDifference / visibleRgbValues).toBeLessThanOrEqual(1.25);
    expect(percentile(visibleRgbDifferences, 0.99)).toBeLessThanOrEqual(5);
    expect(alphaDifference / (expectedPixels.length / 4)).toBeLessThanOrEqual(
      0.02,
    );
    expect(maximumAlphaDifference).toBeLessThanOrEqual(2);
  });
});
