using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Sloncord.Hubs;
using Sloncord.Voice;
using Sloncord.Voice.Native;

namespace Sloncord;

/// <summary>WebRTC signaling over WebSocket. One client may have one active room per connection.</summary>
internal sealed class VoiceSignalingServer
{
    private readonly object _sync = new();
    private readonly Dictionary<string, Dictionary<Guid, HashSet<WebSocket>>> _rooms = new();
    private readonly Dictionary<string, HashSet<Guid>> _roomScreenSharers = new();
    private readonly Dictionary<string, Dictionary<Guid, DateTime>> _roomScreenSharersTouchedAtUtc = new();
    private readonly Dictionary<string, Dictionary<Guid, (bool Muted, bool Deafened)>> _roomUserFlags = new();
    private readonly Dictionary<string, Dictionary<Guid, DateTime>> _roomSpeakingTouchedAtUtc = new();
    private static readonly TimeSpan SpeakingPresenceTtl = TimeSpan.FromSeconds(1.5);
    private readonly Dictionary<string, DateTime> _roomStartedAtUtc = new();
    private readonly Dictionary<WebSocket, (Guid UserId, string RoomId)> _socketMap = new();
    private readonly Dictionary<WebSocket, string> _socketMode = new();
    private readonly ConcurrentDictionary<WebSocket, SemaphoreSlim> _sendLocks = new();
    private int _screenFrameRelays;
    private readonly SloncordRealtime _realtime;
    private readonly VoiceGatewayService _gateway;
    private readonly VoiceSessionRegistry _sessions;

    public VoiceSignalingServer(
        SloncordRealtime realtime,
        VoiceGatewayService gateway,
        VoiceSessionRegistry sessions)
    {
        _realtime = realtime;
        _gateway = gateway;
        _sessions = sessions;
    }

    private static int CountActiveParticipants(Dictionary<Guid, HashSet<WebSocket>> room) =>
        room.Values.Count(s => s.Count > 0);

    private void SyncRoomTimerLocked(string roomId, Dictionary<Guid, HashSet<WebSocket>> room)
    {
        var hasAnyone = false;
        foreach (var (uid, set) in room)
        {
            if (set.Count > 0 || _sessions.IsInGrace(roomId, uid))
            {
                hasAnyone = true;
                break;
            }
        }
        if (!hasAnyone)
            _roomStartedAtUtc.Remove(roomId);
    }

    public (List<string> UserIds, List<string> ScreenShareUserIds, List<string> MutedUserIds, List<string> DeafenedUserIds, List<string> SpeakingUserIds, DateTime? StartedAtUtc) GetPresence(string roomId)
    {
        List<Guid> users = new();
        List<Guid> sharers = new();
        List<Guid> muted = new();
        List<Guid> deaf = new();
        List<Guid> speaking = new();
        DateTime? startedAt = null;
        var now = DateTime.UtcNow;
        lock (_sync)
        {
            if (_rooms.TryGetValue(roomId, out var room))
            {
                foreach (var (uid, set) in room)
                {
                    if (set.Count == 0 && !_sessions.IsInGrace(roomId, uid)) continue;
                    users.Add(uid);
                }
            }
            if (users.Count > 0)
            {
                if (!_roomStartedAtUtc.TryGetValue(roomId, out var t))
                {
                    t = DateTime.UtcNow;
                    _roomStartedAtUtc[roomId] = t;
                }
                startedAt = t;
            }
            if (_roomScreenSharers.TryGetValue(roomId, out var ss))
            {
                // Expire screen-share entries that haven't been refreshed recently.
                // This prevents stuck "в эфире" if a client missed sending screenShare=false.
                var ttl = TimeSpan.FromSeconds(12);
                if (_roomScreenSharersTouchedAtUtc.TryGetValue(roomId, out var touched))
                {
                    foreach (var uid in ss)
                    {
                        if (touched.TryGetValue(uid, out var at) && now - at <= ttl)
                            sharers.Add(uid);
                    }
                }
                else
                {
                    sharers.AddRange(ss);
                }
            }
            var active = new HashSet<Guid>(users);
            if (_roomUserFlags.TryGetValue(roomId, out var flags))
            {
                foreach (var (uid, f) in flags)
                {
                    if (!active.Contains(uid)) continue;
                    if (f.Muted) muted.Add(uid);
                    if (f.Deafened) deaf.Add(uid);
                }
            }
            sharers.RemoveAll(uid => !active.Contains(uid));
            if (_roomSpeakingTouchedAtUtc.TryGetValue(roomId, out var speakingTouched))
            {
                foreach (var (uid, at) in speakingTouched)
                {
                    if (!active.Contains(uid)) continue;
                    if (now - at <= SpeakingPresenceTtl) speaking.Add(uid);
                }
            }
        }
        return (
            users.Select(x => x.ToString("D")).ToList(),
            sharers.Select(x => x.ToString("D")).Distinct().ToList(),
            muted.Select(x => x.ToString("D")).Distinct().ToList(),
            deaf.Select(x => x.ToString("D")).Distinct().ToList(),
            speaking.Select(x => x.ToString("D")).Distinct().ToList(),
            startedAt
        );
    }

