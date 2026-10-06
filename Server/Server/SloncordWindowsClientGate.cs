namespace Sloncord;

/// <summary>
/// When SLONCORD_WINDOWS_CLIENTS_ONLY=1, blocks browser/PWA use: only Sloncord Desktop / Moderation exe.
/// </summary>
internal static class SloncordWindowsClientGate
{
    private static readonly HashSet<string> PrefixAllowAnonymous = new(StringComparer.OrdinalIgnoreCase)
    {
        "/health",
        "/downloads",
        "/auth",
    };

    private static readonly HashSet<string> PrefixAllowAlways = new(StringComparer.OrdinalIgnoreCase)
    {
        "/ws",
        "/voice",
        // <img>/<video> and media fetches cannot send X-Sloncord-Client; auth is enforced in file handlers.
        "/files",
    };

    public static bool IsEnabled(IConfiguration cfg)
    {
        var raw =
            cfg["SLONCORD_WINDOWS_CLIENTS_ONLY"]
            ?? Environment.GetEnvironmentVariable("SLONCORD_WINDOWS_CLIENTS_ONLY")
            ?? "1";
        return !string.Equals(raw.Trim(), "0", StringComparison.OrdinalIgnoreCase)
               && !string.Equals(raw.Trim(), "false", StringComparison.OrdinalIgnoreCase);
    }

    public static IApplicationBuilder UseSloncordWindowsClientGate(this IApplicationBuilder app)
    {
        app.Use(async (ctx, next) =>
        {
            var cfg = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!IsEnabled(cfg))
            {
                await next();
                return;
            }

            var path = ctx.Request.Path.Value ?? "";
            foreach (var p in PrefixAllowAlways)
            {
                if (path.StartsWith(p, StringComparison.OrdinalIgnoreCase))
                {
                    await next();
                    return;
                }
            }

            foreach (var p in PrefixAllowAnonymous)
            {
                if (path.StartsWith(p, StringComparison.OrdinalIgnoreCase))
                {
                    await next();
                    return;
                }
            }

            if (IsSloncordWindowsClient(ctx.Request.Headers))
            {
                await next();
                return;
            }

            // SPA / static for strangers
            if (HttpMethods.IsGet(ctx.Request.Method) || HttpMethods.IsHead(ctx.Request.Method))
            {
                var looksStatic =
                    path == "/"
                    || path.Equals("/index.html", StringComparison.OrdinalIgnoreCase)
                    || path.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith(".js", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                    || path.EndsWith(".html", StringComparison.OrdinalIgnoreCase);
                if (looksStatic)
                {
                    ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await ctx.Response.WriteAsJsonAsync(new { error = "Sloncord доступен только через Windows-приложение." });
                    return;
                }
            }

            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            await ctx.Response.WriteAsJsonAsync(new { error = "Требуется клиент Sloncord для Windows." });
        });
        return app;
    }

    private static bool IsSloncordWindowsClient(IHeaderDictionary headers)
    {
        var v = headers["X-Sloncord-Client"].ToString();
        if (string.IsNullOrWhiteSpace(v)) return false;
        return v.StartsWith("SloncordDesktop/", StringComparison.OrdinalIgnoreCase)
               || v.StartsWith("SloncordModeration/", StringComparison.OrdinalIgnoreCase);
    }
}
