import { utf8Bytes, decodeBase64Url } from '@cindy/device-link';
export const encodeText = utf8Bytes;
export function fromBase64(value: string): Uint8Array {
  const bytes = decodeBase64Url(value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  if (!bytes) throw new Error('INVALID_BASE64');
  return bytes;
}
