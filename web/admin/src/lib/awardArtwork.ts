export function bytesFromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function inspectArtwork(
  file: File,
): Promise<{ width: number; height: number }> {
  if (!['image/png', 'image/jpeg'].includes(file.type))
    throw new Error('Choose a PNG or JPG file.');
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error('Images must be non-empty and at most 20 MiB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error('The selected file is not a valid image.'));
      image.src = url;
    });
    if (image.naturalWidth * image.naturalHeight > 16_000_000)
      throw new Error('Images may contain at most 16 million pixels.');
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