    public async Task HandleAsync(WebSocket socket, Guid userId, CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        var messageBytes = new List<byte>(4096);
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var idle = CancellationTokenSource.CreateLinkedTokenSource(ct);
                // Дольше двух пропущенных ping (клиент шлёт каждые 2 с). Убитый процесс
                // не шлёт ping, даже если TCP ещё держит прокси.
                idle.CancelAfter(TimeSpan.FromSeconds(5));
                System.Net.WebSockets.ValueWebSocketReceiveResult result;
                try
                {
                    result = await socket.ReceiveAsync(buffer.AsMemory(0, buffer.Length), idle.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    break;
                }
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType == WebSocketMessageType.Text)
                {
                    for (int i = 0; i < result.Count; i++) messageBytes.Add(buffer[i]);
                    if (!result.EndOfMessage) continue;
                }
                else
                {
                    messageBytes.Clear();
                    continue;
                }

                {
                    var text = Encoding.UTF8.GetString(messageBytes.ToArray());
                    messageBytes.Clear();
                    if (string.IsNullOrWhiteSpace(text)) continue;

                    VoiceClientMessage? msg;
                    try
                    {
                        msg = JsonSerializer.Deserialize<VoiceClientMessage>(text, SloncordJson.Options);
                    }
                    catch
                    {
                        await SendJsonAsync(socket, new { type = "error", payload = "bad json" }, ct);
                        continue;
                    }

                    if (msg is null || string.IsNullOrWhiteSpace(msg.Type)) continue;

                    if (string.Equals(msg.Type, "ping", StringComparison.OrdinalIgnoreCase))
                    {
                        await SendJsonAsync(socket, new { type = "pong" }, ct);
                    }
                    else if (msg.Type == "joinRoom")
                    {
                        if (string.IsNullOrWhiteSpace(msg.RoomId)) continue;
                        await JoinRoomAsync(userId, msg.RoomId, socket, msg.Mode, ct);
                    }
                    else if (msg.Type == "leaveRoom")
                    {
                        LeaveSocket(socket, userId, notify: true, skipGrace: true, ct);
                    }
                    else if (msg.Type == "signal")
                    {
                        if (msg.TargetUserId is null || string.IsNullOrWhiteSpace(msg.SignalType) || msg.Payload is null)
                            continue;
                        // In SFU mode, backend WS is used only for presence/flags; do not relay P2P signaling.
                        lock (_sync)
                        {
                            if (_socketMode.TryGetValue(socket, out var m) && string.Equals(m, "sfu", StringComparison.OrdinalIgnoreCase))
                                continue;
                        }
                        await RelaySignalAsync(userId, msg.TargetUserId.Value, msg.SignalType, msg.Payload, socket, ct);
                    }
                    else if (msg.Type == "screenShare")
                    {
                        if (string.IsNullOrWhiteSpace(msg.RoomId)) continue;
                        if (msg.Enabled is null) continue;
                        UpdateScreenShare(userId, msg.RoomId, msg.Enabled.Value, ct);
                    }
                    else if (msg.Type == "screenFrame")
                    {
                        if (string.IsNullOrWhiteSpace(msg.RoomId) || string.IsNullOrWhiteSpace(msg.Payload)) continue;
                        if (msg.Payload.Length > 160_000) continue;
                        // Не блокировать приём ping/флагов большой JPEG-рассылкой.
                        if (System.Threading.Interlocked.CompareExchange(ref _screenFrameRelays, 1, 0) != 0) continue;
                        _ = RelayScreenFrameAsync(userId, msg.RoomId, msg.Payload, socket, CancellationToken.None)
                            .ContinueWith(_ => System.Threading.Interlocked.Exchange(ref _screenFrameRelays, 0));
                    }
                    else if (msg.Type == "setUserFlags")
                    {
                        if (string.IsNullOrWhiteSpace(msg.RoomId)) continue;
                        if (msg.Muted is null && msg.Deafened is null) continue;
                        UpdateUserFlags(userId, msg.RoomId, msg.Muted, msg.Deafened, ct);
                    }
                    else if (msg.Type == "setSpeaking")
                    {
                        if (string.IsNullOrWhiteSpace(msg.RoomId)) continue;
                        if (msg.Speaking is null) continue;
                        UpdateSpeaking(userId, msg.RoomId, msg.Speaking.Value, ct);
                    }
                    else if (msg.Type == "sfu")
                    {
                        if (msg.Body is not { } sfuBody
                            || sfuBody.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
                            continue;
                        try
                        {
                            await _gateway.ForwardClientToSfuAsync(socket, sfuBody, ct);
                        }
                        catch
                        {
                            await SendJsonAsync(socket, new { type = "sfuError", error = "sfu_forward_failed" }, ct);
                        }
                    }
                    else if (msg.Type == "reconnectSfu")
                    {
                        var (ok, err) = await _gateway.ReconnectBridgeAsync(socket, userId, ct);
                        if (!ok)
                            await SendJsonAsync(socket, new { type = "sfuError", error = err ?? "sfu_reconnect_failed" }, ct);
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // ignore
        }
        catch (WebSocketException)
        {
            // ignore
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }

        string? voiceRoomId = null;
        lock (_sync)
        {
            if (_socketMap.TryGetValue(socket, out var cur))
                voiceRoomId = cur.RoomId;
        }

        LeaveSocket(socket, userId, notify: true, skipGrace: false, CancellationToken.None);

        if (!string.IsNullOrWhiteSpace(voiceRoomId) && _sessions.IsInGrace(voiceRoomId, userId))
            _gateway.DetachBridgeForGrace(socket, userId, voiceRoomId);
        else
            await _gateway.StopBridgeAsync(socket);
        try
        {
            if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
            }
        }
        catch
        {
            // ignore
        }
    }

    private async Task JoinRoomAsync(Guid userId, string roomId, WebSocket socket, string? mode, CancellationToken ct)
    {
        List<Guid> existingPeerIds = new();
        List<(WebSocket Socket, string RoomId)> toClose = new();
        HashSet<string> affectedRooms = new(StringComparer.OrdinalIgnoreCase);
        var modeNorm = mode?.Trim() ?? "";
        var isSfu = string.Equals(modeNorm, "sfu", StringComparison.OrdinalIgnoreCase);
        var isNative = string.Equals(modeNorm, "native", StringComparison.OrdinalIgnoreCase);

        lock (_sync)
        {
            if (_socketMap.TryGetValue(socket, out var prev))
            {
                RemoveSocketFromRoom(prev.RoomId, userId, socket, notifyPeerLeft: false, prevUserId: userId, roomRoster: true, skipGrace: true, ct);
                affectedRooms.Add(prev.RoomId);
            }

            // Enforce single active voice connection per user across the whole app:
            // if the same user connects from another tab/device, kick older sockets
            // so the user doesn't appear in multiple voice rosters simultaneously.
            foreach (var (rid, roomMap) in _rooms)
            {
                if (!roomMap.TryGetValue(userId, out var socketSet) || socketSet.Count == 0) continue;
                foreach (var s in socketSet)
                {
                    if (ReferenceEquals(s, socket)) continue;
                    toClose.Add((s, rid));
                }
            }

            foreach (var (s, rid) in toClose)
            {
                // Same-room native reconnect: keep grace so a brief overlap of sockets does not
                // drop the user from roster before the new socket is registered.
                var sameRoom = string.Equals(rid, roomId, StringComparison.OrdinalIgnoreCase);
                var skipGraceForOld = !(isNative && sameRoom);
                var notifyLeft = !sameRoom;
                RemoveSocketFromRoom(
                    rid, userId, s,
                    notifyPeerLeft: notifyLeft,
                    prevUserId: userId,
                    roomRoster: true,
                    skipGrace: skipGraceForOld,
                    ct,
                    nativeGraceSeconds: (isNative && sameRoom) ? 2 : 0);
                affectedRooms.Add(rid);
            }

            if (!_rooms.TryGetValue(roomId, out var room))
            {
                room = new Dictionary<Guid, HashSet<WebSocket>>();
                _rooms[roomId] = room;
            }
            // Start timer when the first active participant appears (grace ghosts with empty sockets don't count).
            var activeBefore = CountActiveParticipants(room);

            if (!_roomUserFlags.TryGetValue(roomId, out var flags))
            {
                flags = new Dictionary<Guid, (bool Muted, bool Deafened)>();
                _roomUserFlags[roomId] = flags;
            }
            if (!flags.ContainsKey(userId))
            {
                flags[userId] = (Muted: false, Deafened: false);
            }

            foreach (var (otherUserId, sockets) in room)
            {
                if (otherUserId == userId) continue;
                if (sockets.Count == 0) continue;
                existingPeerIds.Add(otherUserId);
            }

            if (!room.TryGetValue(userId, out var set))
            {
                set = new HashSet<WebSocket>();
                room[userId] = set;
            }
            set.Add(socket);
            _socketMap[socket] = (userId, roomId);
            _socketMode[socket] = isNative ? "native" : isSfu ? "sfu" : "mesh";
            // Keep the session timer across reconnects; start a new one only after the room was fully empty.
            if (activeBefore == 0 && !_roomStartedAtUtc.ContainsKey(roomId))
                _roomStartedAtUtc[roomId] = DateTime.UtcNow;
        }

        // Close old sockets outside the lock.
        foreach (var (s, _) in toClose)
        {
            try
            {
                if (s.State is WebSocketState.Open or WebSocketState.CloseReceived)
                    await s.CloseAsync(WebSocketCloseStatus.NormalClosure, "replaced", CancellationToken.None);
            }
            catch
            {
                // ignore
            }
        }

        // First message to the joiner: UI can mark "in channel" before rosters/peer handshakes finish.
        await SendJsonAsync(socket, new { type = "joinedRoom", roomId }, ct);

        if (!isSfu && !isNative)
        {
            _ = BroadcastToRoomAsync(roomId, new
            {
                type = "peerJoined",
                fromUserId = userId
            }, exceptSocket: socket, ct);

            foreach (var peerId in existingPeerIds)
            {
                await SendJsonAsync(socket, new
                {
                    type = "peerJoined",
                    fromUserId = peerId
                }, ct);
            }
        }

        await BroadcastRosterAsync(roomId, ct);
        _ = BroadcastVoicePresenceAsync(roomId, ct);

        if (isNative)
        {
            _sessions.CancelGrace(roomId, userId);
            await SendJsonAsync(socket, new { type = "nativeReady", roomId }, ct);
        }

        if (isSfu && _gateway.Enabled)
        {
            _sessions.CancelGrace(roomId, userId);
            var (bridgeOk, bridgeErr) = await _gateway.EnsureBridgeAsync(socket, userId, roomId, ct);
            if (!bridgeOk)
                await SendJsonAsync(socket, new { type = "sfuError", error = bridgeErr ?? "sfu_bridge_failed" }, ct);
        }
    }

    private void LeaveSocket(WebSocket socket, Guid userId, bool notify, bool skipGrace, CancellationToken ct)
    {
        string? roomId;
        lock (_sync)
        {
            if (!_socketMap.TryGetValue(socket, out var cur)) return;
            roomId = cur.RoomId;
        }

        if (roomId is null) return;
        RemoveSocketFromRoom(roomId, userId, socket, notifyPeerLeft: notify, prevUserId: userId, roomRoster: true, skipGrace: skipGrace, ct);
        lock (_sync) { _socketMode.Remove(socket); }
    }

    private void RemoveSocketFromRoom(
        string roomId, Guid userId, WebSocket socket, bool notifyPeerLeft, Guid prevUserId, bool roomRoster, bool skipGrace, CancellationToken ct, int? nativeGraceSeconds = null)
    {
        bool emptyUser = false;
        bool emptyRoom = false;
        bool isSfuSocket = false;
        bool isNativeSocket = false;
        lock (_sync)
        {
            if (_socketMode.TryGetValue(socket, out var mode))
            {
                isSfuSocket = string.Equals(mode, "sfu", StringComparison.OrdinalIgnoreCase);
                isNativeSocket = string.Equals(mode, "native", StringComparison.OrdinalIgnoreCase);
            }
        }

        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            if (!room.TryGetValue(userId, out var set)) return;
            set.Remove(socket);
            if (set.Count == 0)
            {
                // Обрыв native-сокета (убийство процесса) убирает человека сразу.
                // Короткая пауза только у повторного входа в ту же комнату, чтобы не мигать ростером.
                var graceSeconds = isNativeSocket ? (nativeGraceSeconds ?? 0) : _sessions.GraceSeconds;
                var useGrace = !skipGrace && graceSeconds > 0
                    && ((isSfuSocket && _gateway.Enabled) || isNativeSocket);
                if (useGrace
                    && _sessions.TryScheduleGrace(roomId, userId, () => _ = FinalizeGraceLeaveAsync(roomId, userId), graceSeconds))
                {
                    ClearUserScreenShareLocked(roomId, userId);
                }
                else
                {
                    room.Remove(userId);
                    emptyUser = true;
                }
            }
            if (room.Count == 0)
            {
                _rooms.Remove(roomId);
                emptyRoom = true;
            }
            _socketMap.Remove(socket);
            if (emptyUser && _roomUserFlags.TryGetValue(roomId, out var flags))
            {
                flags.Remove(userId);
                if (flags.Count == 0) _roomUserFlags.Remove(roomId);
            }
            if (emptyRoom)
            {
                _roomScreenSharers.Remove(roomId);
                _roomScreenSharersTouchedAtUtc.Remove(roomId);
                _roomSpeakingTouchedAtUtc.Remove(roomId);
                _roomStartedAtUtc.Remove(roomId);
            }
            else
            {
                SyncRoomTimerLocked(roomId, room);
                if (emptyUser)
                {
                    ClearUserScreenShareLocked(roomId, userId);
                    if (_roomSpeakingTouchedAtUtc.TryGetValue(roomId, out var speakingTouched))
                    {
                        speakingTouched.Remove(userId);
                        if (speakingTouched.Count == 0) _roomSpeakingTouchedAtUtc.Remove(roomId);
                    }
                }
            }
        }

        if (notifyPeerLeft && emptyUser)
        {
            _ = BroadcastToRoomAsync(roomId, new
            {
                type = "peerLeft",
                fromUserId = prevUserId
            }, exceptSocket: null, ct);
        }

        if (roomRoster) _ = BroadcastRosterAsync(roomId, ct);
        _ = BroadcastVoicePresenceAsync(roomId, ct);
    }

