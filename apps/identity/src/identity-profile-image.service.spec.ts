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

  it('applies EXIF orientation and removes source metadata like Pillow', async () => {
    const source = await readFile(
      new URL('./fixtures/profile-image-exif-orientation.jpg', import.meta.url),
    );
    const expected = await readFile(
      new URL(
        './fixtures/profile-image-exif-orientation-pillow.webp',
        import.meta.url,
      ),
    );
    expect(await sharp(source).metadata()).toMatchObject({
      width: 80,
      height: 40,
      orientation: 6,
    });

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
    const actual = await internal.normalize('image/jpeg', input);
    const metadata = await sharp(actual).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(metadata.exif).toBeUndefined();
    expect(actual.toString('latin1')).not.toContain(
      'orientation parity fixture metadata',
    );

    const expectedPixels = await sharp(expected).removeAlpha().raw().toBuffer();
    const actualPixels = await sharp(actual).removeAlpha().raw().toBuffer();
    const differences = Array.from(actualPixels, (value, index) =>
      Math.abs(value - expectedPixels[index]!),
    ).sort((left, right) => left - right);
    const mean =
      differences.reduce((sum, value) => sum + value, 0) / differences.length;
    expect(mean).toBeLessThanOrEqual(2.5);
    expect(
      differences[Math.floor((differences.length - 1) * 0.99)],
    ).toBeLessThanOrEqual(8);
  });

  it('rejects APNG animation when the default image is outside the animation', async () => {
    const source = await readFile(
      new URL(
        './fixtures/profile-image-apng-default-image.png',
        import.meta.url,
      ),
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

    await expect(internal.normalize('image/png', input)).rejects.toThrow(
      'animated profile images are not supported',
    );
  });

  it('matches Pillow rejection rules for media type and input limits', async () => {
    const source = await readFile(
      new URL('./fixtures/profile-image-rgba.png', import.meta.url),
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
    const stream = (content: Uint8Array) =>
      (async function* () {
        yield content;
      })();

    await expect(
      internal.normalize('image/jpeg', stream(source)),
    ).rejects.toThrow('profile image content does not match its media type');

    const oversizedImage = await sharp({
      create: {
        width: 4097,
        height: 1,
        channels: 3,
        background: { r: 20, g: 80, b: 140 },
      },
    })
      .png()
      .toBuffer();
    await expect(
      internal.normalize('image/png', stream(oversizedImage)),
    ).rejects.toThrow('profile image dimensions exceed 4096 pixels');

    const tooManyBytes = (async function* () {
      yield Buffer.alloc(5 * 1024 * 1024);
      yield Buffer.from([0]);
    })();
    await expect(internal.normalize('image/png', tooManyBytes)).rejects.toThrow(
      'profile image must be between 1 byte and 5 MiB',
    );
  });
});
