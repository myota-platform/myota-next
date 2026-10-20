import { createHmac, timingSafeEqual } from 'node:crypto';

export const MYOTA_CLIENT_ADDRESS_HEADER = 'x-myota-client-address';
export const MYOTA_CLIENT_ADDRESS_SIGNATURE_HEADER =
  'x-myota-client-address-signature';

export function signClientAddress(address: string, secret: string): string {
  return createHmac('sha256', secret).update(address).digest('hex');
}

export function verifyClientAddress(
  address: string,
  signature: string,
  secret: string,
): boolean {
  if (!secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const supplied = Buffer.from(signature, 'hex');
  const expected = Buffer.from(signClientAddress(address, secret), 'hex');
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