    private void ClearUserScreenShareLocked(string roomId, Guid userId)
    {
        if (_roomScreenSharers.TryGetValue(roomId, out var sharers))
        {
            sharers.Remove(userId);
            if (sharers.Count == 0) _roomScreenSharers.Remove(roomId);
        }
        if (_roomScreenSharersTouchedAtUtc.TryGetValue(roomId, out var touched))
        {
            touched.Remove(userId);
            if (touched.Count == 0) _roomScreenSharersTouchedAtUtc.Remove(roomId);
        }
    }

    private async Task FinalizeGraceLeaveAsync(string roomId, Guid userId)
    {
        bool emptyUser = false;
        bool emptyRoom = false;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            if (!room.TryGetValue(userId, out var set)) return;
            if (set.Count > 0) return;

            room.Remove(userId);
            emptyUser = true;
            if (room.Count == 0)
            {
                _rooms.Remove(roomId);
                emptyRoom = true;
            }
            if (emptyUser && _roomUserFlags.TryGetValue(roomId, out var flags))
            {
                flags.Remove(userId);
                if (flags.Count == 0) _roomUserFlags.Remove(roomId);
            }
            if (emptyRoom)
            {
                _roomScreenSharers.Remove(roomId);
                _roomScreenSharersTouchedAtUtc.Remove(roomId);
                _roomSpeakingTouchedAtUtc.Remove(roomId);
                _roomStartedAtUtc.Remove(roomId);
            }
            else
            {
                SyncRoomTimerLocked(roomId, room);
                if (emptyUser)
                {
                    ClearUserScreenShareLocked(roomId, userId);
                    if (_roomSpeakingTouchedAtUtc.TryGetValue(roomId, out var speakingTouched))
                    {
                        speakingTouched.Remove(userId);
                        if (speakingTouched.Count == 0) _roomSpeakingTouchedAtUtc.Remove(roomId);
                    }
                }
            }
        }

