let mediasoupClientPromise: Promise<typeof import("mediasoup-client")> | null = null;

export async function loadMediasoupClient() {
  if (mediasoupClientPromise) return mediasoupClientPromise;
  mediasoupClientPromise = (async () => {
    const w = window as Window & { mediasoupClient?: typeof import("mediasoup-client") };
    if (w.mediasoupClient) return w.mediasoupClient;
    try {
      const mod = await import("mediasoup-client");
      w.mediasoupClient = mod;
      return mod;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Не удалось загрузить mediasoup-client: ${msg}`);
    }
  })();
  return mediasoupClientPromise;
}
