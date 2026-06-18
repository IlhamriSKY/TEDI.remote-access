// Base64 <-> raw bytes. Terminal data is binary, so we never round-trip through
// UTF-16 strings: incoming frames decode to Uint8Array (fed straight to xterm),
// outgoing keystrokes encode their UTF-8 bytes.

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function strToB64(str: string): string {
  return bytesToB64(new TextEncoder().encode(str));
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
