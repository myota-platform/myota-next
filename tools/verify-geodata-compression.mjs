import assert from 'node:assert/strict';
import https from 'node:https';
import zlib from 'node:zlib';

function request(url, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      target,
      { headers: { 'accept-encoding': acceptEncoding } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.setTimeout(60_000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

const tilePath = '/v1/geodata/tiles/5/15/12?status=APPROVED%2CCANDIDATE';
const origins = [
  process.env.MYOTA_TEST_API_URL || 'https://myota-test.spainip.es',
  process.env.MYOTA_TEST_ADMIN_URL || 'https://myota-admin-test.spainip.es',
];

for (const origin of origins) {
  const url = new URL(tilePath, origin).toString();
  const [plain, brotli, gzip] = await Promise.all([
    request(url, 'identity'),
    request(url, 'br'),
    request(url, 'gzip'),
  ]);

  assert.equal(plain.status, 200, `identity request returned ${plain.status}`);
  assert.equal(brotli.status, 200, `Brotli request returned ${brotli.status}`);
  assert.equal(
    String(brotli.headers['content-encoding'] || '').toLowerCase(),
    'br',
    `Brotli was not negotiated from ${origin}`,
  );
  assert.equal(gzip.status, 200, `gzip request returned ${gzip.status}`);
  assert.equal(
    String(gzip.headers['content-encoding'] || '').toLowerCase(),
    'gzip',
    `gzip fallback was not negotiated from ${origin}`,
  );
  for (const [encoding, response, decompress] of [
    ['br', brotli, zlib.brotliDecompressSync],
    ['gzip', gzip, zlib.gunzipSync],
  ]) {
    assert.match(String(response.headers.vary || ''), /accept-encoding/i);
    const decoded = decompress(response.body);
    assert.deepEqual(
      decoded,
      plain.body,
      `${encoding} tile differs from identity response from ${origin}`,
    );
    assert.ok(
      response.body.length < plain.body.length,
      `${encoding} did not reduce payload size from ${origin}`,
    );
    assert.equal(
      JSON.parse(decoded.toString('utf8')).type,
      'FeatureCollection',
    );
    console.log(
      `Verified ${encoding}: ${plain.body.length} -> ${response.body.length} bytes (${url})`,
    );
  }
}
