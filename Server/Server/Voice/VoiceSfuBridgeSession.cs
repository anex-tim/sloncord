using System.Buffers;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace Sloncord.Voice;

internal sealed class VoiceSfuBridgeSession : IAsyncDisposable
{
    private WebSocket _clientSocket;
    private readonly object _upstreamLock = new();
    private ClientWebSocket _upstream = new();
    private CancellationTokenSource _readLifetime = new();
    private Task? _readTask;
    private volatile bool _helloSeen;

    public string RoomId { get; }
    public Guid UserId { get; }
    public bool IsConnected
    {
        get
        {
            lock (_upstreamLock)
            {
                return _upstream.State == WebSocketState.Open;
            }
        }
    }

    private VoiceSfuBridgeSession(WebSocket clientSocket, Guid userId, string roomId)
    {
        _clientSocket = clientSocket;
        UserId = userId;
        RoomId = roomId;
    }

    public static async Task<VoiceSfuBridgeSession> ConnectAsync(
        WebSocket clientSocket,
        Guid userId,
        string roomId,
        string sfuWsUrl,
        string sfuUrlBase,
        string secret,
        int ttlSeconds,
        Func<CancellationToken, Task>? onRefreshed,
        CancellationToken ct)
    {
        var session = new VoiceSfuBridgeSession(clientSocket, userId, roomId);
        _ = onRefreshed;
        try
        {
            await session.ConnectUpstreamAsync(sfuWsUrl, ct);
        }
        catch (Exception ex)
        {
            await session.DisposeAsync();
            throw new InvalidOperationException($"SFU upstream connect failed: {ex.Message}", ex);
        }

        // SFU JWT is validated only at upstream connect; no periodic upstream replacement.
        return session;
    }

    public bool HelloSeen => _helloSeen;

    public void SetClientSocket(WebSocket clientSocket) => _clientSocket = clientSocket;

    private async Task ConnectUpstreamAsync(string sfuWsUrl, CancellationToken ct)
    {
        ClientWebSocket upstream;
        CancellationTokenSource readLifetime;
        lock (_upstreamLock)
        {
            upstream = _upstream;
            readLifetime = _readLifetime;
        }

        await upstream.ConnectAsync(new Uri(sfuWsUrl), ct);
        _helloSeen = false;
        _readTask = ReadUpstreamLoopAsync(upstream, readLifetime.Token);
        await WaitForHelloAsync(TimeSpan.FromSeconds(8), ct);
    }

    private async Task ReplaceUpstreamAsync(string sfuWsUrl, CancellationToken ct)
    {
        Task? oldRead;
        ClientWebSocket? oldUpstream;
        CancellationTokenSource? oldLifetime;

        lock (_upstreamLock)
        {
            oldRead = _readTask;
            oldUpstream = _upstream;
            oldLifetime = _readLifetime;
            _upstream = new ClientWebSocket();
            _readLifetime = new CancellationTokenSource();
        }

        try { oldLifetime?.Cancel(); } catch { /* ignore */ }
        if (oldRead is not null)
        {
            try { await oldRead.WaitAsync(TimeSpan.FromSeconds(2)); } catch { /* ignore */ }
        }

        try
        {
            if (oldUpstream?.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await oldUpstream.CloseAsync(WebSocketCloseStatus.NormalClosure, "bridge refresh", CancellationToken.None);
        }
        catch { /* ignore */ }
        try { oldUpstream?.Dispose(); } catch { /* ignore */ }
        try { oldLifetime?.Dispose(); } catch { /* ignore */ }

        await ConnectUpstreamAsync(sfuWsUrl, ct);
    }

    private async Task WaitForHelloAsync(TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (!_helloSeen && DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsConnected)
                throw new InvalidOperationException("SFU upstream closed before hello");
            await Task.Delay(50, ct);
        }
        if (!_helloSeen)
            throw new TimeoutException("SFU hello timeout");
    }

    public async Task SendUpstreamJsonAsync(JsonElement body, CancellationToken ct)
    {
        ClientWebSocket upstream;
        lock (_upstreamLock)
        {
            upstream = _upstream;
            if (upstream.State != WebSocketState.Open)
                throw new InvalidOperationException("SFU upstream is not open");
        }

        var json = body.GetRawText();
        var bytes = Encoding.UTF8.GetBytes(json);
        await upstream.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
    }

    private async Task ReadUpstreamLoopAsync(ClientWebSocket upstream, CancellationToken ct)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
        var messageBytes = new List<byte>(4096);
        try
        {
            while (upstream.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await upstream.ReceiveAsync(buffer.AsMemory(0, buffer.Length), ct);
                if (result.MessageType == WebSocketMessageType.Close) break;
                if (result.MessageType != WebSocketMessageType.Text) continue;

                for (var i = 0; i < result.Count; i++) messageBytes.Add(buffer[i]);
                if (!result.EndOfMessage) continue;

                var text = Encoding.UTF8.GetString(messageBytes.ToArray());
                messageBytes.Clear();
                if (string.IsNullOrWhiteSpace(text)) continue;

                try
                {
                    using var doc = JsonDocument.Parse(text);
                    var root = doc.RootElement;
                    if (root.TryGetProperty("type", out var typeEl)
                        && string.Equals(typeEl.GetString(), "hello", StringComparison.OrdinalIgnoreCase))
                    {
                        _helloSeen = true;
                    }
                    await ForwardToClientAsync(text, ct);
                }
                catch
                {
                    // ignore malformed upstream payloads
                }
            }
        }
        catch (OperationCanceledException)
        {
            // expected on dispose / refresh
        }
        catch (WebSocketException)
        {
            // upstream dropped
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private async Task ForwardToClientAsync(string sfuJson, CancellationToken ct)
    {
        if (_clientSocket.State != WebSocketState.Open) return;
        var json = $"{{\"type\":\"sfu\",\"body\":{sfuJson}}}";
        var bytes = Encoding.UTF8.GetBytes(json);
        try
        {
            await _clientSocket.SendAsync(bytes, WebSocketMessageType.Text, true, ct);
        }
        catch
        {
            // client socket may be gone
        }
    }

    public async ValueTask DisposeAsync()
    {
        Task? readTask;
        ClientWebSocket? upstream;
        CancellationTokenSource? readLifetime;
        lock (_upstreamLock)
        {
            readTask = _readTask;
            upstream = _upstream;
            readLifetime = _readLifetime;
            _readTask = null;
        }

        try { readLifetime?.Cancel(); } catch { /* ignore */ }
        try
        {
            if (readTask is not null)
                await readTask.WaitAsync(TimeSpan.FromSeconds(2));
        }
        catch { /* ignore */ }

        try
        {
            if (upstream?.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await upstream.CloseAsync(WebSocketCloseStatus.NormalClosure, "bridge disposed", CancellationToken.None);
        }
        catch { /* ignore */ }

        try { upstream?.Dispose(); } catch { /* ignore */ }
        try { readLifetime?.Dispose(); } catch { /* ignore */ }
    }
}
