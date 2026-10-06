export type IceServerEntry = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export function normalizeIceServers(raw: unknown): IceServerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: IceServerEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const urls = (item as IceServerEntry).urls;
    if (!urls) continue;
    out.push({
      urls,
      username: (item as IceServerEntry).username,
      credential: (item as IceServerEntry).credential,
    });
  }
  return out;
}

export function hasTurnServers(servers: IceServerEntry[]): boolean {
  return servers.some((s) => {
    const list = Array.isArray(s.urls) ? s.urls : [s.urls];
    return list.some((u) => {
      const x = String(u || "").toLowerCase();
      return x.startsWith("turn:") || x.startsWith("turns:");
    });
  });
}

/** mediasoup-client: ICE servers on WebRtcTransport options. */
export function augmentTransportOptions(
  transportOptions: Record<string, unknown>,
  iceServers: IceServerEntry[]
): Record<string, unknown> {
  const servers = normalizeIceServers(iceServers);
  if (!servers.length) return transportOptions;
  const forceRelay = hasTurnServers(servers);
  return {
    ...transportOptions,
    iceServers: servers,
    ...(forceRelay ? { iceTransportPolicy: "relay" as const } : {}),
  };
}
