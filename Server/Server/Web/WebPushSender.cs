using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Sloncord.Data;
using WebPush;
using WebPushError = WebPush.WebPushException;

namespace Sloncord;

internal sealed class WebPushSender
{
    private readonly VapidKeyStore _vapid;
    private readonly WebPushClient _client = new();
    private readonly ILogger<WebPushSender>? _logger;

    public WebPushSender(VapidKeyStore vapid, ILogger<WebPushSender>? logger = null)
    {
        _vapid = vapid;
        _logger = logger;
    }

    public Task NotifyUserAsync(
        SloncordDbContext db, Guid userId, string title, string body, CancellationToken ct = default)
        => NotifyUserAsync(db, userId, title, body, data: null, ct);

    public async Task NotifyUserAsync(
        SloncordDbContext db, Guid userId, string title, string body, object? data, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(_vapid.PublicKey) || string.IsNullOrWhiteSpace(_vapid.PrivateKey)) return;

        var subs = await db.PushSubscriptions.AsNoTracking()
            .Where(s => s.UserId == userId)
            .ToListAsync(ct);

        if (subs.Count == 0) return;

        var payload = JsonSerializer.Serialize(new { title, body, data }, SloncordJson.Options);

        var vapidDetails = new VapidDetails(_vapid.Subject, _vapid.PublicKey, _vapid.PrivateKey);

        foreach (var s in subs)
        {
            try
            {
                var sub = new PushSubscription(s.Endpoint, s.P256dh, s.Auth);
                await _client.SendNotificationAsync(sub, payload, vapidDetails);
            }
            catch (WebPushError ex)
            {
                // Remove invalid subscriptions
                if (ex.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Gone)
                {
                    await db.PushSubscriptions.Where(x => x.Id == s.Id).ExecuteDeleteAsync(ct);
                }
                _logger?.LogDebug(ex, "Web push failed for {Endpoint}", s.Endpoint);
            }
            catch (Exception ex)
            {
                _logger?.LogDebug(ex, "Web push error for {Endpoint}", s.Endpoint);
            }
        }
    }
}

internal static class SloncordJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };
}