        if (!emptyUser) return;

        await _gateway.DisposeDetachedBridgeAsync(roomId, userId);

        await BroadcastToRoomAsync(roomId, new
        {
            type = "peerLeft",
            fromUserId = userId
        }, exceptSocket: null, CancellationToken.None);

        await BroadcastRosterAsync(roomId, CancellationToken.None);
        _ = BroadcastVoicePresenceAsync(roomId, CancellationToken.None);
    }

    private void UpdateScreenShare(Guid userId, string roomId, bool enabled, CancellationToken ct)
    {
        lock (_sync)
        {
            if (enabled)
            {
                if (!_roomScreenSharers.TryGetValue(roomId, out var set))
                {
                    set = new HashSet<Guid>();
                    _roomScreenSharers[roomId] = set;
                }
                set.Add(userId);

                if (!_roomScreenSharersTouchedAtUtc.TryGetValue(roomId, out var touched))
                {
                    touched = new Dictionary<Guid, DateTime>();
                    _roomScreenSharersTouchedAtUtc[roomId] = touched;
                }
                touched[userId] = DateTime.UtcNow;
            }
            else
            {
                if (_roomScreenSharers.TryGetValue(roomId, out var set))
                {
                    set.Remove(userId);
                    if (set.Count == 0) _roomScreenSharers.Remove(roomId);
                }
                if (_roomScreenSharersTouchedAtUtc.TryGetValue(roomId, out var touched))
                {
                    touched.Remove(userId);
                    if (touched.Count == 0) _roomScreenSharersTouchedAtUtc.Remove(roomId);
                }
            }
        }
        _ = BroadcastVoicePresenceAsync(roomId, ct);
    }

    private async Task BroadcastVoicePresenceAsync(string roomId, CancellationToken ct)
    {
        if (!TryParseChannelRoom(roomId, out var channelId)) return;
        var p = GetPresence(roomId);
        try
        {
            await _realtime.ToChannelAsync(channelId, SloncordHubEvents.VoicePresenceUpdated, new
            {
                channelId = channelId.ToString("D"),
                userIds = p.UserIds,
                screenShareUserIds = p.ScreenShareUserIds,
                mutedUserIds = p.MutedUserIds,
                deafenedUserIds = p.DeafenedUserIds,
                speakingUserIds = p.SpeakingUserIds,
                startedAtUtc = p.StartedAtUtc?.ToString("O")
            });
        }
        catch
        {
            // ignore
        }
    }

    public static bool TryParseChannelRoom(string roomId, out Guid channelId)
    {
        channelId = Guid.Empty;
        if (string.IsNullOrWhiteSpace(roomId)) return false;
        if (!roomId.StartsWith("channel:", StringComparison.OrdinalIgnoreCase)) return false;
        var s = roomId["channel:".Length..].Trim();
        return Guid.TryParse(s, out channelId);
    }

    private async Task BroadcastRosterAsync(string roomId, CancellationToken ct)
    {
        List<Guid> userIds = new();
        List<WebSocket> sockets = new();
        List<Guid> muted = new();
        List<Guid> deaf = new();
        List<Guid> speaking = new();
        List<Guid> sharers = new();
        var now = DateTime.UtcNow;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            foreach (var (uid, set) in room)
            {
                if (set.Count == 0 && !_sessions.IsInGrace(roomId, uid)) continue;
                userIds.Add(uid);
                foreach (var s in set) sockets.Add(s);
            }
            var active = new HashSet<Guid>(userIds);
            if (_roomScreenSharers.TryGetValue(roomId, out var ss))
            {
                foreach (var uid in ss)
                {
                    if (active.Contains(uid)) sharers.Add(uid);
                }
            }
            if (_roomUserFlags.TryGetValue(roomId, out var flags))
            {
                foreach (var (uid, f) in flags)
                {
                    if (!active.Contains(uid)) continue;
                    if (f.Muted) muted.Add(uid);
                    if (f.Deafened) deaf.Add(uid);
                }
            }
            if (_roomSpeakingTouchedAtUtc.TryGetValue(roomId, out var speakingTouched))
            {
                foreach (var (uid, at) in speakingTouched)
                {
                    if (!active.Contains(uid)) continue;
                    if (now - at <= SpeakingPresenceTtl) speaking.Add(uid);
                }
            }
        }

        if (sockets.Count == 0) return;
        var sessionByUser = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var uid in userIds)
            sessionByUser[uid.ToString("D")] = NativeVoicePacket.DeriveSessionId(uid, roomId);
        var payload = new
        {
            type = "roomRoster",
            roomId,
            userIds = userIds.Select(x => x.ToString("D")).ToList(),
            mutedUserIds = muted.Select(x => x.ToString("D")).Distinct().ToList(),
            deafenedUserIds = deaf.Select(x => x.ToString("D")).Distinct().ToList(),
            speakingUserIds = speaking.Select(x => x.ToString("D")).Distinct().ToList(),
            screenShareUserIds = sharers.Select(x => x.ToString("D")).Distinct().ToList(),
            nativeSessionByUserId = sessionByUser
        };
        await Task.WhenAll(sockets.Select(s => SendJsonAsync(s, payload, ct)));
    }

    private void UpdateSpeaking(Guid userId, string roomId, bool speaking, CancellationToken ct)
    {
        var shouldBroadcast = true;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room) || !room.ContainsKey(userId))
                return;
            if (!_roomSpeakingTouchedAtUtc.TryGetValue(roomId, out var touched))
            {
                touched = new Dictionary<Guid, DateTime>();
                _roomSpeakingTouchedAtUtc[roomId] = touched;
            }
            if (speaking)
            {
                var now = DateTime.UtcNow;
                if (touched.TryGetValue(userId, out var prev)
                    && now - prev < TimeSpan.FromMilliseconds(900))
                {
                    touched[userId] = now;
                    shouldBroadcast = false;
                }
                else
                {
                    touched[userId] = now;
                }
            }
            else
            {
                touched.Remove(userId);
            }
            if (touched.Count == 0) _roomSpeakingTouchedAtUtc.Remove(roomId);
        }
        if (!shouldBroadcast) return;
        _ = BroadcastRosterAsync(roomId, ct);
        _ = BroadcastVoicePresenceAsync(roomId, ct);
    }

    private void UpdateUserFlags(Guid userId, string roomId, bool? muted, bool? deafened, CancellationToken ct)
    {
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room) || !room.ContainsKey(userId))
                return;
            if (!_roomUserFlags.TryGetValue(roomId, out var flags))
            {
                flags = new Dictionary<Guid, (bool Muted, bool Deafened)>();
                _roomUserFlags[roomId] = flags;
            }
            flags.TryGetValue(userId, out var cur);
            var next = (
                Muted: muted ?? cur.Muted,
                Deafened: deafened ?? cur.Deafened
            );
            flags[userId] = next;
        }
        _ = BroadcastRosterAsync(roomId, ct);
        _ = BroadcastVoicePresenceAsync(roomId, ct);
    }

    private async Task RelaySignalAsync(
        Guid fromUserId, Guid targetUserId, string signalType, string payload, WebSocket fromSocket, CancellationToken ct)
    {
        string roomId;
        // Sender may be a mesh connection only; SFU connections are ignored earlier.
        lock (_sync)
        {
            if (!_socketMap.TryGetValue(fromSocket, out var cur) || cur.UserId != fromUserId) return;
            roomId = cur.RoomId;
        }

        List<WebSocket> targets = new();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            if (!room.TryGetValue(fromUserId, out var fromSet) || !fromSet.Contains(fromSocket)) return;
            if (!room.TryGetValue(targetUserId, out var toSet) || toSet.Count == 0) return;
            foreach (var s in toSet)
            {
                if (_socketMode.TryGetValue(s, out var m) && string.Equals(m, "sfu", StringComparison.OrdinalIgnoreCase))
                    continue;
                targets.Add(s);
            }
        }

        var forward = new
        {
            type = "signal",
            fromUserId,
            targetUserId,
            signalType,
            payload
        };

        foreach (var s in targets)
        {
            await SendJsonAsync(s, forward, ct);
        }
    }

    private Task BroadcastToRoomAsync(string roomId, object payload, WebSocket? exceptSocket, CancellationToken ct)
    {
        List<WebSocket> sockets = new();
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return Task.CompletedTask;
            foreach (var set in room.Values)
            {
                foreach (var s in set)
                {
                    if (exceptSocket is not null && ReferenceEquals(s, exceptSocket)) continue;
                    sockets.Add(s);
                }
            }
        }

        return Task.WhenAll(sockets.Select(s => SendJsonAsync(s, payload, ct)));
    }

    /// <summary>Closes all voice sockets for a user (optionally only in given rooms).</summary>
    public int ForceDisconnectUser(Guid userId, IReadOnlyList<string>? roomIds = null)
    {
        var targets = new List<(WebSocket Socket, string RoomId)>();
        var affectedRooms = new List<string>();

        lock (_sync)
        {
            foreach (var (roomId, room) in _rooms)
            {
                if (roomIds is not null && !roomIds.Contains(roomId, StringComparer.OrdinalIgnoreCase))
                    continue;
                if (!room.TryGetValue(userId, out var set)) continue;
                affectedRooms.Add(roomId);
                foreach (var ws in set.ToList())
                    targets.Add((ws, roomId));
            }
        }

        foreach (var roomId in affectedRooms)
            _sessions.CancelGrace(roomId, userId);

        var closed = 0;
        foreach (var (ws, roomId) in targets)
        {
            // Immediate roster update — do not keep user visible during reconnect grace.
            RemoveSocketFromRoom(
                roomId, userId, ws,
                notifyPeerLeft: true,
                prevUserId: userId,
                roomRoster: true,
                skipGrace: true,
                CancellationToken.None);

            _ = SendJsonAsync(ws, new { type = "forceLeave", roomId }, CancellationToken.None);
            try
            {
                _ = _gateway.StopBridgeAsync(ws);
                if (ws.State == WebSocketState.Open)
                {
                    ws.CloseAsync(WebSocketCloseStatus.PolicyViolation, "moderator", CancellationToken.None)
                        .GetAwaiter().GetResult();
                }
                closed++;
            }
            catch
            {
                // ignore
            }
        }

        // User may still be in roster with an empty socket set while grace was pending.
        foreach (var roomId in affectedRooms)
            _ = FinalizeGraceLeaveAsync(roomId, userId);

        return closed;
    }

    /// <summary>Room ids where the user still has an active or grace voice session.</summary>
    public IReadOnlyList<string> GetActiveRoomIdsForUser(Guid userId)
    {
        var list = new List<string>();
        lock (_sync)
        {
            foreach (var (roomId, room) in _rooms)
            {
                if (!room.TryGetValue(userId, out var set)) continue;
                if (set.Count > 0 || _sessions.IsInGrace(roomId, userId))
                    list.Add(roomId);
            }
        }
        return list;
    }

    /// <summary>Remove user from current voice rooms and tell clients to join another channel (socket stays open).</summary>
    public void NotifyVoiceMove(Guid userId, string targetRoomId, string channelId, string serverId)
    {
        var sockets = new HashSet<WebSocket>();
        var roomsToClear = new List<string>();
        lock (_sync)
        {
            foreach (var (ws, info) in _socketMap)
            {
                if (info.UserId == userId)
                    sockets.Add(ws);
            }
            foreach (var (roomId, room) in _rooms)
            {
                if (room.TryGetValue(userId, out var set) && set.Count > 0)
                    roomsToClear.Add(roomId);
            }
        }

        foreach (var roomId in roomsToClear.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            _sessions.CancelGrace(roomId, userId);
            List<WebSocket> inRoom;
            lock (_sync)
            {
                if (!_rooms.TryGetValue(roomId, out var room) || !room.TryGetValue(userId, out var set) || set.Count == 0)
                    continue;
                inRoom = set.ToList();
            }
            foreach (var ws in inRoom)
            {
                RemoveSocketFromRoom(
                    roomId, userId, ws,
                    notifyPeerLeft: true,
                    prevUserId: userId,
                    roomRoster: true,
                    skipGrace: true,
                    CancellationToken.None);
            }
            _ = FinalizeGraceLeaveAsync(roomId, userId);
        }

        var payload = new { type = "voiceMove", roomId = targetRoomId, channelId, serverId };
        foreach (var ws in sockets)
            _ = SendJsonAsync(ws, payload, CancellationToken.None);
    }

    private async Task RelayScreenFrameAsync(Guid userId, string roomId, string jpeg, WebSocket from, CancellationToken ct)
    {
        List<WebSocket> targets;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(roomId, out var room)) return;
            targets = new List<WebSocket>();
            foreach (var set in room.Values)
            {
                foreach (var peer in set)
                {
                    if (ReferenceEquals(peer, from)) continue;
                    if (peer.State == WebSocketState.Open) targets.Add(peer);
                }
            }
        }
        if (targets.Count == 0) return;
        var msg = new { type = "screenFrame", userId = userId.ToString("D"), jpeg };
        foreach (var peer in targets)
            await SendJsonAsync(peer, msg, ct);
    }

    private async Task SendJsonAsync(WebSocket socket, object payload, CancellationToken ct)
    {
        if (socket.State != WebSocketState.Open) return;
        var gate = _sendLocks.GetOrAdd(socket, _ => new SemaphoreSlim(1, 1));
        try
        {
            await gate.WaitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        try
        {
            if (socket.State != WebSocketState.Open) return;
            var json = JsonSerializer.Serialize(payload, SloncordJson.Options);
            var bytes = Encoding.UTF8.GetBytes(json);
            await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken: ct);
        }
        catch
        {
            // ignore
        }
        finally
        {
            gate.Release();
        }
    }

    private sealed class VoiceClientMessage
    {
        public string? Type { get; set; }
        public string? RoomId { get; set; }
        public string? Mode { get; set; }
        public Guid? TargetUserId { get; set; }
        public string? SignalType { get; set; }
        public string? Payload { get; set; }
        public bool? Enabled { get; set; }
        public bool? Muted { get; set; }
        public bool? Deafened { get; set; }
        public bool? Speaking { get; set; }
        public JsonElement? Body { get; set; }
    }
}
