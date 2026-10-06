import http from "node:http";
import { WebSocketServer } from "ws";
import * as mediasoup from "mediasoup";
import { verifySfuToken } from "./token.js";
import { getOrCreateRoom, getRoom, createPeer, destroyPeer, broadcastRoom, broadcastRoster, listProducers } from "./rooms.js";

const PORT = Number(process.env.SLONCORD_SFU_PORT || 3333);
const WS_PATH = String(process.env.SLONCORD_SFU_WS_PATH || "/ws/sfu");
const SECRET = String(process.env.SLONCORD_SFU_SECRET || "");

const LISTEN_IP = String(process.env.SLONCORD_SFU_LISTEN_IP || "0.0.0.0");
const ANNOUNCED_IP = String(process.env.SLONCORD_SFU_ANNOUNCED_IP || "");
const RTC_MIN_PORT = Number(process.env.SLONCORD_SFU_RTC_MIN_PORT || 10000);
const RTC_MAX_PORT = Number(process.env.SLONCORD_SFU_RTC_MAX_PORT || 20000);

if (!SECRET || SECRET.trim().length < 16) {
  // eslint-disable-next-line no-console
  console.error("Missing/weak SLONCORD_SFU_SECRET (min 16 chars). Refusing to start.");
  process.exit(1);
}

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {}
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1
    }
  }
];

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function readAuthToken(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  // also support ?token= for simple reverse proxies
  try {
    const u = new URL(req.url, "http://localhost");
    const t = u.searchParams.get("token");
    if (t) return t.trim();
  } catch {
    // ignore
  }
  return "";
}

const worker = await mediasoup.createWorker({
  rtcMinPort: RTC_MIN_PORT,
  rtcMaxPort: RTC_MAX_PORT,
  logLevel: process.env.SLONCORD_SFU_LOG_LEVEL || "warn"
});

