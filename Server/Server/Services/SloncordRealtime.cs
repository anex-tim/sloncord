using Microsoft.Extensions.DependencyInjection;
using Sloncord.Realtime;

namespace Sloncord;

/// <summary>Pushes realtime events to desktop clients via /ws/realtime (variant C).</summary>
public sealed class SloncordRealtime
{
    private readonly Lazy<RealtimeGatewayHub> _gateway;

    public SloncordRealtime(IServiceProvider services)
    {
        _gateway = new Lazy<RealtimeGatewayHub>(() => services.GetRequiredService<RealtimeGatewayHub>());
    }

    public Task ToChannelAsync(Guid channelId, string eventName, object payload) =>
        _gateway.Value.ToChannelAsync(channelId, eventName, payload);

    public Task ToUserAsync(Guid userId, string eventName, object payload) =>
        _gateway.Value.ToUserAsync(userId, eventName, payload);

    public Task ToPlatformModeratorsAsync(string eventName, object payload) =>
        _gateway.Value.ToPlatformModeratorsAsync(eventName, payload);

    public Task BroadcastAsync(string eventName, object payload) =>
        _gateway.Value.BroadcastAsync(eventName, payload);
}
