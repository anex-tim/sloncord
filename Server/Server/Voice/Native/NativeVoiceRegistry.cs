using System.Net;

namespace Sloncord.Voice.Native;

internal sealed class NativeVoiceRegistry
{
    private readonly object _sync = new();
    private readonly Dictionary<string, Dictionary<Guid, NativeVoicePeer>> _rooms = new(StringComparer.OrdinalIgnoreCase);

    public void BindPeer(string roomId, Guid userId, IPEndPoint endpoint, ushort sessionId)
    {
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room))
            {
                room = new Dictionary<Guid, NativeVoicePeer>();
                _rooms[roomId] = room;
            }

            room[userId] = new NativeVoicePeer(userId, endpoint, sessionId, DateTime.UtcNow);
        }
    }

    public void RemovePeer(string roomId, Guid userId)
    {
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            room.Remove(userId);
            if (room.Count == 0) _rooms.Remove(roomId);
        }
    }

    public void RemoveByEndpoint(IPEndPoint endpoint)
    {
        lock (_sync)
        {
            foreach (var (roomId, room) in _rooms.ToList())
            {
                foreach (var (uid, peer) in room.ToList())
                {
                    if (peer.Endpoint.Equals(endpoint))
                        room.Remove(uid);
                }
                if (room.Count == 0) _rooms.Remove(roomId);
            }
        }
    }

    public List<(Guid UserId, IPEndPoint Endpoint, ushort SessionId)> GetPeersExcept(string roomId, Guid exceptUserId)
    {
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return new List<(Guid, IPEndPoint, ushort)>();
            var list = new List<(Guid, IPEndPoint, ushort)>();
            foreach (var (uid, peer) in room)
            {
                if (uid == exceptUserId) continue;
                list.Add((uid, peer.Endpoint, peer.SessionId));
            }
            return list;
        }
    }

    public bool TryGetPeer(string roomId, Guid userId, out NativeVoicePeer peer)
    {
        lock (_sync)
        {
            peer = default!;
            if (!_rooms.TryGetValue(roomId, out var room)) return false;
            if (!room.TryGetValue(userId, out var p)) return false;
            peer = p;
            return true;
        }
    }

    public void Touch(string roomId, Guid userId)
    {
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            if (!room.TryGetValue(userId, out var peer)) return;
            room[userId] = peer with { LastSeenUtc = DateTime.UtcNow };
        }
    }

    public bool TryFindByEndpoint(IPEndPoint remote, out Guid userId, out string roomId)
    {
        lock (_sync)
        {
            foreach (var (rid, room) in _rooms)
            {
                foreach (var (uid, peer) in room)
                {
                    if (peer.Endpoint.Equals(remote))
                    {
                        userId = uid;
                        roomId = rid;
                        return true;
                    }
                }
            }
        }

        userId = default;
        roomId = "";
        return false;
    }
}

internal readonly record struct NativeVoicePeer(Guid UserId, IPEndPoint Endpoint, ushort SessionId, DateTime LastSeenUtc);
