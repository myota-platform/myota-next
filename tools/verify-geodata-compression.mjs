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

const origin =
  process.env.MYOTA_TEST_API_URL || 'https://myota-test.spainip.es';
const url = new URL(
  '/v1/geodata/tiles/5/15/12?status=APPROVED%2CCANDIDATE',
  origin,
).toString();
const [plain, encoded] = await Promise.all([
  request(url, 'identity'),
  request(url, 'br, gzip'),
]);

assert.equal(plain.status, 200, `identity request returned ${plain.status}`);
assert.equal(
  encoded.status,
  200,
  `compressed request returned ${encoded.status}`,
);
const encoding = String(
  encoded.headers['content-encoding'] || '',
).toLowerCase();
assert.ok(
  ['br', 'gzip'].includes(encoding),
  `unexpected encoding: ${encoding}`,
);
assert.match(String(encoded.headers.vary || ''), /accept-encoding/i);

const decoded =
  encoding === 'br'
    ? zlib.brotliDecompressSync(encoded.body)
    : zlib.gunzipSync(encoded.body);
assert.deepEqual(
  decoded,
  plain.body,
  'compressed tile differs from identity response',
);
assert.ok(
  encoded.body.length < plain.body.length,
  'compression did not reduce payload size',
);
assert.equal(JSON.parse(decoded.toString('utf8')).type, 'FeatureCollection');
console.log(
  `Verified ${encoding}: ${plain.body.length} -> ${encoded.body.length} bytes (${url})`,
);
