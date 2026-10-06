/** Matches server NativeVoicePacket.DeriveSessionId (SHA256 first 2 bytes BE). */
export async function deriveNativeSessionId(userId: string, roomId: string): Promise<number> {
  const input = `${String(userId).replace(/-/g, "").toLowerCase()}:${roomId}`;
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const view = new DataView(hash);
  return view.getUint16(0, false);
}
