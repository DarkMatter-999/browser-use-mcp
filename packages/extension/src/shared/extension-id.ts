function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function deriveExtensionId(publicKeyBase64: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", base64ToBytes(publicKeyBase64)),
  );
  let id = "";
  for (const byte of digest.slice(0, 16)) {
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}
