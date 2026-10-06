namespace Sloncord;

internal static class SloncordClientIp
{
    public static string? Resolve(HttpContext? ctx)
    {
        if (ctx is null) return null;
        var forwarded = ctx.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(forwarded))
        {
            var first = forwarded.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(first)) return Normalize(first);
        }

        var realIp = ctx.Request.Headers["X-Real-IP"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(realIp)) return Normalize(realIp);

        return Normalize(ctx.Connection.RemoteIpAddress?.ToString());
    }

    public static string Normalize(string? ip)
    {
        if (string.IsNullOrWhiteSpace(ip)) return "";
        var t = ip.Trim();
        if (t.StartsWith("::ffff:", StringComparison.OrdinalIgnoreCase))
            t = t[7..];
        return t;
    }
}
