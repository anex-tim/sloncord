using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Sloncord.Realtime;

/// <summary>Fan-out target for unified /ws/realtime clients (variant C control plane).</summary>
internal sealed class RealtimeGatewayHub
{
    private readonly ConcurrentDictionary<WebSocket, RealtimeClient> _clients = new();

    public void Register(WebSocket socket, Guid userId)
    {
        _clients[socket] = new RealtimeClient(userId, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
    }

    public void Unregister(WebSocket socket)
    {
        _clients.TryRemove(socket, out _);
    }

    public void SetGroups(WebSocket socket, IEnumerable<string> groups)
    {
        if (!_clients.TryGetValue(socket, out var client)) return;
        client.Groups.Clear();
        foreach (var g in groups)
            client.Groups.Add(g);
    }

    public void AddGroup(WebSocket socket, string group)
    {
        if (!_clients.TryGetValue(socket, out var client)) return;
        client.Groups.Add(group);
    }

    public Task ToGroupAsync(string group, string eventName, object payload, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(new { op = "event", name = eventName, payload }, SloncordJson.Options);
        var bytes = Encoding.UTF8.GetBytes(json);
        var segment = new ArraySegment<byte>(bytes);

        var tasks = new List<Task>();
        foreach (var (socket, client) in _clients)
        {
            if (!client.Groups.Contains(group)) continue;
            if (socket.State != WebSocketState.Open) continue;
            tasks.Add(SendSafeAsync(socket, segment, ct));
        }

        return tasks.Count == 0 ? Task.CompletedTask : Task.WhenAll(tasks);
    }

    public Task ToUserAsync(Guid userId, string eventName, object payload, CancellationToken ct = default)
        => ToGroupAsync($"{Sloncord.Hubs.SloncordHub.GroupUserPrefix}{userId:N}", eventName, payload, ct);

    public Task ToChannelAsync(Guid channelId, string eventName, object payload, CancellationToken ct = default)
        => ToGroupAsync($"{Sloncord.Hubs.SloncordHub.GroupChannelPrefix}{channelId:N}", eventName, payload, ct);

    public Task ToPlatformModeratorsAsync(string eventName, object payload, CancellationToken ct = default)
        => ToGroupAsync(Sloncord.Hubs.SloncordHub.GroupPlatformModerators, eventName, payload, ct);

    public Task BroadcastAsync(string eventName, object payload, CancellationToken ct = default)
    {
        var json = JsonSerializer.Serialize(new { op = "event", name = eventName, payload }, SloncordJson.Options);
        var bytes = Encoding.UTF8.GetBytes(json);
        var segment = new ArraySegment<byte>(bytes);
        var tasks = new List<Task>();
        foreach (var (socket, _) in _clients)
        {
            if (socket.State != WebSocketState.Open) continue;
            tasks.Add(SendSafeAsync(socket, segment, ct));
        }

        return tasks.Count == 0 ? Task.CompletedTask : Task.WhenAll(tasks);
    }

    private static async Task SendSafeAsync(WebSocket socket, ArraySegment<byte> segment, CancellationToken ct)
    {
        try
        {
            await socket.SendAsync(segment, WebSocketMessageType.Text, endOfMessage: true, ct);
        }
        catch
        {
            // ignore
        }
    }

    private sealed class RealtimeClient(Guid userId, HashSet<string> groups)
    {
        public Guid UserId { get; } = userId;
        public HashSet<string> Groups { get; } = groups;
    }
}