worker.on("died", () => {
  // eslint-disable-next-line no-console
  console.error("mediasoup worker died, exiting");
  process.exit(1);
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("sloncord-sfu ok");
});

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", async (ws, req) => {
  const token = readAuthToken(req);
  const v = verifySfuToken(token, SECRET.trim());
  if (!v.ok) {
    send(ws, { type: "error", code: "unauthorized", detail: v.error });
    try { ws.close(); } catch { /* ignore */ }
    return;
  }

  const roomId = v.roomId;
  const userId = v.userId;
  const room = await getOrCreateRoom({ roomId, worker, mediaCodecs });
  const peer = createPeer({ room, userId, ws });

  broadcastRoom(room, { type: "peerJoined", userId }, userId);
  broadcastRoster(room);

  send(ws, { type: "hello", roomId, userId });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data || ""));
    } catch {
      return;
    }

    try {
      const requestId = msg?.requestId != null ? String(msg.requestId) : null;
      const reply = (obj) => send(ws, requestId ? { ...obj, requestId } : obj);

      if (msg.type === "ping") {
        reply({ type: "pong" });
        return;
      }

      if (msg.type === "getRouterRtpCapabilities") {
        reply({ type: "routerRtpCapabilities", rtpCapabilities: room.router.rtpCapabilities });
        return;
      }

      if (msg.type === "getProducers") {
        const items = listProducers(room, peer.userId);
        reply({ type: "producers", roomId: room.roomId, items });
        return;
      }

      if (msg.type === "createWebRtcTransport") {
        const direction = msg.direction === "send" ? "send" : "recv";
        const transport = await room.router.createWebRtcTransport({
          listenIps: [
            {
              ip: LISTEN_IP,
              announcedIp: ANNOUNCED_IP || undefined
            }
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 600_000
        });

        peer.transports.set(transport.id, transport);

        transport.on("dtlsstatechange", (dtlsState) => {
          if (dtlsState === "closed") {
            try { transport.close(); } catch { /* ignore */ }
          }
        });

        transport.on("close", () => {
          peer.transports.delete(transport.id);
        });

        reply({
          type: "webRtcTransportCreated",
          direction,
          transportOptions: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
          }
        });
        return;
      }

      if (msg.type === "connectWebRtcTransport") {
        const transport = peer.transports.get(String(msg.transportId || ""));
        if (!transport) {
          reply({ type: "error", code: "no_transport" });
          return;
        }
        await transport.connect({ dtlsParameters: msg.dtlsParameters });
        reply({ type: "webRtcTransportConnected", transportId: transport.id });
        return;
      }

      if (msg.type === "restartIce") {
        const transport = peer.transports.get(String(msg.transportId || ""));
        if (!transport) {
          reply({ type: "error", code: "no_transport" });
          return;
        }
        const iceParameters = await transport.restartIce();
        reply({ type: "iceRestarted", transportId: transport.id, iceParameters });
        return;
      }

      if (msg.type === "produce") {
        const transport = peer.transports.get(String(msg.transportId || ""));
        if (!transport) {
          reply({ type: "error", code: "no_transport" });
          return;
        }
        const kind = msg.kind === "video" ? "video" : "audio";
        const appData = msg.appData && typeof msg.appData === "object" ? msg.appData : {};
        const producer = await transport.produce({ kind, rtpParameters: msg.rtpParameters, appData });
        peer.producers.set(producer.id, producer);
        room.producers.set(producer.id, { userId: peer.userId, producer, appData });

        producer.on("transportclose", () => {
          // Notify others that this producer is gone (important for screen-share UI).
          broadcastRoom(room, { type: "producerClosed", userId: peer.userId, producerId: producer.id, kind, appData }, peer.userId);
          peer.producers.delete(producer.id);
          room.producers.delete(producer.id);
        });

        producer.on("close", () => {
          broadcastRoom(room, { type: "producerClosed", userId: peer.userId, producerId: producer.id, kind, appData }, peer.userId);
          peer.producers.delete(producer.id);
          room.producers.delete(producer.id);
        });

        // Notify everyone else.
        broadcastRoom(room, { type: "newProducer", userId: peer.userId, producerId: producer.id, kind, appData }, peer.userId);
        reply({ type: "produced", producerId: producer.id });
        return;
      }

      if (msg.type === "closeProducer") {
        const producer = peer.producers.get(String(msg.producerId || ""));
        if (producer) {
          const producerId = String(msg.producerId || "");
          const entry = room.producers.get(producerId);
          const kind = entry?.producer?.kind || producer.kind;
          const appData = entry?.appData || producer.appData || {};
          try { producer.close(); } catch { /* ignore */ }
          peer.producers.delete(producerId);
          room.producers.delete(producerId);
          broadcastRoom(room, { type: "producerClosed", userId: peer.userId, producerId, kind, appData }, peer.userId);
        }
        return;
      }

      if (msg.type === "consume") {
        const transport = peer.transports.get(String(msg.transportId || ""));
        if (!transport) {
          reply({ type: "error", code: "no_transport" });
          return;
        }
        const producerId = String(msg.producerId || "");
        const entry = room.producers.get(producerId);
        if (!entry) {
          reply({ type: "error", code: "no_producer" });
          return;
        }
        const { producer, userId: remoteUserId, appData } = entry;
        if (!room.router.canConsume({ producerId: producer.id, rtpCapabilities: msg.rtpCapabilities })) {
          reply({ type: "error", code: "cannot_consume" });
          return;
        }
        const consumer = await transport.consume({
          producerId: producer.id,
          rtpCapabilities: msg.rtpCapabilities,
          paused: true,
          appData: { remoteUserId, ...appData }
        });
        peer.consumers.set(consumer.id, consumer);

        consumer.on("transportclose", () => {
          peer.consumers.delete(consumer.id);
        });
        consumer.on("producerclose", () => {
          peer.consumers.delete(consumer.id);
          send(ws, { type: "consumerClosed", consumerId: consumer.id, producerId: producer.id, appData: consumer.appData || {} });
        });

        reply({
          type: "consuming",
          consumerParameters: {
            id: consumer.id,
            producerId: producer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            appData: consumer.appData
          }
        });
        return;
      }

      if (msg.type === "resumeConsumer") {
        const consumer = peer.consumers.get(String(msg.consumerId || ""));
        if (!consumer) {
          reply({ type: "error", code: "no_consumer" });
          return;
        }
        await consumer.resume();
        reply({ type: "consumerResumed", consumerId: consumer.id });
        return;
      }

      if (msg.type === "setUserFlags") {
        peer.flags.muted = msg.muted != null ? !!msg.muted : peer.flags.muted;
        peer.flags.deafened = msg.deafened != null ? !!msg.deafened : peer.flags.deafened;
        broadcastRoster(room);
        return;
      }

      reply({ type: "error", code: "unknown_message" });
    } catch (e) {
      const requestId = msg?.requestId != null ? String(msg.requestId) : null;
      send(ws, requestId ? { type: "error", code: "server_error", detail: String(e?.message || e), requestId } : { type: "error", code: "server_error", detail: String(e?.message || e) });
    }
  });

  ws.on("close", () => {
    const r = getRoom(roomId);
    if (!r) return;
    const p = r.peers.get(String(userId));
    if (p) destroyPeer({ room: r, peer: p, reason: "disconnect" });
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`sloncord-sfu listening on :${PORT}${WS_PATH} (rtc ${RTC_MIN_PORT}-${RTC_MAX_PORT}, announcedIp=${ANNOUNCED_IP || "-"})`);
});

