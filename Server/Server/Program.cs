using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Sloncord;
using Sloncord.Data;
using Sloncord.Realtime;
using Sloncord.Voice;
using Sloncord.Voice.Native;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.ConfigureHttpJsonOptions(o =>
{
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
});

builder.Services.AddCors(o =>
    o.AddDefaultPolicy(p => p.AllowAnyHeader().AllowAnyMethod().AllowAnyOrigin()));

builder.Services.AddAuthentication("Sloncord")
    .AddScheme<AuthenticationSchemeOptions, SloncordPassthroughAuthHandler>("Sloncord", _ => { });
builder.Services.AddAuthorization();

var connectionString = builder.Configuration.GetConnectionString("DefaultConnection");
if (string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException("Missing ConnectionStrings:DefaultConnection (Postgres).");

builder.Services.AddDbContext<SloncordDbContext>(o => o.UseNpgsql(connectionString));
builder.Services.AddDbContextFactory<SloncordDbContext>(o => o.UseNpgsql(connectionString));
builder.Services.AddSingleton<SloncordRealtime>();
builder.Services.AddSingleton<VoiceSessionRegistry>();
builder.Services.AddSingleton<VoiceGatewayService>();
builder.Services.AddSingleton<VoiceSignalingServer>();
builder.Services.Configure<NativeVoiceOptions>(o =>
{
    var cfg = builder.Configuration;
    o.Enabled = NativeVoiceConfig.IsNativeEnabled(cfg);
    o.Port = int.TryParse(cfg["Sloncord:Voice:Native:Port"] ?? cfg["SLONCORD_VOICE_NATIVE_PORT"], out var p) ? p : 50050;
    o.PublicHost = cfg["Sloncord:Voice:Native:PublicHost"] ?? cfg["SLONCORD_VOICE_NATIVE_PUBLIC_HOST"];
    o.JoinTtlSeconds = int.TryParse(cfg["Sloncord:Voice:Native:JoinTtlSeconds"], out var ttl) ? ttl : 3600;
});
builder.Services.AddSingleton<FileAccessTicketStore>();
builder.Services.AddSingleton<NativeVoiceJoinStore>();
builder.Services.AddSingleton<NativeVoiceRegistry>();
builder.Services.AddSingleton<NativeVoiceService>();
builder.Services.AddSingleton<RealtimeGatewayHub>();
builder.Services.AddSingleton<RealtimeGatewayServer>();
builder.Services.AddHostedService<NativeVoiceUdpServer>();
builder.Services.AddSingleton<Sloncord.Services.UserPresenceService>();
builder.Services.AddSingleton<Sloncord.Services.DmCallManager>();

(string Path, bool Explicit) ResolveSloncordDataDir()
{
    var fromEnv = Environment.GetEnvironmentVariable("SLONCORD_DATA_DIR");
    if (!string.IsNullOrWhiteSpace(fromEnv))
        return (Path.GetFullPath(fromEnv.Trim()), true);
    var fromConfig = builder.Configuration["Sloncord:DataDirectory"];
    if (!string.IsNullOrWhiteSpace(fromConfig))
        return (Path.GetFullPath(fromConfig.Trim()), true);
    return (Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Sloncord",
        "server-data"), false);
}

var resolved = ResolveSloncordDataDir();
var dataDir = resolved.Path;
var storageDir = Path.Combine(dataDir, "storage");
Directory.CreateDirectory(storageDir);

var serverLogStore = new SloncordServerLogStore(dataDir);
builder.Services.AddSingleton(serverLogStore);
builder.Logging.AddProvider(new SloncordServerLoggerProvider(serverLogStore));

var app = builder.Build();
serverLogStore.Append("information", "Sloncord", $"Server starting (data: {dataDir})");
if (resolved.Explicit)
    app.Logger.LogInformation("Sloncord data directory: {DataDir}", dataDir);
else
    app.Logger.LogInformation(
        "Sloncord data: {DataDir} (для production задайте SLONCORD_DATA_DIR или Sloncord:DataDirectory вне каталога публикации приложения, иначе при деплой файлы могут пропасть)",
        dataDir);
if (app.Environment.IsDevelopment())
{
    // Возвращает JSON с текстом исключения, чтобы в Dev сразу видеть причину 500 (API, не HTML).
    app.Use(async (ctx, next) =>
    {
        try
        {
            await next();
        }
        catch (Exception ex) when (!ctx.Response.HasStarted)
        {
            ctx.Response.StatusCode = StatusCodes.Status500InternalServerError;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            await ctx.Response.WriteAsJsonAsync(new
            {
                error = ex.Message,
                type = ex.GetType().Name,
                stack = ex.StackTrace
            });
        }
    });
}
app.UseRouting();
app.UseCors();
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    if (!ctx.Request.Path.StartsWithSegments("/ws"))
    {
        var ip = SloncordClientIp.Resolve(ctx);
        if (!string.IsNullOrWhiteSpace(ip))
        {
            await using var scope = ctx.RequestServices.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            if (await SloncordPlatformIpBan.IsIpBannedAsync(db, ip, ctx.RequestAborted))
            {
                ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                await ctx.Response.WriteAsJsonAsync(new { error = "Доступ с этого IP заблокирован" });
                return;
            }
        }
    }

    try
    {
        await next();
    }
    catch (Exception ex) when (!ctx.Response.HasStarted)
    {
        var store = ctx.RequestServices.GetRequiredService<SloncordServerLogStore>();
        store.Append("error", "http", $"{ctx.Request.Method} {ctx.Request.Path}", ex);
        throw;
    }
});

app.UseWebSockets();
app.UseSloncordWindowsClientGate();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthorization();

await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
    await db.Database.EnsureCreatedAsync();
    // Схему догоняем до любых EF-запросов: модель Users уже содержит новые колонки модерации.
    await SloncordServerSchema.ApplyAsync(db);
    await SloncordLegacyImporter.TryImportFromJsonIfEmptyAsync(db, dataDir);
    await SloncordServerDataMigration.RunAsync(db);
}

var vapid = VapidKeyStore.LoadOrCreate(app.Configuration, dataDir);
var push = new WebPushSender(vapid);

var voice = app.Services.GetRequiredService<VoiceSignalingServer>();
var realtime = app.Services.GetRequiredService<SloncordRealtime>();
SloncordEndpoints.Map(app, new SloncordAppState(dataDir, storageDir, vapid, push, voice, realtime));
app.MapFallbackToFile("index.html");

app.Run();
