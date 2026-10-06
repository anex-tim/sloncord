import * as mediasoup from "mediasoup";

const rooms = new Map(); // roomId -> Room

function safeClose(x) {
  try {
    x?.close?.();
  } catch {
    // ignore
  }
}

export async function getOrCreateRoom({ roomId, worker, mediaCodecs }) {
  const key = String(roomId);
  const existing = rooms.get(key);
  if (existing && !existing.closed) return existing;

  const router = await worker.createRouter({ mediaCodecs });
  const room = {
    roomId: key,
    router,
    peers: new Map(), // userId -> Peer
    producers: new Map(), // producerId -> { userId, producer, appData }
    closed: false
  };
  rooms.set(key, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(String(roomId)) || null;
}

export function deleteRoomIfEmpty(room) {
  if (!room) return;
  if (room.peers.size > 0) return;
  room.closed = true;
  safeClose(room.router);
  rooms.delete(room.roomId);
}

export function createPeer({ room, userId, ws }) {
  const id = String(userId);
  const existing = room.peers.get(id);
  if (existing) {
    // Soft replace: refresh session without peerLeft roster flicker.
    destroyPeer({ room, peer: existing, reason: "replaced", silent: true });
  }

  const peer = {
    userId: id,
    ws,
    joinedAt: Date.now(),
    transports: new Map(), // transportId -> transport
    producers: new Map(), // producerId -> producer
    consumers: new Map(), // consumerId -> consumer
    flags: { muted: false, deafened: false },
    speaking: false
  };
  room.peers.set(id, peer);
  return peer;
}

export function destroyPeer({ room, peer, reason, silent = false }) {
  if (!peer || !room) return;
  const uid = String(peer.userId);

  for (const c of peer.consumers.values()) safeClose(c);
  peer.consumers.clear();

  for (const p of peer.producers.values()) {
    safeClose(p);
    room.producers.delete(String(p.id));
  }
  peer.producers.clear();

  for (const t of peer.transports.values()) safeClose(t);
  peer.transports.clear();

  room.peers.delete(uid);

  if (!silent) {
    broadcastRoom(room, { type: "peerLeft", userId: uid, reason: reason || "left" }, uid);
  }
  broadcastRoster(room);
  deleteRoomIfEmpty(room);
}

export function broadcastRoom(room, msg, exceptUserId = null) {
  const payload = JSON.stringify(msg);
  for (const peer of room.peers.values()) {
    if (exceptUserId && String(peer.userId) === String(exceptUserId)) continue;
    try {
      if (peer.ws?.readyState === 1) peer.ws.send(payload);
    } catch {
      // ignore
    }
  }
}

export function broadcastRoster(room) {
  const userIds = Array.from(room.peers.keys());
  const mutedUserIds = userIds.filter((id) => room.peers.get(id)?.flags?.muted);
  const deafenedUserIds = userIds.filter((id) => room.peers.get(id)?.flags?.deafened);
  broadcastRoom(room, { type: "roomRoster", roomId: room.roomId, userIds, mutedUserIds, deafenedUserIds });
}

export function listProducers(room, exceptUserId = null) {
  const out = [];
  for (const [producerId, entry] of room.producers.entries()) {
    if (exceptUserId && String(entry.userId) === String(exceptUserId)) continue;
    out.push({
      producerId: String(producerId),
      userId: String(entry.userId),
      kind: String(entry.producer?.kind || ""),
      appData: entry.appData || {}
    });
  }
  return out;
}

