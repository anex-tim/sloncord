import type { IceServerEntry } from "./turnConfig";
import { augmentTransportOptions } from "./turnConfig";

export type SfuRequestFn = (type: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type MediasoupTransports = {
  device: import("mediasoup-client").types.Device;
  sendTransport: import("mediasoup-client").types.Transport;
  recvTransport: import("mediasoup-client").types.Transport;
};

export async function createMediasoupTransports(
  ms: typeof import("mediasoup-client"),
  sfuRequest: SfuRequestFn,
  iceServers: IceServerEntry[],
  hooks: {
    onSendState: (state: string) => void;
    onRecvState: (state: string) => void;
  }
): Promise<MediasoupTransports> {
  const caps = await sfuRequest("getRouterRtpCapabilities");
  const device = new ms.Device();
  await device.load({ routerRtpCapabilities: caps.rtpCapabilities as import("mediasoup-client").types.RtpCapabilities });

  const sendT = await sfuRequest("createWebRtcTransport", { direction: "send" });
  const sendTransport = device.createSendTransport(
    augmentTransportOptions(sendT.transportOptions as Record<string, unknown>, iceServers) as import("mediasoup-client").types.TransportOptions
  );
  sendTransport.on("connect", ({ dtlsParameters }, cb, eb) => {
    sfuRequest("connectWebRtcTransport", { transportId: sendTransport.id, dtlsParameters })
      .then(() => cb())
      .catch((e) => eb(e));
  });
  sendTransport.on("produce", ({ kind, rtpParameters, appData }, cb, eb) => {
    sfuRequest("produce", { transportId: sendTransport.id, kind, rtpParameters, appData })
      .then((r) => cb({ id: String(r.producerId) }))
      .catch((e) => eb(e));
  });
  sendTransport.on("connectionstatechange", (state) => hooks.onSendState(state));

  const recvT = await sfuRequest("createWebRtcTransport", { direction: "recv" });
  const recvTransport = device.createRecvTransport(
    augmentTransportOptions(recvT.transportOptions as Record<string, unknown>, iceServers) as import("mediasoup-client").types.TransportOptions
  );
  recvTransport.on("connect", ({ dtlsParameters }, cb, eb) => {
    sfuRequest("connectWebRtcTransport", { transportId: recvTransport.id, dtlsParameters })
      .then(() => cb())
      .catch((e) => eb(e));
  });
  recvTransport.on("connectionstatechange", (state) => hooks.onRecvState(state));

  return { device, sendTransport, recvTransport };
}

export function createSfuRequester(send: (obj: Record<string, unknown>) => void) {
  const pending = new Map<string, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let reqSeq = 1;

  function sfuRequest(type: string, payload: Record<string, unknown> = {}) {
    const requestId = String(reqSeq++);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        send({ type, requestId, ...payload });
      } catch (e) {
        pending.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error(`SFU timeout (${type})`));
      }, 8000);
    });
  }

  function handleResponse(msg: Record<string, unknown>) {
    if (msg.type === "pong") return { kind: "pong" as const };
    const rid = msg.requestId != null ? String(msg.requestId) : "";
    if (rid && pending.has(rid)) {
      const p = pending.get(rid)!;
      pending.delete(rid);
      if (msg.type === "error") p.reject(new Error(String(msg.code || "SFU error")));
      else p.resolve(msg);
      return { kind: "handled" as const };
    }
    return { kind: "event" as const };
  }

  function rejectAll(reason: string) {
    pending.forEach((p) => {
      try { p.reject(new Error(reason)); } catch { /* ignore */ }
    });
    pending.clear();
  }

  return { sfuRequest, handleResponse, rejectAll, pending };
}
