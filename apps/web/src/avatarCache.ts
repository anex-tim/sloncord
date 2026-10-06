/** LRU-кэш blob:-URL аватаров с ограничением размера (data: URL держат base64 в памяти навсегда). */

const MAX_AVATAR_CACHE_ENTRIES = 220;
const cache = new Map<string, string>();

export function getCachedAvatarUrl(fileId: string): string {
  const fid = String(fileId || "");
  if (!fid) return "";
  const hit = cache.get(fid);
  if (!hit) return "";
  cache.delete(fid);
  cache.set(fid, hit);
  return hit;
}

export function putCachedAvatarUrl(fileId: string, url: string): string {
  const fid = String(fileId || "");
  const u = String(url || "");
  if (!fid || !u) return u;
  const prev = cache.get(fid);
  if (prev && prev !== u && prev.startsWith("blob:")) {
    try { URL.revokeObjectURL(prev); } catch { /* ignore */ }
  }
  cache.delete(fid);
  cache.set(fid, u);
  while (cache.size > MAX_AVATAR_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    const oldUrl = cache.get(oldest);
    if (oldUrl?.startsWith("blob:")) {
      try { URL.revokeObjectURL(oldUrl); } catch { /* ignore */ }
    }
    cache.delete(oldest);
  }
  return u;
}

export function clearAvatarCache(): void {
  for (const url of cache.values()) {
    if (url.startsWith("blob:")) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
  }
  cache.clear();
}

/** @returns blob: URL или пустая строка */
export async function fetchAvatarBlobUrl(
  fetchFn: (path: string, options?: RequestInit) => Promise<Response>,
  fileId: string
): Promise<string> {
  const fid = String(fileId || "");
  if (!fid) return "";
  const cached = getCachedAvatarUrl(fid);
  if (cached) return cached;

  const response = await fetchFn(`/avatars/${fid}`, { method: "GET" });
  if (!response.ok) return "";
  const data = await response.json().catch(() => null);
  const b64 = String(data?.fileBase64 || "");
  if (!b64) return "";
  const ct = String(data?.contentType || "image/png");
  let blob: Blob;
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    blob = new Blob([arr], { type: ct });
  } catch {
    return "";
  }
  let url = "";
  try { url = URL.createObjectURL(blob); } catch { return ""; }
  return putCachedAvatarUrl(fid, url);
}
