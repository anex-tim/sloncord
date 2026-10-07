using System.Net.WebSockets;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using System.Text.Json.Serialization;
using Sloncord.Data;
using Sloncord.Hubs;
using Sloncord.Realtime;
using Sloncord.Voice;
using Sloncord.Voice.Native;
using static Sloncord.PasswordHasher;

namespace Sloncord;

internal static class SloncordEndpoints
{
    public static void Map(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/health", () => Results.Ok(new { service = "Sloncord", status = "ok" }));

        MapAuth(app);
        MapProfile(app, s);
        MapPush(app, s);
        MapFiles(app, s);
        MapUploads(app, s);
        MapServers(app, s);
        MapChannels(app, s);
        MapDirect(app, s);
        MapVoice(app, s);
        MapRealtimeGateway(app);
        SloncordPlatformEndpoints.Map(app, s);
        SloncordMessageReportEndpoints.Map(app, s);
    }

    private static void MapAuth(WebApplication app)
    {
        app.MapPost("/auth/register", async (HttpContext ctx, SloncordDbContext db, RegisterRequest req) =>
        {
            var ipKey = SloncordClientIp.Resolve(ctx) ?? "";
            if (!AuthRateLimiter.Allow("reg:" + ipKey, 8, TimeSpan.FromHours(1)))
                return Results.Json(new { error = "Слишком много регистраций. Попробуйте позже." }, statusCode: StatusCodes.Status429TooManyRequests);
            if (string.IsNullOrWhiteSpace(req.Login) || string.IsNullOrWhiteSpace(req.Password) || string.IsNullOrWhiteSpace(req.Nickname))
                return Results.BadRequest(new { error = "Укажите логин, пароль и ник." });
            if (req.Password.Length < 6) return Results.BadRequest(new { error = "Минимальная длина пароля - 6 символов" });

            var login = req.Login.Trim();
            var nick = req.Nickname.Trim();
            if (await db.Users.AnyAsync(u => u.Login.ToLower() == login.ToLower())) return Results.BadRequest(new { error = "Логин уже занят" });
            if (await db.Users.AnyAsync(u => u.Nickname.ToLower() == nick.ToLower())) return Results.BadRequest(new { error = "Никнейм уже занят" });

            var salt = RandomNumberGenerator.GetHexString(32);
            var hash = PasswordHasher.Hash(req.Password, salt);
            var user = new UserEntity
            {
                Id = Guid.NewGuid(),
                Login = login,
                Nickname = nick,
                PasswordHash = hash,
                Salt = salt,
                Bio = string.Empty,
                AccountApproved = false,
                CreatedAtUtc = DateTime.UtcNow
            };
            db.Users.Add(user);
            SloncordUserActivity.Add(db, user.Id, "user.register", $"login={login}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            return Results.Ok(new { ok = true, pendingApproval = true });
        });

        app.MapPost("/auth/login", async (HttpContext ctx, SloncordDbContext db, LoginRequest req) =>
        {
            var ipKey = SloncordClientIp.Resolve(ctx) ?? "";
            if (!AuthRateLimiter.Allow("login:" + ipKey, 30, TimeSpan.FromMinutes(10)))
                return Results.Json(new { error = "Слишком много попыток входа. Попробуйте позже." }, statusCode: StatusCodes.Status429TooManyRequests);

            if (string.IsNullOrWhiteSpace(req.Login) || string.IsNullOrWhiteSpace(req.Password))
                return Results.BadRequest(new { error = "Укажите логин и пароль." });

            var u = await db.Users.FirstOrDefaultAsync(x => x.Login.ToLower() == req.Login.Trim().ToLower());
            if (u is null)
                return Results.Json(new { error = "Неверный логин или пароль." }, statusCode: StatusCodes.Status401Unauthorized);

            if (!PasswordHasher.Verify(req.Password, u.Salt, u.PasswordHash))
                return Results.Json(new { error = "Неверный логин или пароль." }, statusCode: StatusCodes.Status401Unauthorized);
            var upgradedPassword = PasswordHasher.IsLegacy(u.PasswordHash);
            if (upgradedPassword)
                u.PasswordHash = PasswordHasher.Hash(req.Password, u.Salt);
            await SloncordPlatformBan.TryExpireAsync(db, u.Id);
            if (SloncordPlatformBan.IsActive(u))
            {
                var deny = SloncordPlatformBan.LoginDenyIfBanned(u);
                if (deny is not null) return deny;
            }

            var ip = SloncordClientIp.Resolve(ctx);
            if (await SloncordPlatformIpBan.IsIpBannedAsync(db, ip))
                return Results.Json(new { error = "Доступ с этого IP заблокирован" }, statusCode: StatusCodes.Status403Forbidden);

            if (!u.AccountApproved && !SloncordPlatformPermissions.IsPlatformRoot(u.Login))
            {
                if (upgradedPassword)
                    await db.SaveChangesAsync();
                return Results.Json(
                    new { error = "Аккаунт ещё не одобрен модерацией. Войти можно после одобрения.", code = "account_pending" },
                    statusCode: StatusCodes.Status403Forbidden);
            }

            var now = DateTime.UtcNow;
            var token = NewSessionToken();
            db.Sessions.Add(new UserSessionEntity
            {
                Id = Guid.NewGuid(),
                Token = token,
                UserId = u.Id,
                CreatedAtUtc = now,
                CreatedFromIp = ip,
                LastSeenIp = ip,
                LastSeenAtUtc = now
            });
            u.LastKnownIp = ip;
            u.LastKnownIpAtUtc = now;
            SloncordUserActivity.Add(db, u.Id, "user.login", "", ip);
            await db.SaveChangesAsync();
            return Results.Ok(new { token });
        });
    }

    private static void MapProfile(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/profile", async (HttpContext ctx, SloncordDbContext db) =>
        {
            var u = await RequireUserAsync(ctx, db);
            if (u is null) return Results.Unauthorized();
            var presence = ctx.RequestServices.GetRequiredService<Sloncord.Services.UserPresenceService>();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            return Results.Ok(ProfileDto.FromUser(u, presence.IsOnline(u.Id), includeChatMute: true, config: config));
        });

        app.MapGet("/profile/{id:guid}", async (HttpContext ctx, SloncordDbContext db, Guid id) =>
        {
            if (await RequireUserAsync(ctx, db) is null) return Results.Unauthorized();
            var p = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
            if (p is null) return Results.NotFound(new { error = "Пользователь не найден" });
            var presence = ctx.RequestServices.GetRequiredService<Sloncord.Services.UserPresenceService>();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            return Results.Ok(ProfileDto.FromUser(p, presence.IsOnline(p.Id), config: config));
        });

        app.MapPut("/profile", async (HttpContext ctx, SloncordDbContext db, ProfileUpdateRequest req) =>
        {
            var userId = await RequireUserIdAsync(ctx, db);
            if (userId is null) return Results.Unauthorized();
            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId.Value);
            if (u is null) return Results.Unauthorized();

            if (string.IsNullOrWhiteSpace(req.Nickname)) return Results.BadRequest(new { error = "nickname обязателен" });
            var nextNick = req.Nickname.Trim();
            if (await db.Users.AnyAsync(x => x.Nickname.ToLower() == nextNick.ToLower() && x.Id != u.Id))
                return Results.BadRequest(new { error = "Никнейм уже занят" });

            u.Nickname = nextNick;
            u.Bio = req.Bio ?? string.Empty;
            SloncordUserActivity.Add(db, u.Id, "user.profile.update", $"nickname={nextNick}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            return Results.Ok(ProfileDto.FromUser(u, config: config));
        });

        app.MapPut("/profile/avatar", async (HttpContext ctx, SloncordDbContext db, AvatarUploadRequest req) =>
        {
            var userId = await RequireUserIdAsync(ctx, db);
            if (userId is null) return Results.Unauthorized();
            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId.Value);
            if (u is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.FileBase64) || string.IsNullOrWhiteSpace(req.FileName))
                return Results.BadRequest(new { error = "fileBase64 и fileName обязательны" });
            if (!IsLikelyImageContentType(req.ContentType)) return Results.BadRequest(new { error = "Разрешены только изображения" });

            var fileId = await StoreFileFromBase64Async(db, s, userId.Value, req.FileBase64, req.FileName, req.ContentType);
            u.AvatarFileId = fileId;
            SloncordUserActivity.Add(db, u.Id, "user.avatar.update", "", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            return Results.Ok(ProfileDto.FromUser(u, config: config));
        });

        app.MapPut("/profile/password", async (HttpContext ctx, SloncordDbContext db, PasswordChangeRequest req) =>
        {
            var userId = await RequireUserIdAsync(ctx, db);
            if (userId is null) return Results.Unauthorized();
            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId.Value);
            if (u is null) return Results.Unauthorized();

            if (string.IsNullOrWhiteSpace(req.CurrentPassword) || string.IsNullOrWhiteSpace(req.NewPassword))
                return Results.BadRequest(new { error = "Укажите текущий и новый пароль." });

            if (req.NewPassword.Length < 6)
                return Results.BadRequest(new { error = "Минимальная длина пароля - 6 символов" });

            if (!PasswordHasher.Verify(req.CurrentPassword, u.Salt, u.PasswordHash))
                return Results.BadRequest(new { error = "Текущий пароль указан неверно." });

            u.Salt = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
            u.PasswordHash = PasswordHasher.Hash(req.NewPassword, u.Salt);
            var sessions = await db.Sessions.Where(x => x.UserId == u.Id).ToListAsync();
            db.Sessions.RemoveRange(sessions);
            SloncordUserActivity.Add(db, u.Id, "user.password.change", "", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await SloncordSessions.NotifyPasswordChangedAsync(s, userId.Value);
            return Results.Ok(new { ok = true });
        });
    }

    private static void MapPush(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/push/vapid-public-key", () => Results.Ok(new { publicKey = s.Vapid.PublicKey }));

        app.MapPost("/push/subscribe", async (HttpContext ctx, SloncordDbContext db, PushSubscribeRequest req) =>
        {
            var u = await RequireUserAsync(ctx, db);
            if (u is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.Endpoint) || string.IsNullOrWhiteSpace(req.P256dh) || string.IsNullOrWhiteSpace(req.Auth))
                return Results.BadRequest(new { error = "endpoint, p256dh и auth обязательны" });

            var existing = await db.PushSubscriptions.FirstOrDefaultAsync(x => x.UserId == u.Id && x.Endpoint == req.Endpoint);
            if (existing is null)
            {
                db.PushSubscriptions.Add(new PushSubscriptionEntity
                {
                    Id = Guid.NewGuid(),
                    UserId = u.Id,
                    Endpoint = req.Endpoint,
                    P256dh = req.P256dh,
                    Auth = req.Auth,
                    CreatedAtUtc = DateTime.UtcNow
                });
            }
            else
            {
                existing.P256dh = req.P256dh;
                existing.Auth = req.Auth;
            }

            await db.SaveChangesAsync();
            return Results.Ok(new { ok = true });
        });

        // Debug endpoint: send a test push to the current user.
        app.MapPost("/push/test", async (HttpContext ctx, SloncordDbContext db) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            try
            {
                await s.Push.NotifyUserAsync(
                    db,
                    me.Value,
                    "Sloncord",
                    "Тестовое уведомление",
                    new { kind = "test", url = "/" },
                    ctx.RequestAborted);
            }
            catch
            {
                // best-effort
            }
            return Results.Ok(new { ok = true });
        });
    }

    private static void MapFiles(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/files/{id:guid}", async (HttpContext ctx, SloncordDbContext db, Guid id) =>
        {
            var me = await RequireUserAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
            if (f is null) return Results.NotFound(new { error = "Файл не найден" });

            var can = await UserCanAccessFileAsync(ctx, db, me.Id, f.Id);

            if (!can) return Results.Forbid();

            var path = SloncordStoragePath.ResolveInside(s.StorageDir, f.StorageName);
            if (path is null || !File.Exists(path)) return Results.NotFound(new { error = "Файл отсутствует на сервере" });

            var infoJson = new FileInfo(path);
            if (infoJson.Length > 12 * 1024 * 1024)
                return Results.Json(new { error = "Файл слишком большой для этого способа. Используйте /content." }, statusCode: StatusCodes.Status413PayloadTooLarge);

            var bytes = await File.ReadAllBytesAsync(path);
            return Results.Ok(new
            {
                file = new
                {
                    f.Id,
                    f.OriginalName,
                    f.ContentType
                },
                fileBase64 = Convert.ToBase64String(bytes)
            });
        });

        // Raw file content (supports Range) for large downloads / video streaming.
        app.MapPost("/files/{id:guid}/ticket", async (HttpContext ctx, SloncordDbContext db, FileAccessTicketStore tickets, Guid id) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await UserCanAccessFileAsync(ctx, db, me.Value, id)) return Results.Forbid();
            var (ticket, seconds) = tickets.Issue(me.Value, id, TimeSpan.FromMinutes(10));
            return Results.Ok(new { ticket, expiresInSeconds = seconds });
        });

        app.MapGet("/files/{id:guid}/content", async (HttpContext ctx, SloncordDbContext db, FileAccessTicketStore tickets, Guid id) =>
        {
            var meId = await RequireFileCallerAsync(ctx, db, tickets, id);
            if (meId is null) return Results.Unauthorized();

            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
            if (f is null) return Results.NotFound();

            var can = await UserCanAccessFileAsync(ctx, db, meId.Value, f.Id);

            if (!can) return Results.Forbid();

            var path = SloncordStoragePath.ResolveInside(s.StorageDir, f.StorageName);
            if (path is null || !File.Exists(path)) return Results.NotFound();

            var info = new FileInfo(path);
            var total = info.Length;
            if (total < 0) total = 0;

            long start = 0;
            long end = total > 0 ? total - 1 : 0;
            var hasRange = false;

            if (ctx.Request.Headers.TryGetValue("Range", out var rangeHeader))
            {
                var raw = rangeHeader.ToString();
                // bytes=start-end
                if (raw.StartsWith("bytes=", StringComparison.OrdinalIgnoreCase))
                {
                    var spec = raw["bytes=".Length..].Trim();
                    var dash = spec.IndexOf('-', StringComparison.Ordinal);
                    if (dash >= 0)
                    {
                        var s0 = spec[..dash].Trim();
                        var e0 = spec[(dash + 1)..].Trim();
                        if (long.TryParse(s0, out var s1)) start = s1;
                        if (long.TryParse(e0, out var e1)) end = e1;
                        if (string.IsNullOrWhiteSpace(s0) && long.TryParse(e0, out var suf))
                        {
                            // suffix: bytes=-N
                            var n = suf;
                            if (n > total) n = total;
                            start = Math.Max(0, total - n);
                            end = total > 0 ? total - 1 : 0;
                        }
                        if (string.IsNullOrWhiteSpace(e0))
                        {
                            end = total > 0 ? total - 1 : 0;
                        }
                        hasRange = true;
                    }
                }
            }

            if (start < 0) start = 0;
            if (end < start) end = start;
            if (start >= total)
            {
                ctx.Response.StatusCode = StatusCodes.Status416RangeNotSatisfiable;
                ctx.Response.Headers["Content-Range"] = $"bytes */{total}";
                return Results.Empty;
            }
            if (end >= total) end = total - 1;

            var length = total == 0 ? 0 : (end - start + 1);
            ctx.Response.Headers["Accept-Ranges"] = "bytes";
            ctx.Response.ContentType = EffectiveStreamContentType(f.ContentType, f.OriginalName);
            ctx.Response.Headers["Content-Disposition"] = $"inline; filename*=UTF-8''{Uri.EscapeDataString(f.OriginalName ?? "file")}";

            if (hasRange)
            {
                ctx.Response.StatusCode = StatusCodes.Status206PartialContent;
                ctx.Response.Headers["Content-Range"] = $"bytes {start}-{end}/{total}";
                ctx.Response.ContentLength = length;
            }
            else
            {
                ctx.Response.StatusCode = StatusCodes.Status200OK;
                ctx.Response.ContentLength = total;
            }

            await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
            if (start > 0) fs.Seek(start, SeekOrigin.Begin);

            const int bufSize = 64 * 1024;
            var buffer = new byte[bufSize];
            long remaining = hasRange ? length : total;
            while (remaining > 0 && !ctx.RequestAborted.IsCancellationRequested)
            {
                var read = await fs.ReadAsync(buffer.AsMemory(0, (int)Math.Min(bufSize, remaining)), ctx.RequestAborted);
                if (read <= 0) break;
                await ctx.Response.Body.WriteAsync(buffer.AsMemory(0, read), ctx.RequestAborted);
                remaining -= read;
            }

            return Results.Empty;
        });

        // Video thumbnail (poster) for fast preview. Best-effort: returns 404/204 if cannot generate.
        app.MapGet("/files/{id:guid}/thumb", async (HttpContext ctx, SloncordDbContext db, FileAccessTicketStore tickets, Guid id) =>
        {
            var meId = await RequireFileCallerAsync(ctx, db, tickets, id);
            if (meId is null) return Results.Unauthorized();

            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
            if (f is null) return Results.NotFound();

            var can = await UserCanAccessFileAsync(ctx, db, meId.Value, f.Id);
            if (!can) return Results.Forbid();

            var srcPath = SloncordStoragePath.ResolveInside(s.StorageDir, f.StorageName);
            if (srcPath is null || !File.Exists(srcPath)) return Results.NotFound();

            var thumbsDir = Path.Combine(s.StorageDir, "thumbs");
            Directory.CreateDirectory(thumbsDir);
            var outPath = Path.Combine(thumbsDir, $"{id:N}.webp");
            if (!File.Exists(outPath))
            {
                // Best-effort thumbnail extraction via ffmpeg.
                try
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = "ffmpeg",
                        Arguments = $"-hide_banner -loglevel error -y -ss 00:00:01 -i \"{srcPath}\" -frames:v 1 -vf scale=640:-1 \"{outPath}\"",
                        RedirectStandardError = true,
                        RedirectStandardOutput = true,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    using var p = Process.Start(psi);
                    if (p is null) return Results.NoContent();
                    var exited = await Task.Run(() => p.WaitForExit(5000));
                    if (!exited || p.ExitCode != 0)
                    {
                        try { if (File.Exists(outPath)) File.Delete(outPath); } catch { /* ignore */ }
                        return Results.NoContent();
                    }
                }
                catch
                {
                    try { if (File.Exists(outPath)) File.Delete(outPath); } catch { /* ignore */ }
                    return Results.NoContent();
                }
            }

            if (!File.Exists(outPath)) return Results.NoContent();
            ctx.Response.ContentType = "image/webp";
            ctx.Response.Headers["Cache-Control"] = "public, max-age=86400";
            await using var fs = new FileStream(outPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            await fs.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
            return Results.Empty;
        });

        app.MapGet("/avatars/{id:guid}", async (HttpContext ctx, SloncordDbContext db, Guid id) =>
        {
            // Only for authenticated users (avatars are visible to all users inside app)
            var me = await RequireUserAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id);
            if (f is null) return Results.NotFound(new { error = "Файл не найден" });
            var isAvatar = await db.Users.AsNoTracking().AnyAsync(u => u.AvatarFileId == id);
            if (!isAvatar && !await UserCanAccessFileAsync(ctx, db, me.Id, id)) return Results.Forbid();
            var path = SloncordStoragePath.ResolveInside(s.StorageDir, f.StorageName);
            if (path is null || !File.Exists(path)) return Results.NotFound(new { error = "Файл отсутствует на сервере" });
            if (new FileInfo(path).Length > 8 * 1024 * 1024)
                return Results.Json(new { error = "Файл слишком большой" }, statusCode: StatusCodes.Status413PayloadTooLarge);
            var bytes = await File.ReadAllBytesAsync(path);
            return Results.Ok(new
            {
                id = f.Id.ToString("D"),
                contentType = f.ContentType,
                fileBase64 = Convert.ToBase64String(bytes)
            });
        });
    }

    private static void MapUploads(WebApplication app, SloncordAppState s)
    {
        // Init a resumable upload session.
        app.MapPost("/uploads/init", async (HttpContext ctx, SloncordDbContext db, UploadInitRequest? req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: fileName, totalBytes" });
            if (string.IsNullOrWhiteSpace(req.FileName)) return Results.BadRequest(new { error = "fileName обязателен" });
            if (req.TotalBytes <= 0) return Results.BadRequest(new { error = "totalBytes должен быть > 0" });

            // Best-effort cleanup of expired sessions.
            try
            {
                var now = DateTime.UtcNow;
                var expired = await db.UploadSessions.Where(x => x.ExpiresAtUtc < now).ToListAsync(ctx.RequestAborted);
                if (expired.Count > 0)
                {
                    foreach (var e in expired)
                    {
                        var p = Path.Combine(s.StorageDir, e.TempStorageName);
                        try { if (File.Exists(p)) File.Delete(p); } catch { /* ignore */ }
                    }
                    db.UploadSessions.RemoveRange(expired);
                    await db.SaveChangesAsync(ctx.RequestAborted);
                }
            }
            catch
            {
                // ignore
            }

            var uploadId = Guid.NewGuid();
            var temp = $"{uploadId:N}.upload.part";
            var expires = DateTime.UtcNow.AddHours(24);
            var contentType = string.IsNullOrWhiteSpace(req.ContentType) ? "application/octet-stream" : req.ContentType!.Trim();

            db.UploadSessions.Add(new UploadSessionEntity
            {
                Id = uploadId,
                UserId = me.Value,
                FileName = req.FileName.Trim(),
                ContentType = contentType,
                TotalBytes = req.TotalBytes,
                UploadedBytes = 0,
                TempStorageName = temp,
                CreatedAtUtc = DateTime.UtcNow,
                ExpiresAtUtc = expires,
                State = "active"
            });
            await db.SaveChangesAsync(ctx.RequestAborted);

            // Recommend a chunk size (client may choose smaller).
            var chunkSize = 8 * 1024 * 1024; // 8 MiB
            return Results.Ok(new { uploadId = uploadId.ToString("D"), chunkSize });
        });

        // Get upload status (for resume).
        app.MapGet("/uploads/{uploadId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid uploadId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var u = await db.UploadSessions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == uploadId && x.UserId == me.Value, ctx.RequestAborted);
            if (u is null) return Results.NotFound(new { error = "upload not found" });
            return Results.Ok(new
            {
                uploadId = u.Id.ToString("D"),
                u.FileName,
                u.ContentType,
                u.TotalBytes,
                u.UploadedBytes,
                u.State,
                expiresAtUtc = u.ExpiresAtUtc.ToString("O")
            });
        });

        // Upload a chunk. Body is raw bytes.
        app.MapPut("/uploads/{uploadId:guid}/chunk", async (HttpContext ctx, SloncordDbContext db, Guid uploadId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var u = await db.UploadSessions.FirstOrDefaultAsync(x => x.Id == uploadId && x.UserId == me.Value, ctx.RequestAborted);
            if (u is null) return Results.NotFound(new { error = "upload not found" });
            if (!string.Equals(u.State, "active", StringComparison.OrdinalIgnoreCase)) return Results.BadRequest(new { error = "upload is not active" });
            if (u.ExpiresAtUtc < DateTime.UtcNow) return Results.BadRequest(new { error = "upload expired" });

            long offset = 0;
            // Prefer Content-Range: bytes start-end/total
            if (ctx.Request.Headers.TryGetValue("Content-Range", out var cr0))
            {
                var cr = cr0.ToString();
                // Very small parser, tolerate spaces.
                // Example: "bytes 0-999/12345"
                try
                {
                    var s = cr.Trim();
                    if (s.StartsWith("bytes", StringComparison.OrdinalIgnoreCase))
                        s = s[5..].Trim();
                    var parts = s.Split('/', 2);
                    var range = parts[0].Trim();
                    var dash = range.IndexOf('-', StringComparison.Ordinal);
                    if (dash > 0)
                    {
                        var startStr = range[..dash].Trim();
                        if (long.TryParse(startStr, out var st) && st >= 0) offset = st;
                    }
                }
                catch
                {
                    // ignore
                }
            }
            else if (ctx.Request.Query.TryGetValue("offset", out var off0) && long.TryParse(off0.ToString(), out var off) && off >= 0)
            {
                offset = off;
            }

            var len = ctx.Request.ContentLength ?? 0;
            if (len <= 0) return Results.BadRequest(new { error = "empty chunk" });
            if (offset < 0) return Results.BadRequest(new { error = "bad offset" });
            if (offset + len > u.TotalBytes) return Results.BadRequest(new { error = "chunk exceeds totalBytes" });

            var tmpPath = Path.Combine(s.StorageDir, u.TempStorageName);
            Directory.CreateDirectory(s.StorageDir);

            await using (var fs = new FileStream(tmpPath, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None))
            {
                fs.Seek(offset, SeekOrigin.Begin);
                await ctx.Request.Body.CopyToAsync(fs, ctx.RequestAborted);
                await fs.FlushAsync(ctx.RequestAborted);
            }

            var nextUploaded = Math.Max(u.UploadedBytes, offset + len);
            u.UploadedBytes = nextUploaded;
            await db.SaveChangesAsync(ctx.RequestAborted);
            return Results.Ok(new { ok = true, uploadedBytes = u.UploadedBytes, totalBytes = u.TotalBytes });
        });

        // Complete upload: finalize into StoredFileEntity and return fileId.
        app.MapPost("/uploads/{uploadId:guid}/complete", async (HttpContext ctx, SloncordDbContext db, Guid uploadId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var u = await db.UploadSessions.FirstOrDefaultAsync(x => x.Id == uploadId && x.UserId == me.Value, ctx.RequestAborted);
            if (u is null) return Results.NotFound(new { error = "upload not found" });
            if (!string.Equals(u.State, "active", StringComparison.OrdinalIgnoreCase)) return Results.BadRequest(new { error = "upload is not active" });
            if (u.ExpiresAtUtc < DateTime.UtcNow) return Results.BadRequest(new { error = "upload expired" });
            if (u.UploadedBytes < u.TotalBytes) return Results.BadRequest(new { error = "upload incomplete" });

            var tmpPath = Path.Combine(s.StorageDir, u.TempStorageName);
            if (!File.Exists(tmpPath)) return Results.NotFound(new { error = "temp file missing" });

            var fileId = Guid.NewGuid();
            var ext = Path.GetExtension(u.FileName);
            if (ext.Length > 8) ext = string.Empty;
            var storage = $"{fileId:N}{ext}";
            var finalPath = Path.Combine(s.StorageDir, storage);
            try
            {
                File.Move(tmpPath, finalPath);
            }
            catch
            {
                // If move failed (e.g., across FS), fallback to copy+delete.
                await using (var src = File.OpenRead(tmpPath))
                await using (var dst = File.Create(finalPath))
                {
                    await src.CopyToAsync(dst, ctx.RequestAborted);
                }
                try { File.Delete(tmpPath); } catch { /* ignore */ }
            }

            db.Files.Add(new StoredFileEntity
            {
                Id = fileId,
                OriginalName = u.FileName,
                ContentType = u.ContentType,
                SizeBytes = u.TotalBytes,
                StorageName = storage,
                UploadedByUserId = me.Value,
                UploadedAtUtc = DateTime.UtcNow
            });

            u.State = "completed";
            db.UploadSessions.Remove(u);
            await db.SaveChangesAsync(ctx.RequestAborted);

            return Results.Ok(new { ok = true, fileId = fileId.ToString("D") });
        });
    }

    private static void MapServers(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/servers", async (HttpContext ctx, SloncordDbContext db) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var list = await BuildServerListDtosForUserAsync(db, me.Value);
            return Results.Ok(list);
        });

        app.MapPost("/servers", async (HttpContext ctx, SloncordDbContext db, CreateServerRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: name" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name обязателен" });

            var code = SloncordServerDataMigration.NewInviteCode();
            var server = new ServerEntity
            {
                Id = Guid.NewGuid(),
                Name = req.Name.Trim(),
                Description = req.Description?.Trim() ?? string.Empty,
                OwnerUserId = me.Value,
                InviteCode = code,
                CreatedAtUtc = DateTime.UtcNow
            };
            db.Servers.Add(server);
            db.ServerMembers.Add(new ServerMemberEntity
            {
                ServerId = server.Id,
                UserId = me.Value,
                JoinedAtUtc = DateTime.UtcNow
            });

            var def = new ChannelEntity
            {
                Id = Guid.NewGuid(),
                Name = "общий",
                Kind = ChannelKindEntity.Public,
                ServerId = server.Id,
                OwnerUserId = me.Value,
                CreatedAtUtc = DateTime.UtcNow,
                Members = new List<ChannelMemberEntity> { new() { UserId = me.Value, JoinedAtUtc = DateTime.UtcNow } }
            };
            foreach (var m in def.Members!) m.ChannelId = def.Id;
            db.Channels.Add(def);
            SloncordUserActivity.Add(db, me.Value, "server.create", $"name={server.Name}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await BroadcastServerListForUserAsync(db, s.Realtime, me.Value);
            var built = await BuildServerListDtosForUserAsync(db, me.Value);
            return Results.Ok(built.First(s => s.Id == server.Id.ToString("D")));
        });

        app.MapDelete("/servers/{serverId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid serverId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();

            var srv = await db.Servers.FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            if (!await SloncordServerPermissions.IsEffectiveServerOwnerAsync(db, srv, me.Value, config))
                return Results.Forbid();

            // Capture affected users before cascade delete.
            var users = await db.ServerMembers.AsNoTracking()
                .Where(m => m.ServerId == serverId)
                .Select(m => m.UserId)
                .ToListAsync();

            SloncordUserActivity.Add(db, me.Value, "server.delete", $"name={srv.Name}", SloncordClientIp.Resolve(ctx));
            db.Servers.Remove(srv);
            await db.SaveChangesAsync();

            foreach (var u in users.Distinct())
            {
                await BroadcastServerListForUserAsync(db, s.Realtime, u);
            }
            return Results.Ok(new { ok = true });
        });

        app.MapPut("/servers/{serverId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid serverId, ServerUpdateRequest req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name обязателен" });
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();

            var srv = await db.Servers.FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            if (!await SloncordServerPermissions.IsEffectiveServerOwnerAsync(db, srv, me.Value, config))
                return Results.Forbid();

            srv.Name = req.Name.Trim();
            srv.Description = req.Description?.Trim() ?? string.Empty;
            SloncordUserActivity.Add(db, me.Value, "server.update", $"name={srv.Name}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();

            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new { ok = true });
        });

        app.MapPut("/servers/{serverId:guid}/avatar", async (HttpContext ctx, SloncordDbContext db, Guid serverId, AvatarUploadRequest req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var srv = await db.Servers.FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            if (!await SloncordServerPermissions.IsEffectiveServerOwnerAsync(db, srv, me.Value, config))
                return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.FileBase64) || string.IsNullOrWhiteSpace(req.FileName))
                return Results.BadRequest(new { error = "fileBase64 и fileName обязательны" });
            if (!IsLikelyImageContentType(req.ContentType)) return Results.BadRequest(new { error = "Разрешены только изображения" });

            var fileId = await StoreFileFromBase64Async(db, s, me.Value, req.FileBase64, req.FileName, req.ContentType);
            srv.AvatarFileId = fileId;
            await db.SaveChangesAsync();

            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new { ok = true, avatarFileId = fileId.ToString("D") });
        });

        app.MapPost("/servers/{serverId:guid}/leave", async (HttpContext ctx, SloncordDbContext db, Guid serverId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var srv = await db.Servers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            if (srv.OwnerUserId == me.Value) return Results.BadRequest(new { error = "Владелец не может покинуть сервер — удалите сервер" });

            var sm = await db.ServerMembers.FirstOrDefaultAsync(x => x.ServerId == serverId && x.UserId == me.Value);
            if (sm is null) return Results.Ok(new { ok = true });
            db.ServerMembers.Remove(sm);

            // Also remove channel memberships of this server.
            var channelIds = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId == serverId)
                .Select(c => c.Id)
                .ToListAsync();
            db.ChannelMembers.RemoveRange(db.ChannelMembers.Where(m => channelIds.Contains(m.ChannelId) && m.UserId == me.Value));
            db.ChannelReadStates.RemoveRange(db.ChannelReadStates.Where(x => channelIds.Contains(x.ChannelId) && x.UserId == me.Value));

            SloncordUserActivity.Add(db, me.Value, "server.leave", $"server={srv.Name}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await BroadcastServerListForUserAsync(db, s.Realtime, me.Value);
            return Results.Ok(new { ok = true });
        });

        app.MapGet("/servers/{serverId:guid}/members", async (HttpContext ctx, SloncordDbContext db, Guid serverId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await db.ServerMembers.AnyAsync(m => m.ServerId == serverId && m.UserId == me.Value))
                return Results.Forbid();

            var userIds = await db.ServerMembers.AsNoTracking()
                .Where(m => m.ServerId == serverId)
                .Select(m => m.UserId)
                .ToListAsync();
            var users = await db.Users.AsNoTracking()
                .Where(u => userIds.Contains(u.Id))
                .ToListAsync();
            var presence = ctx.RequestServices.GetRequiredService<Sloncord.Services.UserPresenceService>();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var list = users
                .OrderBy(u => u.Nickname, StringComparer.OrdinalIgnoreCase)
                .Select(u => ProfileDto.FromUser(u, presence.IsOnline(u.Id), config: config))
                .ToList();
            return Results.Ok(list);
        });

        app.MapDelete("/servers/{serverId:guid}/members/{userId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid serverId, Guid userId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var srv = await db.Servers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>()))
                return Results.Forbid();
            if (userId == srv.OwnerUserId) return Results.BadRequest(new { error = "Нельзя удалить владельца" });
            if (userId != me.Value && await SloncordServerPermissions.IsServerAdminAsync(db, serverId, userId)
                && !SloncordServerPermissions.IsServerOwner(srv, me.Value))
                return Results.Forbid();

            var targetNick = await SloncordUserActivity.FormatUserNicknameAsync(db, userId);
            var serverName = await SloncordUserActivity.FormatServerNameAsync(db, serverId);
            await RemoveUserFromServerAsync(db, s, serverId, userId);
            SloncordUserActivity.Add(db, me.Value, "server.member.kick", $"server={serverName};target={targetNick}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();

            await BroadcastServerListForUserAsync(db, s.Realtime, userId);
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new { ok = true });
        });

        app.MapPut("/servers/{serverId:guid}/members/{userId:guid}/admin", async (HttpContext ctx, SloncordDbContext db, Guid serverId, Guid userId, SetServerAdminRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Ожидается JSON: isAdmin" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var srv = await db.Servers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.IsEffectiveServerOwnerAsync(db, srv, me.Value, config))
                return Results.Forbid();
            if (userId == srv.OwnerUserId) return Results.BadRequest(new { error = "Нельзя изменить роль владельца" });

            var sm = await db.ServerMembers.FirstOrDefaultAsync(x => x.ServerId == serverId && x.UserId == userId);
            if (sm is null) return Results.NotFound(new { error = "Участник не найден" });
            sm.IsAdmin = req.IsAdmin;
            var targetNick = await SloncordUserActivity.FormatUserNicknameAsync(db, userId);
            var serverName = await SloncordUserActivity.FormatServerNameAsync(db, serverId);
            SloncordUserActivity.Add(db, me.Value, "server.member.admin", $"server={serverName};target={targetNick};isAdmin={req.IsAdmin}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new { ok = true, isAdmin = sm.IsAdmin });
        });

        app.MapPost("/servers/{serverId:guid}/members/{userId:guid}/ban", async (HttpContext ctx, SloncordDbContext db, Guid serverId, Guid userId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var srv = await db.Servers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>()))
                return Results.Forbid();
            if (userId == srv.OwnerUserId) return Results.BadRequest(new { error = "Нельзя забанить владельца" });
            if (userId != me.Value && await SloncordServerPermissions.IsServerAdminAsync(db, serverId, userId)
                && !SloncordServerPermissions.IsServerOwner(srv, me.Value))
                return Results.Forbid();

            if (!await db.ServerBans.AnyAsync(b => b.ServerId == serverId && b.UserId == userId))
            {
                db.ServerBans.Add(new ServerBanEntity
                {
                    ServerId = serverId,
                    UserId = userId,
                    BannedByUserId = me.Value,
                    BannedAtUtc = DateTime.UtcNow
                });
            }

            var targetNick = await SloncordUserActivity.FormatUserNicknameAsync(db, userId);
            var serverName = await SloncordUserActivity.FormatServerNameAsync(db, serverId);
            await RemoveUserFromServerAsync(db, s, serverId, userId);
            SloncordUserActivity.Add(db, me.Value, "server.member.ban", $"server={serverName};target={targetNick}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();

            await BroadcastServerListForUserAsync(db, s.Realtime, userId);
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new { ok = true });
        });

        app.MapGet("/servers/{serverId:guid}/bans", async (HttpContext ctx, SloncordDbContext db, Guid serverId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>()))
                return Results.Forbid();

            var bans = await db.ServerBans.AsNoTracking()
                .Where(b => b.ServerId == serverId)
                .OrderByDescending(b => b.BannedAtUtc)
                .ToListAsync();
            var userIds = bans.Select(b => b.UserId).Distinct().ToList();
            var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToListAsync();
            var byId = users.ToDictionary(u => u.Id);
            var presence = ctx.RequestServices.GetRequiredService<Sloncord.Services.UserPresenceService>();
            var list = bans.Select(b =>
            {
                byId.TryGetValue(b.UserId, out var u);
                return new
                {
                    userId = b.UserId.ToString("D"),
                    bannedAtUtc = b.BannedAtUtc.ToString("O"),
                    user = u is null ? null : ProfileDto.FromUser(u, presence.IsOnline(u.Id))
                };
            });
            return Results.Ok(list);
        });

        app.MapDelete("/servers/{serverId:guid}/bans/{userId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid serverId, Guid userId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>()))
                return Results.Forbid();

            var ban = await db.ServerBans.FirstOrDefaultAsync(b => b.ServerId == serverId && b.UserId == userId);
            if (ban is null) return Results.Ok(new { ok = true });
            db.ServerBans.Remove(ban);
            await db.SaveChangesAsync();
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/servers/{serverId:guid}/members/{userId:guid}/disconnect-voice", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid serverId, Guid userId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>()))
                return Results.Forbid();

            var roomIds = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId == serverId && c.Kind == ChannelKindEntity.Voice)
                .Select(c => $"channel:{c.Id:D}")
                .ToListAsync();
            var n = s.Voice.ForceDisconnectUser(userId, roomIds);
            await RevokeVoiceOnlyAccessForUserOnServerAsync(db, r, serverId, userId);
            return Results.Ok(new { ok = true, disconnected = n });
        });

        app.MapPost("/servers/{serverId:guid}/members/{userId:guid}/move-voice", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid serverId, Guid userId, MoveVoiceRequest? req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (req is null || !Guid.TryParse(req.ChannelId, out var targetChannelId))
                return Results.BadRequest(new { error = "channelId обязателен" });
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>()))
                return Results.Forbid();
            if (userId == me.Value)
                return Results.BadRequest(new { error = "Нельзя переместить себя" });

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c =>
                c.Id == targetChannelId && c.ServerId == serverId && c.Kind == ChannelKindEntity.Voice);
            if (ch is null) return Results.NotFound(new { error = "Голосовой канал не найден" });

            foreach (var roomId in s.Voice.GetActiveRoomIdsForUser(userId))
            {
                if (!VoiceSignalingServer.TryParseChannelRoom(roomId, out var oldChannelId)) continue;
                if (oldChannelId == targetChannelId) continue;
                await RevokeVoiceOnlyChannelAccessAsync(db, r, userId, oldChannelId);
            }

            if (ch.IsPrivate)
            {
                var cm = await db.ChannelMembers.FirstOrDefaultAsync(m => m.ChannelId == targetChannelId && m.UserId == userId);
                if (cm is null)
                {
                    if (!await db.ServerMembers.AnyAsync(m => m.ServerId == serverId && m.UserId == userId))
                        return Results.BadRequest(new { error = "Пользователь не на сервере" });
                    db.ChannelMembers.Add(new ChannelMemberEntity
                    {
                        ChannelId = targetChannelId,
                        UserId = userId,
                        JoinedAtUtc = DateTime.UtcNow,
                        IsVoiceOnly = true
                    });
                    await db.SaveChangesAsync();
                }
                await BroadcastServerListForUserAsync(db, r, userId);
            }

            var targetRoomId = $"channel:{targetChannelId:D}";
            s.Voice.NotifyVoiceMove(userId, targetRoomId, targetChannelId.ToString("D"), serverId.ToString("D"));
            try
            {
                await r.ToUserAsync(userId, SloncordHubEvents.VoiceMoved, new
                {
                    channelId = targetChannelId.ToString("D"),
                    serverId = serverId.ToString("D")
                });
            }
            catch { /* ignore */ }

            return Results.Ok(new { ok = true });
        });

        app.MapPost("/servers/join", async (HttpContext ctx, SloncordDbContext db, JoinServerRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: inviteCode" });
            if (string.IsNullOrWhiteSpace(req.InviteCode)) return Results.BadRequest(new { error = "inviteCode обязателен" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var code = req.InviteCode.Trim();
            var server = await db.Servers
                .FirstOrDefaultAsync(s => s.InviteCode == code);
            if (server is null) return Results.NotFound(new { error = "Сервер не найден" });
            if (await SloncordServerPermissions.IsBannedAsync(db, server.Id, me.Value))
                return Results.BadRequest(new { error = "Вы заблокированы на этом сервере" });

            if (await db.ServerMembers.AnyAsync(m => m.ServerId == server.Id && m.UserId == me.Value))
            {
                await BroadcastServerListForUserAsync(db, s.Realtime, me.Value);
                return Results.Ok(new { ok = true, serverId = server.Id.ToString("D") });
            }

            db.ServerMembers.Add(new ServerMemberEntity
            {
                ServerId = server.Id,
                UserId = me.Value,
                JoinedAtUtc = DateTime.UtcNow
            });
            var channelIds = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId == server.Id && !c.IsPrivate)
                .Select(c => c.Id)
                .ToListAsync();
            foreach (var chId in channelIds)
            {
                if (!await db.ChannelMembers.AnyAsync(m => m.ChannelId == chId && m.UserId == me.Value))
                {
                    db.ChannelMembers.Add(new ChannelMemberEntity
                    {
                        ChannelId = chId,
                        UserId = me.Value,
                        JoinedAtUtc = DateTime.UtcNow
                    });
                }
            }

            // Important: for a new member, do NOT treat historical messages as unread.
            // Initialize read state to the latest message in each text channel at join time.
            foreach (var chId in channelIds)
            {
                var chKind = await db.Channels.AsNoTracking()
                    .Where(c => c.Id == chId)
                    .Select(c => c.Kind)
                    .FirstOrDefaultAsync();
                if (chKind == ChannelKindEntity.Voice) continue;

                var lastMsgId = await db.Messages.AsNoTracking()
                    .Where(m => m.ChannelId == chId && !m.IsDeleted)
                    .OrderByDescending(m => m.CreatedAtUtc)
                    .Select(m => m.Id)
                    .FirstOrDefaultAsync();

                var st = await db.ChannelReadStates.FirstOrDefaultAsync(x => x.UserId == me.Value && x.ChannelId == chId);
                if (st is null)
                {
                    st = new ChannelReadStateEntity
                    {
                        UserId = me.Value,
                        ChannelId = chId,
                        LastReadMessageId = lastMsgId == Guid.Empty ? null : lastMsgId,
                        UpdatedAtUtc = DateTime.UtcNow
                    };
                    db.ChannelReadStates.Add(st);
                }
                else
                {
                    st.LastReadMessageId = lastMsgId == Guid.Empty ? null : lastMsgId;
                    st.UpdatedAtUtc = DateTime.UtcNow;
                }
            }

            SloncordUserActivity.Add(db, me.Value, "server.join", $"server={server.Name}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await BroadcastServerListForUserAsync(db, s.Realtime, me.Value);
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, server.Id);
            return Results.Ok(new { ok = true, serverId = server.Id.ToString("D") });
        });

        app.MapPost("/servers/{serverId:guid}/channels", async (HttpContext ctx, SloncordDbContext db, Guid serverId, CreateChannelRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: name" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name обязателен" });
            if (!await db.ServerMembers.AnyAsync(m => m.ServerId == serverId && m.UserId == me.Value)) return Results.Forbid();

            Guid? categoryId = null;
            ChannelCategoryEntity? category = null;
            if (!string.IsNullOrWhiteSpace(req.CategoryId) && Guid.TryParse(req.CategoryId, out var catParsed))
            {
                category = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == catParsed && c.ServerId == serverId);
                if (category is null) return Results.BadRequest(new { error = "Категория не найдена" });
                categoryId = catParsed;
            }

            var kind = string.Equals(req.Type, "voice", StringComparison.OrdinalIgnoreCase)
                ? ChannelKindEntity.Voice
                : ChannelKindEntity.Public;
            var isPrivate = req.IsPrivate == true || category?.IsPrivate == true;
            var maxPos = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId == serverId && c.CategoryId == categoryId)
                .Select(c => (int?)c.Position)
                .MaxAsync() ?? -1;

            var ch = new ChannelEntity
            {
                Id = Guid.NewGuid(),
                Name = req.Name.Trim(),
                Kind = kind,
                ServerId = serverId,
                OwnerUserId = me.Value,
                CreatedAtUtc = DateTime.UtcNow,
                CategoryId = categoryId,
                Position = maxPos + 1,
                IsPrivate = isPrivate
            };
            if (isPrivate)
            {
                if (category?.IsPrivate == true)
                {
                    var catMemberIds = await db.CategoryMembers.AsNoTracking()
                        .Where(m => m.CategoryId == category.Id)
                        .Select(m => m.UserId)
                        .ToListAsync();
                    ch.Members = catMemberIds.Select(u => new ChannelMemberEntity
                    {
                        UserId = u,
                        JoinedAtUtc = DateTime.UtcNow
                    }).ToList();
                }
                else
                {
                    ch.Members = new List<ChannelMemberEntity>
                    {
                        new() { UserId = me.Value, JoinedAtUtc = DateTime.UtcNow }
                    };
                }
            }
            else
            {
                var serverUserIds = await db.ServerMembers
                    .Where(m => m.ServerId == serverId)
                    .Select(m => m.UserId)
                    .ToListAsync();
                ch.Members = serverUserIds.Select(u => new ChannelMemberEntity
                {
                    UserId = u,
                    JoinedAtUtc = DateTime.UtcNow
                }).ToList();
            }
            db.Channels.Add(ch);
            foreach (var m in ch.Members) m.ChannelId = ch.Id;
            var serverName = await SloncordUserActivity.FormatServerNameAsync(db, serverId);
            var channelType = kind == ChannelKindEntity.Voice ? "voice" : "text";
            SloncordUserActivity.Add(db, me.Value, "channel.create", $"server={serverName};channel=#{ch.Name};type={channelType}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(await ToChannelListItemAsync(db, me.Value, ch.Id));
        });

        app.MapPost("/servers/{serverId:guid}/categories", async (HttpContext ctx, SloncordDbContext db, Guid serverId, CreateCategoryRequest? req) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { error = "name обязателен" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, config))
                return Results.Forbid();

            var maxPos = await db.ChannelCategories.AsNoTracking()
                .Where(c => c.ServerId == serverId)
                .Select(c => (int?)c.Position)
                .MaxAsync() ?? -1;
            var catPrivate = req.IsPrivate == true;
            var cat = new ChannelCategoryEntity
            {
                Id = Guid.NewGuid(),
                ServerId = serverId,
                Name = req.Name.Trim(),
                Position = maxPos + 1,
                IsPrivate = catPrivate
            };
            db.ChannelCategories.Add(cat);
            if (catPrivate)
            {
                db.CategoryMembers.Add(new CategoryMemberEntity
                {
                    CategoryId = cat.Id,
                    UserId = me.Value,
                    JoinedAtUtc = DateTime.UtcNow
                });
            }
            await db.SaveChangesAsync();
            if (catPrivate)
                await SloncordCategoryPrivacy.SyncCategoryChildChannelsAsync(db, cat.Id);
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new CategoryListItemDto
            {
                Id = cat.Id.ToString("D"),
                Name = cat.Name,
                Position = cat.Position,
                IsPrivate = cat.IsPrivate
            });
        });

        app.MapPut("/servers/{serverId:guid}/layout", async (HttpContext ctx, SloncordDbContext db, Guid serverId, ServerLayoutRequest? req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, serverId, me.Value, config))
                return Results.Forbid();
            if (req is null) return Results.BadRequest(new { error = "Ожидается JSON layout" });

            if (req.Categories is not null)
            {
                foreach (var item in req.Categories)
                {
                    if (!Guid.TryParse(item.Id, out var catId)) continue;
                    var cat = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == catId && c.ServerId == serverId);
                    if (cat is null) continue;
                    cat.Position = item.Position;
                    if (!string.IsNullOrWhiteSpace(item.Name)) cat.Name = item.Name.Trim();
                }
            }

            if (req.Channels is not null)
            {
                foreach (var item in req.Channels)
                {
                    if (!Guid.TryParse(item.Id, out var chId)) continue;
                    var ch = await db.Channels.FirstOrDefaultAsync(c => c.Id == chId && c.ServerId == serverId);
                    if (ch is null) continue;
                    ch.Position = item.Position;
                    if (item.CategoryId is null || string.IsNullOrWhiteSpace(item.CategoryId))
                        ch.CategoryId = null;
                    else if (Guid.TryParse(item.CategoryId, out var cid))
                    {
                        if (await db.ChannelCategories.AnyAsync(c => c.Id == cid && c.ServerId == serverId))
                        {
                            ch.CategoryId = cid;
                            await SloncordCategoryPrivacy.ApplyChannelCategoryPrivacyAsync(db, ch);
                        }
                    }
                }
            }

            await db.SaveChangesAsync();
            await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId);
            return Results.Ok(new { ok = true });
        });
    }

    private static void MapChannels(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/channels/{channelId:guid}/voice/presence", async (HttpContext ctx, SloncordDbContext db, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            var roomId = $"channel:{channelId:D}";
            var p = s.Voice.GetPresence(roomId);
            return Results.Ok(new
            {
                channelId = channelId.ToString("D"),
                userIds = p.UserIds,
                screenShareUserIds = p.ScreenShareUserIds,
                mutedUserIds = p.MutedUserIds,
                deafenedUserIds = p.DeafenedUserIds,
                speakingUserIds = p.SpeakingUserIds,
                startedAtUtc = p.StartedAtUtc?.ToString("O")
            });
        });

        app.MapPost("/channels/{channelId:guid}/voice/left", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var nativeSvc = ctx.RequestServices.GetRequiredService<NativeVoiceService>();
            nativeSvc.Leave(me.Value, $"channel:{channelId:D}");
            await RevokeVoiceOnlyChannelAccessAsync(db, r, me.Value, channelId);
            return Results.Ok(new { ok = true });
        });

        app.MapDelete("/channels/{channelId:guid}", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var ch = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanManageChannelAsync(db, ch, me.Value, config)) return Results.Forbid();

            var serverId = ch.ServerId;
            var memberUserIds = await db.ChannelMembers.AsNoTracking()
                .Where(m => m.ChannelId == channelId)
                .Select(m => m.UserId)
                .ToListAsync();

            db.ChannelReadStates.RemoveRange(db.ChannelReadStates.Where(x => x.ChannelId == channelId));
            db.Messages.RemoveRange(db.Messages.Where(x => x.ChannelId == channelId));
            db.ChannelMembers.RemoveRange(db.ChannelMembers.Where(x => x.ChannelId == channelId));
            var channelLocation = serverId is not null
                ? $"{await SloncordUserActivity.FormatServerNameAsync(db, serverId.Value)} / #{ch.Name}"
                : $"#{ch.Name}";
            SloncordUserActivity.Add(db, me.Value, "channel.delete", $"channel={channelLocation}", SloncordClientIp.Resolve(ctx));
            db.Channels.Remove(ch);
            await db.SaveChangesAsync();

            // Re-broadcast server list (channel list) for members of the server.
            try
            {
                if (serverId is not null)
                {
                    await BroadcastAllServerMemberListsAsync(db, s.Realtime, serverId.Value);
                }
                else
                {
                    // DM channel: refresh lists for members
                    foreach (var uid in memberUserIds.Distinct())
                    {
                        await BroadcastChannelListAsync(db, r, uid, isDm: true);
                    }
                }
            }
            catch
            {
                // Channel is already deleted; don't fail the request if list refresh breaks (e.g. schema lag).
            }
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/channels/{channelId:guid}/leave", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind == ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Нельзя покинуть DM канал" });
            if (ch.OwnerUserId == me.Value) return Results.BadRequest(new { error = "Создатель не может покинуть канал — удалите его" });

            var cm = await db.ChannelMembers.FirstOrDefaultAsync(x => x.ChannelId == channelId && x.UserId == me.Value);
            if (cm is null) return Results.Ok(new { ok = true });

            db.ChannelMembers.Remove(cm);
            db.ChannelReadStates.RemoveRange(db.ChannelReadStates.Where(x => x.ChannelId == channelId && x.UserId == me.Value));
            await db.SaveChangesAsync();

            if (ch.ServerId is not null)
            {
                await BroadcastAllServerMemberListsAsync(db, s.Realtime, ch.ServerId.Value);
            }
            else
            {
                await BroadcastChannelListAsync(db, r, me.Value, isDm: false);
            }
            return Results.Ok(new { ok = true });
        });

        app.MapPut("/channels/{channelId:guid}/meta", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId, ChannelUpdateNameRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Ожидается JSON" });
            if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "name обязателен" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var ch = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind == ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Переименовать DM нельзя" });
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanManageChannelAsync(db, ch, me.Value, config)) return Results.Forbid();

            ch.Name = req.Name.Trim();
            await db.SaveChangesAsync();
            if (ch.ServerId is not null) await BroadcastAllServerMemberListsAsync(db, r, ch.ServerId.Value);
            return Results.Ok(new { ok = true, name = ch.Name });
        });

        app.MapGet("/channels/{channelId:guid}/messages", async (HttpContext ctx, SloncordDbContext db, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var chKind = await db.Channels.AsNoTracking()
                .Where(c => c.Id == channelId)
                .Select(c => c.Kind)
                .FirstOrDefaultAsync();
            if (chKind == ChannelKindEntity.Voice) return Results.Ok(new List<object>());

            int limit = 30;
            try
            {
                var raw = ctx.Request.Query["limit"].FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(raw) && int.TryParse(raw, out var n))
                    limit = Math.Clamp(n, 1, 200);
            }
            catch { /* ignore */ }

            DateTime? beforeUtc = null;
            try
            {
                var raw = ctx.Request.Query["before"].FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(raw) && DateTime.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var dt))
                    beforeUtc = dt;
            }
            catch { /* ignore */ }

            var q = db.Messages.AsNoTracking()
                .Where(m => m.ChannelId == channelId && !m.IsDeleted);
            if (beforeUtc is not null)
                q = q.Where(m => m.CreatedAtUtc < beforeUtc.Value);

            // Fetch newest first for pagination, then return chronological to the client.
            var list = await q
                .OrderByDescending(m => m.CreatedAtUtc)
                .Take(limit)
                .ToListAsync();
            list.Reverse();

            var outList = new List<object>();
            foreach (var m in list) outList.Add(await ToMessageDtoAsync(db, m));
            return Results.Ok(outList);
        });

        app.MapGet("/channels/{channelId:guid}/members", async (HttpContext ctx, SloncordDbContext db, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var userIds = await db.ChannelMembers.AsNoTracking()
                .Where(m => m.ChannelId == channelId)
                .Select(m => m.UserId)
                .ToListAsync();

            var users = await db.Users.AsNoTracking()
                .Where(u => userIds.Contains(u.Id))
                .ToListAsync();

            var presence = ctx.RequestServices.GetRequiredService<Sloncord.Services.UserPresenceService>();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            return Results.Ok(users.Select(u => ProfileDto.FromUser(u, presence.IsOnline(u.Id), config: config)).ToList());
        });

        app.MapPost("/channels/{channelId:guid}/read", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            await MarkReadAsync(db, r, me.Value, channelId);
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/channels/{channelId:guid}/messages", async (HttpContext ctx, SloncordDbContext db, Guid channelId, NewMessageRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: text и/или file" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            var muteDeny0 = await SloncordChatMute.DenyResultIfMutedAsync(db, me.Value);
            if (muteDeny0 is not null) return muteDeny0;
            var hasAttachments = req.AttachmentFileIds is not null && req.AttachmentFileIds.Any(x => !string.IsNullOrWhiteSpace(x));
            var hasFiles = req.Files is not null && req.Files.Any(f => !string.IsNullOrWhiteSpace(f?.FileBase64));
            if (string.IsNullOrWhiteSpace(req.Text) && string.IsNullOrWhiteSpace(req.FileBase64) && !hasAttachments && !hasFiles)
                return Results.BadRequest(new { error = "text или file обязателен" });

            var chKind0 = await db.Channels.AsNoTracking()
                .Where(c => c.Id == channelId)
                .Select(c => c.Kind)
                .FirstOrDefaultAsync();
            if (chKind0 == ChannelKindEntity.Voice) return Results.BadRequest(new { error = "В голосовом канале нет текстового чата" });

            try
            {
                var msg = await CreateMessageInChannelAsync(ctx, db, s, me.Value, channelId, req);
                return Results.Ok(msg);
            }
            catch (BadHttpRequestException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
            catch (Exception ex)
            {
                // Debug-friendly error payload (keeps UI from showing a blind "500").
                var b = ex.GetBaseException();
                return Results.Json(new
                {
                    error = $"{ex.Message} | {b.GetType().Name}: {b.Message}",
                    type = ex.GetType().Name,
                    baseError = b.Message,
                    baseType = b.GetType().Name
                }, statusCode: 500);
            }
        });

        app.MapPut("/channels/{channelId:guid}/messages/{messageId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid channelId, Guid messageId, EditMessageRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: text или removeAttachmentFileIds" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            var muteDeny1 = await SloncordChatMute.DenyResultIfMutedAsync(db, me.Value);
            if (muteDeny1 is not null) return muteDeny1;

            var chKind1 = await db.Channels.AsNoTracking()
                .Where(c => c.Id == channelId)
                .Select(c => c.Kind)
                .FirstOrDefaultAsync();
            if (chKind1 == ChannelKindEntity.Voice) return Results.BadRequest(new { error = "В голосовом канале нет сообщений" });

            var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == messageId && x.ChannelId == channelId);
            if (m is null) return Results.NotFound();
            if (m.SenderUserId != me) return Results.Forbid();

            var didChange = false;

            // Text update is optional; allow "attachment-only" edits.
            if (req.Text is not null)
            {
                var nextText = req.Text.Trim();
                if (string.IsNullOrWhiteSpace(nextText))
                    return Results.BadRequest(new { error = "text не должен быть пустым" });
                if (!string.Equals((m.Text ?? string.Empty).Trim(), nextText, StringComparison.Ordinal))
                {
                    m.Text = nextText;
                    didChange = true;
                }
            }

            // Remove attachments (optional)
            var removedAny = false;
            if (req.RemoveAttachmentFileIds is not null && req.RemoveAttachmentFileIds.Count > 0)
            {
                var ids = new HashSet<Guid>();
                foreach (var raw in req.RemoveAttachmentFileIds)
                {
                    if (string.IsNullOrWhiteSpace(raw)) continue;
                    if (Guid.TryParse(raw, out var g)) ids.Add(g);
                }

                if (ids.Count > 0)
                {
                    // Remove normalized attachment rows
                    var rows = await db.MessageAttachments
                        .Where(a => a.MessageId == m.Id && ids.Contains(a.FileId))
                        .ToListAsync();
                    if (rows.Count > 0)
                    {
                        db.MessageAttachments.RemoveRange(rows);
                        removedAny = true;
                    }

                    // Also support removing legacy single attachment
                    if (m.FileId is not null && ids.Contains(m.FileId.Value))
                    {
                        m.FileId = null;
                        removedAny = true;
                    }

                    if (removedAny) didChange = true;
                }
            }

            if (!didChange)
            {
                var sameDto = await ToMessageDtoAsync(db, m);
                return Results.Ok(sameDto);
            }

            m.EditedAtUtc = DateTime.UtcNow;
            var channelLocation = await SloncordUserActivity.FormatChannelLocationAsync(db, channelId);
            SloncordUserActivity.Add(db, me.Value, "message.edit", $"channel={channelLocation};preview={SloncordUserActivity.Truncate(m.Text)}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            var dto = await ToMessageDtoAsync(db, m);
            await s.Realtime.ToChannelAsync(channelId, SloncordHubEvents.MessageUpdated, new
            {
                channelId = channelId.ToString("D"),
                message = dto
            });
            return Results.Ok(dto);
        });

        app.MapDelete("/channels/{channelId:guid}/messages/{messageId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid channelId, Guid messageId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var chKind2 = await db.Channels.AsNoTracking()
                .Where(c => c.Id == channelId)
                .Select(c => c.Kind)
                .FirstOrDefaultAsync();
            if (chKind2 == ChannelKindEntity.Voice) return Results.BadRequest(new { error = "В голосовом канале нет сообщений" });

            var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == messageId && x.ChannelId == channelId);
            if (m is null) return Results.NotFound();
            var canDelete = m.SenderUserId == me
                || await SloncordServerPermissions.CanModerateServerMessagesAsync(db, channelId, me.Value, ctx.RequestServices.GetRequiredService<IConfiguration>());
            if (!canDelete) return Results.Forbid();
            m.IsDeleted = true;
            m.EditedAtUtc = DateTime.UtcNow;
            var channelLocation = await SloncordUserActivity.FormatChannelLocationAsync(db, channelId);
            SloncordUserActivity.Add(db, me.Value, "message.delete", $"channel={channelLocation};preview={SloncordUserActivity.Truncate(m.Text)}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            try
            {
                await s.Realtime.ToChannelAsync(channelId, SloncordHubEvents.MessageDeleted, new
                {
                    channelId = channelId.ToString("D"),
                    messageId = messageId.ToString("D")
                });
            }
            catch
            {
                // Message is deleted; ignore realtime publish failures.
            }
            return Results.Ok(new { ok = true });
        });

        app.MapPut("/channels/{channelId:guid}/avatar", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId, AvatarUploadRequest req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var ch = await db.Channels.FirstOrDefaultAsync(x => x.Id == channelId);
            if (ch is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanManageChannelAsync(db, ch, me.Value, config)) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.FileBase64) || string.IsNullOrWhiteSpace(req.FileName))
                return Results.BadRequest(new { error = "fileBase64 и fileName обязательны" });
            if (!IsLikelyImageContentType(req.ContentType)) return Results.BadRequest(new { error = "Разрешены только изображения" });

            var fileId = await StoreFileFromBase64Async(db, s, me.Value, req.FileBase64, req.FileName, req.ContentType);
            ch.AvatarFileId = fileId;
            await db.SaveChangesAsync();

            // refresh server list for members
            if (ch.ServerId is not null)
            {
                await BroadcastAllServerMemberListsAsync(db, r, ch.ServerId.Value);
            }
            return Results.Ok(new { ok = true, avatarFileId = fileId.ToString("D") });
        });

        app.MapPut("/categories/{categoryId:guid}/meta", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid categoryId, ChannelUpdateNameRequest? req) =>
        {
            if (req is null || string.IsNullOrWhiteSpace(req.Name))
                return Results.BadRequest(new { error = "name обязателен" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var cat = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == categoryId);
            if (cat is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, cat.ServerId, me.Value, config))
                return Results.Forbid();
            cat.Name = req.Name.Trim();
            await db.SaveChangesAsync();
            await BroadcastAllServerMemberListsAsync(db, r, cat.ServerId);
            return Results.Ok(new { ok = true, name = cat.Name, isPrivate = cat.IsPrivate });
        });

        app.MapPut("/categories/{categoryId:guid}/privacy", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid categoryId, CategoryPrivacyRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Ожидается JSON" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var cat = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == categoryId);
            if (cat is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, cat.ServerId, me.Value, config))
                return Results.Forbid();
            await SloncordCategoryPrivacy.SetCategoryPrivateAsync(db, cat, req.IsPrivate == true, me.Value);
            await BroadcastAllServerMemberListsAsync(db, r, cat.ServerId);
            return Results.Ok(new { ok = true, isPrivate = cat.IsPrivate });
        });

        app.MapGet("/categories/{categoryId:guid}/members", async (HttpContext ctx, SloncordDbContext db, Guid categoryId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var cat = await db.ChannelCategories.AsNoTracking().FirstOrDefaultAsync(c => c.Id == categoryId);
            if (cat is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!cat.IsPrivate)
                return Results.BadRequest(new { error = "Категория не приватная" });
            if (!await db.CategoryMembers.AnyAsync(m => m.CategoryId == categoryId && m.UserId == me.Value)
                && !await SloncordServerPermissions.CanModerateServerAsync(db, cat.ServerId, me.Value, config))
                return Results.Forbid();

            var userIds = await db.CategoryMembers.AsNoTracking()
                .Where(m => m.CategoryId == categoryId)
                .Select(m => m.UserId)
                .ToListAsync();
            var users = await db.Users.AsNoTracking()
                .Where(u => userIds.Contains(u.Id))
                .ToListAsync();
            var presence = ctx.RequestServices.GetRequiredService<Sloncord.Services.UserPresenceService>();
            return Results.Ok(users.Select(u => ProfileDto.FromUser(u, presence.IsOnline(u.Id), config: config)).ToList());
        });

        app.MapPost("/categories/{categoryId:guid}/members", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid categoryId, ChannelMemberRequest? req) =>
        {
            if (req is null || !Guid.TryParse(req.UserId, out var targetId))
                return Results.BadRequest(new { error = "userId обязателен" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var cat = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == categoryId);
            if (cat is null || !cat.IsPrivate) return Results.BadRequest(new { error = "Категория не приватная" });
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, cat.ServerId, me.Value, config))
                return Results.Forbid();
            if (!await db.ServerMembers.AnyAsync(m => m.ServerId == cat.ServerId && m.UserId == targetId))
                return Results.BadRequest(new { error = "Пользователь не на сервере" });
            if (!await db.CategoryMembers.AnyAsync(m => m.CategoryId == categoryId && m.UserId == targetId))
            {
                db.CategoryMembers.Add(new CategoryMemberEntity
                {
                    CategoryId = categoryId,
                    UserId = targetId,
                    JoinedAtUtc = DateTime.UtcNow
                });
                await db.SaveChangesAsync();
                await SloncordCategoryPrivacy.SyncCategoryChildChannelsAsync(db, categoryId);
            }
            await BroadcastServerListForUserAsync(db, r, targetId);
            return Results.Ok(new { ok = true });
        });

        app.MapDelete("/categories/{categoryId:guid}/members/{userId:guid}", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid categoryId, Guid userId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var cat = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == categoryId);
            if (cat is null || !cat.IsPrivate) return Results.BadRequest(new { error = "Категория не приватная" });
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, cat.ServerId, me.Value, config))
                return Results.Forbid();
            var cm = await db.CategoryMembers.FirstOrDefaultAsync(m => m.CategoryId == categoryId && m.UserId == userId);
            if (cm is null) return Results.Ok(new { ok = true });
            db.CategoryMembers.Remove(cm);
            await db.SaveChangesAsync();
            await SloncordCategoryPrivacy.SyncCategoryChildChannelsAsync(db, categoryId);
            await BroadcastServerListForUserAsync(db, r, userId);
            return Results.Ok(new { ok = true });
        });

        app.MapDelete("/categories/{categoryId:guid}", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid categoryId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var cat = await db.ChannelCategories.FirstOrDefaultAsync(c => c.Id == categoryId);
            if (cat is null) return Results.NotFound();
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanModerateServerAsync(db, cat.ServerId, me.Value, config))
                return Results.Forbid();
            var channels = await db.Channels.Where(c => c.CategoryId == categoryId).ToListAsync();
            foreach (var ch in channels) ch.CategoryId = null;
            db.ChannelCategories.Remove(cat);
            await db.SaveChangesAsync();
            await BroadcastAllServerMemberListsAsync(db, r, cat.ServerId);
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/channels/{channelId:guid}/members", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId, ChannelMemberRequest? req) =>
        {
            if (req is null || !Guid.TryParse(req.UserId, out var targetId))
                return Results.BadRequest(new { error = "userId обязателен" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var ch = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null || !ch.IsPrivate) return Results.BadRequest(new { error = "Канал не приватный" });
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanManagePrivateChannelMembersAsync(db, ch, me.Value, config))
                return Results.Forbid();
            if (ch.ServerId is null) return Results.BadRequest();
            if (!await db.ServerMembers.AnyAsync(m => m.ServerId == ch.ServerId && m.UserId == targetId))
                return Results.BadRequest(new { error = "Пользователь не на сервере" });
            if (await db.ChannelMembers.AnyAsync(m => m.ChannelId == channelId && m.UserId == targetId))
                return Results.Ok(new { ok = true });
            db.ChannelMembers.Add(new ChannelMemberEntity
            {
                ChannelId = channelId,
                UserId = targetId,
                JoinedAtUtc = DateTime.UtcNow
            });
            await db.SaveChangesAsync();
            await BroadcastServerListForUserAsync(db, r, targetId);
            return Results.Ok(new { ok = true });
        });

        app.MapDelete("/channels/{channelId:guid}/members/{userId:guid}", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId, Guid userId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            var ch = await db.Channels.FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null || !ch.IsPrivate) return Results.BadRequest(new { error = "Канал не приватный" });
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (!await SloncordServerPermissions.CanManagePrivateChannelMembersAsync(db, ch, me.Value, config))
                return Results.Forbid();
            if (userId == ch.OwnerUserId) return Results.BadRequest(new { error = "Нельзя убрать создателя канала" });
            var cm = await db.ChannelMembers.FirstOrDefaultAsync(m => m.ChannelId == channelId && m.UserId == userId);
            if (cm is null) return Results.Ok(new { ok = true });
            db.ChannelMembers.Remove(cm);
            await db.SaveChangesAsync();
            await BroadcastServerListForUserAsync(db, r, userId);
            return Results.Ok(new { ok = true });
        });
    }

    private static void MapDirect(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/dm/channels", async (HttpContext ctx, SloncordDbContext db) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var list = await SloncordQueries.DirectChannelsForUser(db, me.Value)
                .OrderBy(c => c.CreatedAtUtc)
                .ToListAsync();

            var result = new List<ChannelListItemDto>();
            foreach (var c in list)
            {
                result.Add(await ToChannelListItemAsync(db, me.Value, c.Id));
            }
            // Sort by latest message activity (Discord-like DM list).
            result = result
                .OrderByDescending(x => DateTime.TryParse(x.LastMessageAtUtc, out var d) ? d : DateTime.MinValue)
                .ToList();
            return Results.Ok(result);
        });

        app.MapPost("/dm/start-by-nickname", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, InviteRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: nickname" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.Nickname)) return Results.BadRequest(new { error = "nickname обязателен" });

            var other = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Nickname.ToLower() == req.Nickname.Trim().ToLower());
            if (other is null) return Results.NotFound(new { error = "Пользователь не найден" });
            if (other.Id == me.Value) return Results.BadRequest(new { error = "Нельзя написать самому себе" });

            var existing = await FindDirectChannelAsync(db, me.Value, other.Id);
            if (existing is not null) return Results.Ok(await ToChannelListItemAsync(db, me.Value, existing.Value));

            var ch = new ChannelEntity
            {
                Id = Guid.NewGuid(),
                Name = $"DM:{me.Value:N}",
                Kind = ChannelKindEntity.Direct,
                OwnerUserId = me.Value,
                CreatedAtUtc = DateTime.UtcNow,
                Members = new List<ChannelMemberEntity>
                {
                    new() { UserId = me.Value, JoinedAtUtc = DateTime.UtcNow },
                    new() { UserId = other.Id, JoinedAtUtc = DateTime.UtcNow }
                }
            };
            foreach (var m in ch.Members!) m.ChannelId = ch.Id;
            db.Channels.Add(ch);
            SloncordUserActivity.Add(db, me.Value, "dm.start", $"target={other.Nickname}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();

            var dto = await ToChannelListItemAsync(db, me.Value, ch.Id);
            try
            {
                await r.ToUserAsync(other.Id, SloncordHubEvents.DmCreated, new { channel = dto });
            }
            catch
            {
            }
            try
            {
                await BroadcastChannelListAsync(db, r, me.Value, isDm: true);
                await BroadcastChannelListAsync(db, r, other.Id, isDm: true);
            }
            catch
            {
            }
            return Results.Ok(dto);
        });

        app.MapPost("/dm/start-by-user", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, StartDmByUserRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: userId" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (string.IsNullOrWhiteSpace(req.UserId)) return Results.BadRequest(new { error = "userId обязателен" });
            if (!Guid.TryParse(req.UserId, out var otherId)) return Results.BadRequest(new { error = "userId должен быть guid" });
            if (otherId == me.Value) return Results.BadRequest(new { error = "Нельзя написать самому себе" });

            var other = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == otherId);
            if (other is null) return Results.NotFound(new { error = "Пользователь не найден" });

            var existing = await FindDirectChannelAsync(db, me.Value, other.Id);
            if (existing is not null) return Results.Ok(await ToChannelListItemAsync(db, me.Value, existing.Value));

            var ch = new ChannelEntity
            {
                Id = Guid.NewGuid(),
                Name = $"DM:{me.Value:N}",
                Kind = ChannelKindEntity.Direct,
                OwnerUserId = me.Value,
                CreatedAtUtc = DateTime.UtcNow,
                Members = new List<ChannelMemberEntity>
                {
                    new() { UserId = me.Value, JoinedAtUtc = DateTime.UtcNow },
                    new() { UserId = other.Id, JoinedAtUtc = DateTime.UtcNow }
                }
            };
            foreach (var m in ch.Members!) m.ChannelId = ch.Id;
            db.Channels.Add(ch);
            SloncordUserActivity.Add(db, me.Value, "dm.start", $"target={other.Nickname}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();

            var dto = await ToChannelListItemAsync(db, me.Value, ch.Id);
            try { await r.ToUserAsync(other.Id, SloncordHubEvents.DmCreated, new { channel = dto }); } catch { }
            try
            {
                await BroadcastChannelListAsync(db, r, me.Value, isDm: true);
                await BroadcastChannelListAsync(db, r, other.Id, isDm: true);
            }
            catch
            {
            }
            return Results.Ok(dto);
        });

        app.MapGet("/dm/{channelId:guid}/messages", async (HttpContext ctx, SloncordDbContext db, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });

            var clearedUpTo = await SloncordQueries.GetDmClearedUpToUtcAsync(db, me.Value, channelId, ctx.RequestAborted);

            int limit = 30;
            try
            {
                var raw = ctx.Request.Query["limit"].FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(raw) && int.TryParse(raw, out var n))
                    limit = Math.Clamp(n, 1, 200);
            }
            catch { /* ignore */ }

            DateTime? beforeUtc = null;
            try
            {
                var raw = ctx.Request.Query["before"].FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(raw) && DateTime.TryParse(raw, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal, out var dt))
                    beforeUtc = dt;
            }
            catch { /* ignore */ }

            var q = db.Messages.AsNoTracking()
                .Where(m => m.ChannelId == channelId && !m.IsDeleted)
                .Where(m => clearedUpTo == null || m.CreatedAtUtc > clearedUpTo.Value);
            if (beforeUtc is not null)
                q = q.Where(m => m.CreatedAtUtc < beforeUtc.Value);

            var list = await q
                .OrderByDescending(m => m.CreatedAtUtc)
                .Take(limit)
                .ToListAsync();
            list.Reverse();
            var outList = new List<object>();
            foreach (var m in list) outList.Add(await ToMessageDtoAsync(db, m));
            return Results.Ok(outList);
        });

        app.MapPost("/dm/{channelId:guid}/read", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });

            await MarkReadAsync(db, r, me.Value, channelId);
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/dm/{channelId:guid}/messages", async (HttpContext ctx, SloncordDbContext db, Guid channelId, NewMessageRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: text и/или file" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });
            var muteDenyDm = await SloncordChatMute.DenyResultIfMutedAsync(db, me.Value);
            if (muteDenyDm is not null) return muteDenyDm;
            var hasAttachments = req.AttachmentFileIds is not null && req.AttachmentFileIds.Any(x => !string.IsNullOrWhiteSpace(x));
            var hasFiles = req.Files is not null && req.Files.Any(f => !string.IsNullOrWhiteSpace(f?.FileBase64));
            if (string.IsNullOrWhiteSpace(req.Text) && string.IsNullOrWhiteSpace(req.FileBase64) && !hasAttachments && !hasFiles)
                return Results.BadRequest(new { error = "text или file обязателен" });

            try
            {
                var msg = await CreateMessageInChannelAsync(ctx, db, s, me.Value, channelId, req);
                return Results.Ok(msg);
            }
            catch (BadHttpRequestException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
            catch (Exception ex)
            {
                // Debug-friendly error payload (keeps UI from showing a blind "500").
                var b = ex.GetBaseException();
                return Results.Json(new
                {
                    error = $"{ex.Message} | {b.GetType().Name}: {b.Message}",
                    type = ex.GetType().Name,
                    baseError = b.Message,
                    baseType = b.GetType().Name
                }, statusCode: 500);
            }
        });

        app.MapPut("/dm/{channelId:guid}/messages/{messageId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid channelId, Guid messageId, EditMessageRequest? req) =>
        {
            // Same as /channels/.../messages, but enforces direct kind
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: text или removeAttachmentFileIds" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            var muteDenyDmEdit = await SloncordChatMute.DenyResultIfMutedAsync(db, me.Value);
            if (muteDenyDmEdit is not null) return muteDenyDmEdit;

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });

            var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == messageId && x.ChannelId == channelId);
            if (m is null) return Results.NotFound();
            if (m.SenderUserId != me) return Results.Forbid();

            var didChange = false;

            if (req.Text is not null)
            {
                var nextText = req.Text.Trim();
                if (string.IsNullOrWhiteSpace(nextText))
                    return Results.BadRequest(new { error = "text не должен быть пустым" });
                if (!string.Equals((m.Text ?? string.Empty).Trim(), nextText, StringComparison.Ordinal))
                {
                    m.Text = nextText;
                    didChange = true;
                }
            }

            var removedAny = false;
            if (req.RemoveAttachmentFileIds is not null && req.RemoveAttachmentFileIds.Count > 0)
            {
                var ids = new HashSet<Guid>();
                foreach (var raw in req.RemoveAttachmentFileIds)
                {
                    if (string.IsNullOrWhiteSpace(raw)) continue;
                    if (Guid.TryParse(raw, out var g)) ids.Add(g);
                }

                if (ids.Count > 0)
                {
                    var rows = await db.MessageAttachments
                        .Where(a => a.MessageId == m.Id && ids.Contains(a.FileId))
                        .ToListAsync();
                    if (rows.Count > 0)
                    {
                        db.MessageAttachments.RemoveRange(rows);
                        removedAny = true;
                    }

                    if (m.FileId is not null && ids.Contains(m.FileId.Value))
                    {
                        m.FileId = null;
                        removedAny = true;
                    }

                    if (removedAny) didChange = true;
                }
            }

            if (!didChange)
            {
                var sameDto = await ToMessageDtoAsync(db, m);
                return Results.Ok(sameDto);
            }

            m.EditedAtUtc = DateTime.UtcNow;
            SloncordUserActivity.Add(db, me.Value, "dm.message.edit", $"preview={SloncordUserActivity.Truncate(m.Text)}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            var dto = await ToMessageDtoAsync(db, m);
            await s.Realtime.ToChannelAsync(channelId, SloncordHubEvents.MessageUpdated, new
            {
                channelId = channelId.ToString("D"),
                message = dto
            });
            return Results.Ok(dto);
        });

        app.MapDelete("/dm/{channelId:guid}/messages/{messageId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid channelId, Guid messageId) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });

            var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == messageId && x.ChannelId == channelId);
            if (m is null) return Results.NotFound();
            if (m.SenderUserId != me) return Results.Forbid();
            m.IsDeleted = true;
            m.EditedAtUtc = DateTime.UtcNow;
            SloncordUserActivity.Add(db, me.Value, "dm.message.delete", $"preview={SloncordUserActivity.Truncate(m.Text)}", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();
            await s.Realtime.ToChannelAsync(channelId, SloncordHubEvents.MessageDeleted, new
            {
                channelId = channelId.ToString("D"),
                messageId = messageId.ToString("D")
            });
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/dm/{channelId:guid}/delete", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Guid channelId, DeleteDmConversationRequest? req) =>
        {
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();

            var ch = await db.Channels
                .Include(c => c.Members)
                .FirstOrDefaultAsync(c => c.Id == channelId, ctx.RequestAborted);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });

            var deleteForPeer = req?.DeleteForPeer ?? true;

            var memberIds = (ch.Members ?? new List<ChannelMemberEntity>()).Select(m => m.UserId).ToList();
            var otherId = memberIds.FirstOrDefault(x => x != me.Value);

            if (deleteForPeer)
            {
                // Полное удаление DM у обоих: канал + история
                var otherNick = otherId != Guid.Empty
                    ? await SloncordUserActivity.FormatUserNicknameAsync(db, otherId)
                    : "?";
                SloncordUserActivity.Add(db, me.Value, "dm.delete", $"target={otherNick};forPeer=true", SloncordClientIp.Resolve(ctx));
                db.Channels.Remove(ch);
                await db.SaveChangesAsync();

                if (otherId != Guid.Empty)
                {
                    try
                    {
                        await BroadcastChannelListAsync(db, r, me.Value, isDm: true);
                        await BroadcastChannelListAsync(db, r, otherId, isDm: true);
                    }
                    catch
                    {
                    }
                }
                else
                {
                    try { await BroadcastChannelListAsync(db, r, me.Value, isDm: true); } catch { }
                }

                return Results.Ok(new { ok = true });
            }

            // Только у себя: прячем историю, но оставляем у собеседника
            var now = DateTime.UtcNow;
            var lastAt = await db.Messages.AsNoTracking()
                .Where(m => m.ChannelId == channelId && !m.IsDeleted)
                .OrderByDescending(m => m.CreatedAtUtc)
                .Select(m => m.CreatedAtUtc)
                .FirstOrDefaultAsync(ctx.RequestAborted);
            var boundary = lastAt == default ? now : (lastAt > now ? lastAt : now);

            var st = await db.ChannelReadStates.FirstOrDefaultAsync(x => x.UserId == me.Value && x.ChannelId == channelId, ctx.RequestAborted);
            if (st is null)
            {
                st = new ChannelReadStateEntity
                {
                    UserId = me.Value,
                    ChannelId = channelId,
                    LastReadMessageId = null,
                    UpdatedAtUtc = now
                };
                db.ChannelReadStates.Add(st);
            }
            st.DmClearedUpToUtc = boundary;
            st.UpdatedAtUtc = now;
            var otherNickLocal = otherId != Guid.Empty
                ? await SloncordUserActivity.FormatUserNicknameAsync(db, otherId)
                : "?";
            SloncordUserActivity.Add(db, me.Value, "dm.delete", $"target={otherNickLocal};forPeer=false", SloncordClientIp.Resolve(ctx));
            await db.SaveChangesAsync();

            try
            {
                await MarkReadAsync(db, r, me.Value, channelId);
            }
            catch
            {
            }
            try { await BroadcastChannelListAsync(db, r, me.Value, isDm: true); } catch { }

            return Results.Ok(new { ok = true });
        });

        // DM call signaling (ringing + accept/decline). Voice media still uses the existing voice join flow (channelId is the DM id).
        app.MapPost("/dm/{channelId:guid}/call/start", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Sloncord.Services.DmCallManager calls, Guid channelId, DmCallStartRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: callId" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.CallId) || !Guid.TryParse(req.CallId, out var callId) || callId == Guid.Empty)
                return Results.BadRequest(new { error = "callId должен быть guid" });

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound();
            if (ch.Kind != ChannelKindEntity.Direct) return Results.BadRequest(new { error = "Неверный тип чата" });

            var meUser = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == me.Value);
            var fromNick = meUser?.Nickname ?? "пользователь";
            var fromAvatar = meUser?.AvatarFileId?.ToString("D");

            var otherIds = await db.ChannelMembers.AsNoTracking()
                .Where(m => m.ChannelId == channelId && m.UserId != me.Value)
                .Select(m => m.UserId)
                .ToListAsync(ctx.RequestAborted);

            // Track ringing call and auto-timeout after 30s (best-effort, server-side).
            try
            {
                var to = otherIds.FirstOrDefault();
                if (to != Guid.Empty)
                {
                    calls.RegisterRingingCall(channelId, callId, me.Value, to, DateTime.UtcNow);
                }
            }
            catch { /* ignore */ }

            var payload = new
            {
                callId = callId.ToString("D"),
                channelId = channelId.ToString("D"),
                fromUserId = me.Value.ToString("D"),
                fromNickname = fromNick,
                fromAvatarFileId = fromAvatar,
                startedAtUtc = DateTime.UtcNow.ToString("O")
            };

            foreach (var uid in otherIds)
            {
                try { await r.ToUserAsync(uid, SloncordHubEvents.DmCallIncoming, payload); } catch { /* ignore */ }
                try
                {
                    // Push: best-effort. iOS/PWA will open the app to this DM and show the incoming call UI.
                    await s.Push.NotifyUserAsync(
                        db,
                        uid,
                        $"Входящий звонок",
                        $"От {fromNick}",
                        new
                        {
                            kind = "call",
                            url = $"/?open=dm:{channelId:D}&call=incoming&callId={callId:D}",
                            channelId = channelId.ToString("D"),
                            callId = callId.ToString("D"),
                            fromUserId = me.Value.ToString("D"),
                            fromNickname = fromNick
                        },
                        ctx.RequestAborted);
                }
                catch { /* ignore */ }
            }

            return Results.Ok(new { ok = true });
        });

        app.MapPost("/dm/{channelId:guid}/call/respond", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Sloncord.Services.DmCallManager calls, Guid channelId, DmCallRespondRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: callId, action, toUserId" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.CallId) || !Guid.TryParse(req.CallId, out var callId) || callId == Guid.Empty)
                return Results.BadRequest(new { error = "callId должен быть guid" });
            if (string.IsNullOrWhiteSpace(req.ToUserId) || !Guid.TryParse(req.ToUserId, out var toUserId) || toUserId == Guid.Empty)
                return Results.BadRequest(new { error = "toUserId должен быть guid" });
            var action = (req.Action ?? "").Trim().ToLowerInvariant();
            if (action != "accept" && action != "decline")
                return Results.BadRequest(new { error = "action должен быть accept или decline" });

            try
            {
                DateTime? acceptedAtUtc = null;
                if (action == "accept")
                {
                    acceptedAtUtc = calls.MarkAccepted(channelId, callId, DateTime.UtcNow);
                }
                else
                {
                    // Decline ends ringing.
                    calls.Cancel(channelId, callId);
                }
                await r.ToUserAsync(toUserId, SloncordHubEvents.DmCallResponse, new
                {
                    callId = callId.ToString("D"),
                    channelId = channelId.ToString("D"),
                    fromUserId = me.Value.ToString("D"),
                    action,
                    acceptedAtUtc = acceptedAtUtc?.ToString("O")
                });
            }
            catch { /* ignore */ }
            return Results.Ok(new { ok = true });
        });

        app.MapPost("/dm/{channelId:guid}/call/cancel", async (HttpContext ctx, SloncordDbContext db, SloncordRealtime r, Sloncord.Services.DmCallManager calls, Guid channelId, DmCallCancelRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: callId" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.CallId) || !Guid.TryParse(req.CallId, out var callId) || callId == Guid.Empty)
                return Results.BadRequest(new { error = "callId должен быть guid" });

            var otherIds = await db.ChannelMembers.AsNoTracking()
                .Where(m => m.ChannelId == channelId && m.UserId != me.Value)
                .Select(m => m.UserId)
                .ToListAsync(ctx.RequestAborted);

            var wasRinging = false;
            try
            {
                // If caller cancelled while still ringing, record as missed call in chat.
                if (calls.TryCancelRinging(channelId, callId, out var fromUserId, out _))
                {
                    wasRinging = true;
                    var fromNick = await db.Users.AsNoTracking()
                        .Where(u => u.Id == fromUserId)
                        .Select(u => u.Nickname)
                        .FirstOrDefaultAsync(ctx.RequestAborted) ?? "пользователь";
                    await Sloncord.Services.SystemMessageHelpers.CreateSystemMessageAsync(
                        ctx.RequestServices.GetRequiredService<IDbContextFactory<SloncordDbContext>>(),
                        s.Realtime,
                        channelId,
                        $"Пропущенный звонок от {fromNick}",
                        ctx.RequestAborted);
                }
                else
                {
                    calls.Cancel(channelId, callId);
                }
            }
            catch { /* ignore */ }

            foreach (var uid in otherIds)
            {
                try
                {
                    await r.ToUserAsync(uid, SloncordHubEvents.DmCallCancelled, new
                    {
                        callId = callId.ToString("D"),
                        channelId = channelId.ToString("D"),
                        fromUserId = me.Value.ToString("D"),
                        reason = wasRinging ? "cancelled_ringing" : "cancelled"
                    });
                }
                catch { /* ignore */ }
            }

            return Results.Ok(new { ok = true });
        });

        app.MapPost("/dm/{channelId:guid}/call/end", async (HttpContext ctx, SloncordDbContext db, Sloncord.Services.DmCallManager calls, Guid channelId, DmCallCancelRequest? req) =>
        {
            if (req is null) return Results.BadRequest(new { error = "Требуется JSON: callId" });
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await IsMemberAsync(db, channelId, me.Value)) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(req.CallId) || !Guid.TryParse(req.CallId, out var callId) || callId == Guid.Empty)
                return Results.BadRequest(new { error = "callId должен быть guid" });

            try
            {
                await calls.EndAcceptedCallAsync(channelId, callId, DateTime.UtcNow, ctx.RequestAborted);
            }
            catch { /* ignore */ }
            return Results.Ok(new { ok = true });
        });
    }

    private static void MapVoice(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/voice/ice", async (HttpContext ctx) =>
        {
            await using var scope = ctx.RequestServices.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var cfg = ctx.RequestServices.GetRequiredService<IConfiguration>();
            string[] urls =
                cfg.GetSection("Sloncord:Voice:Turn:Urls").Get<string[]>() ??
                Array.Empty<string>();

            // Fallback: systemd env files and some providers can be finicky with arrays.
            // Support a single comma/space-separated var too.
            if (urls.Length == 0)
            {
                var raw =
                    cfg["SLONCORD_TURN_URLS"]
                    ?? Environment.GetEnvironmentVariable("SLONCORD_TURN_URLS")
                    ?? cfg["Sloncord:Voice:Turn:UrlsRaw"]
                    ?? "";
                if (!string.IsNullOrWhiteSpace(raw))
                {
                    urls = raw
                        .Split(new[] { ',', ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .ToArray();
                }
            }

            var username =
                cfg["Sloncord:Voice:Turn:Username"] ??
                cfg["SLONCORD_TURN_USERNAME"] ??
                Environment.GetEnvironmentVariable("SLONCORD_TURN_USERNAME") ??
                "";

            var credential =
                cfg["Sloncord:Voice:Turn:Credential"] ??
                cfg["SLONCORD_TURN_CREDENTIAL"] ??
                Environment.GetEnvironmentVariable("SLONCORD_TURN_CREDENTIAL") ??
                "";

            // Always include a public STUN as a baseline.
            var servers = new List<object> { new { urls = "stun:stun.l.google.com:19302" } };

            if (urls.Length > 0 && !string.IsNullOrWhiteSpace(username) && !string.IsNullOrWhiteSpace(credential))
            {
                servers.Add(new { urls, username, credential });
            }

            // Include safe debug info to diagnose env/config issues (never include credential).
            return Results.Ok(new
            {
                iceServers = servers,
                debug = new
                {
                    turnUrlsCount = urls.Length,
                    turnUsernameSet = !string.IsNullOrWhiteSpace(username),
                    turnCredentialSet = !string.IsNullOrWhiteSpace(credential),
                    turnUrls = urls
                }
            });
        });

        app.MapPost("/voice/sfuToken", async (HttpContext ctx) =>
        {
            await using var scope = ctx.RequestServices.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            SfuTokenRequest? req;
            try
            {
                req = await ctx.Request.ReadFromJsonAsync<SfuTokenRequest>();
            }
            catch
            {
                req = null;
            }

            if (req is null || string.IsNullOrWhiteSpace(req.RoomId))
                return Results.BadRequest(new { error = "roomId обязателен" });

            if (!TryParseChannelRoom(req.RoomId.Trim(), out var channelId))
                return Results.BadRequest(new { error = "Неверный roomId" });

            if (!await IsMemberAsync(db, channelId, me.Value))
                return Results.Forbid();

            var cfg = ctx.RequestServices.GetRequiredService<IConfiguration>();
            if (NativeVoiceConfig.IsNativePrimary(cfg) && NativeVoiceConfig.IsNativeEnabled(cfg))
            {
                return Results.Json(new { error = "Legacy SFU отключён. Используйте native voice.", mode = "native" }, statusCode: 410);
            }

            var gateway = SfuTokenHelper.IsGatewayEnabled(cfg);
            var (sfuUrl, secret, ttlSeconds) = SfuTokenHelper.ReadSfuConfig(cfg);

            if (string.IsNullOrWhiteSpace(sfuUrl))
                return Results.Problem("SFU URL не настроен (Sloncord:Voice:Sfu:Url или SLONCORD_SFU_URL).", statusCode: 500);

            if (string.IsNullOrWhiteSpace(secret) || secret.Length < 16)
                return Results.Problem("SFU secret не настроен (Sloncord:Voice:Sfu:Secret или SLONCORD_SFU_SECRET).", statusCode: 500);

            string? token = null;
            string? publicSfuUrl = null;
            if (!gateway)
            {
                token = SfuTokenHelper.CreateToken(secret, me.Value, req.RoomId.Trim(), DateTime.UtcNow.AddSeconds(ttlSeconds));
                publicSfuUrl = sfuUrl;
            }

            var iceServers = GetIceServers(cfg);

            return Results.Ok(new
            {
                gateway,
                token,
                sfuUrl = publicSfuUrl,
                iceServers,
                tokenTtlSeconds = ttlSeconds,
                graceSeconds = SfuTokenHelper.ReadGraceSeconds(cfg)
            });
        });

        app.Map("/ws/voice", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }
            var token = ctx.Request.Query["token"].FirstOrDefault();
            if (string.IsNullOrWhiteSpace(token))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            await using var scope = ctx.RequestServices.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var userId = await GetUserIdFromTokenAsync(db, token);
            if (userId is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            // Do not use RequestAborted for the long-lived voice leg: it can cut the socket
            // under reverse proxies/idle and breaks signaling while the browser still needs it.
            await s.Voice.HandleAsync(ws, userId.Value, CancellationToken.None);
        });

        app.MapGet("/voice/config", (HttpContext ctx) =>
        {
            var cfg = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var nativeEnabled = NativeVoiceConfig.IsNativeEnabled(cfg);
            var mode = NativeVoiceConfig.IsNativePrimary(cfg) && nativeEnabled ? "native" : "legacy";
            var nativeSvc = ctx.RequestServices.GetRequiredService<NativeVoiceService>();
            return Results.Ok(new
            {
                mode,
                native = new
                {
                    enabled = nativeEnabled && nativeSvc.IsEnabled,
                    udpPort = nativeSvc.IsEnabled
                        ? ctx.RequestServices.GetRequiredService<Microsoft.Extensions.Options.IOptionsMonitor<NativeVoiceOptions>>().CurrentValue.Port
                        : (int?)null
                },
                legacy = new { sfu = true }
            });
        });

        app.MapPost("/voice/native/join", async (HttpContext ctx) =>
        {
            await using var scope = ctx.RequestServices.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var me = await RequireUserIdAsync(ctx, db);
            if (me is null) return Results.Unauthorized();

            var nativeSvc = ctx.RequestServices.GetRequiredService<NativeVoiceService>();
            if (!nativeSvc.IsEnabled)
                return Results.Problem("Native voice отключён на сервере.", statusCode: 503);

            SfuTokenRequest? req;
            try { req = await ctx.Request.ReadFromJsonAsync<SfuTokenRequest>(); }
            catch { req = null; }

            if (req is null || string.IsNullOrWhiteSpace(req.RoomId))
                return Results.BadRequest(new { error = "roomId обязателен" });
            if (!TryParseChannelRoom(req.RoomId.Trim(), out var channelId))
                return Results.BadRequest(new { error = "Неверный roomId" });
            if (!await IsMemberAsync(db, channelId, me.Value))
                return Results.Forbid();

            var join = nativeSvc.CreateJoin(me.Value, "channel:" + channelId.ToString("D"));
            var udpHost = join.UdpHost;
            if (string.IsNullOrWhiteSpace(udpHost)
                || udpHost is "127.0.0.1" or "localhost" or "::1")
            {
                var reqHost = ctx.Request.Host.Host;
                if (!string.IsNullOrWhiteSpace(reqHost)) udpHost = reqHost.Trim();
            }

            return Results.Ok(new
            {
                udpHost,
                udpPort = join.UdpPort,
                sessionToken = join.SessionToken,
                sessionId = join.SessionId,
                expiresAtUtc = join.ExpiresAtUtc.ToString("O"),
                ttlSeconds = join.TtlSeconds
            });
        });
    }

    private static void MapRealtimeGateway(WebApplication app)
    {
        app.Map("/ws/realtime", async (HttpContext ctx) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }

            var token = ctx.Request.Query["token"].FirstOrDefault();
            if (string.IsNullOrWhiteSpace(token))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            await using var scope = ctx.RequestServices.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SloncordDbContext>();
            var userId = await GetUserIdFromTokenAsync(db, token);
            if (userId is null)
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            var gateway = ctx.RequestServices.GetRequiredService<RealtimeGatewayServer>();
            var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            await gateway.HandleAsync(ws, userId.Value, CancellationToken.None);
        });
    }

    private static List<object> GetIceServers(IConfiguration cfg)
    {
        string[] urls =
            cfg.GetSection("Sloncord:Voice:Turn:Urls").Get<string[]>() ??
            Array.Empty<string>();

        if (urls.Length == 0)
        {
            var raw =
                cfg["SLONCORD_TURN_URLS"]
                ?? Environment.GetEnvironmentVariable("SLONCORD_TURN_URLS")
                ?? cfg["Sloncord:Voice:Turn:UrlsRaw"]
                ?? "";
            if (!string.IsNullOrWhiteSpace(raw))
            {
                urls = raw
                    .Split(new[] { ',', ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .ToArray();
            }
        }

        var username =
            cfg["Sloncord:Voice:Turn:Username"] ??
            cfg["SLONCORD_TURN_USERNAME"] ??
            Environment.GetEnvironmentVariable("SLONCORD_TURN_USERNAME") ??
            "";

        var credential =
            cfg["Sloncord:Voice:Turn:Credential"] ??
            cfg["SLONCORD_TURN_CREDENTIAL"] ??
            Environment.GetEnvironmentVariable("SLONCORD_TURN_CREDENTIAL") ??
            "";

        var servers = new List<object> { new { urls = "stun:stun.l.google.com:19302" } };
        if (urls.Length > 0 && !string.IsNullOrWhiteSpace(username) && !string.IsNullOrWhiteSpace(credential))
        {
            servers.Add(new { urls, username, credential });
        }
        return servers;
    }

    private static string CreateSfuToken(string secret, Guid userId, string roomId, DateTime expiresUtc)
    {
        var payloadObj = new
        {
            v = 1,
            userId = userId.ToString("D"),
            roomId,
            exp = expiresUtc.ToString("O")
        };
        var payloadJson = JsonSerializer.Serialize(payloadObj);
        var payload = Base64UrlEncode(Encoding.UTF8.GetBytes(payloadJson));

        using var h = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var sig = h.ComputeHash(Encoding.UTF8.GetBytes(payload));
        var sigB64 = Base64UrlEncode(sig);
        return $"{payload}.{sigB64}";
    }

    private static string Base64UrlEncode(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // ----------------- helpers & DTOs -----------------

    private static string NewSessionToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');

    private static async Task<Guid?> GetUserIdFromTokenAsync(SloncordDbContext db, string token)
    {
        var t = token.Trim();
        if (t.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) t = t[7..].Trim();
        if (t.Length < 6) return null;
        var row = await (
            from s in db.Sessions.AsNoTracking()
            join u in db.Users.AsNoTracking() on s.UserId equals u.Id
            where s.Token == t
            select new { u.Id, u.Login, u.AccountApproved }
        ).FirstOrDefaultAsync();
        if (row is null || row.Id == Guid.Empty) return null;
        if (!row.AccountApproved && !SloncordPlatformPermissions.IsPlatformRoot(row.Login)) return null;
        return row.Id;
    }

    /// <summary>
    /// Chromium/Electron часто отказываются выбирать декодер для видео, если в БД лежит generic octet-stream.
    /// Подставляем MIME по расширению для потоковой раздачи /files/{id}/content.
    /// </summary>
    private static string EffectiveStreamContentType(string? storedContentType, string? originalName)
    {
        var ext = Path.GetExtension(originalName ?? "").ToLowerInvariant();
        var st = (storedContentType ?? "").Trim();
        var generic = string.IsNullOrWhiteSpace(st)
                      || string.Equals(st, "application/octet-stream", StringComparison.OrdinalIgnoreCase)
                      || string.Equals(st, "binary/octet-stream", StringComparison.OrdinalIgnoreCase);

        static string ByExtension(string e) => e switch
        {
            ".mp4" or ".m4v" => "video/mp4",
            ".webm" => "video/webm",
            ".mov" => "video/quicktime",
            ".mkv" => "video/x-matroska",
            ".ogv" or ".ogg" => "video/ogg",
            ".avi" => "video/x-msvideo",
            ".wmv" => "video/x-ms-wmv",
            _ => ""
        };

        var hinted = ByExtension(ext);
        if (!string.IsNullOrEmpty(hinted) && generic)
            return hinted;
        if (!string.IsNullOrEmpty(hinted)
            && string.Equals(st, "application/octet-stream", StringComparison.OrdinalIgnoreCase))
            return hinted;

        return string.IsNullOrWhiteSpace(st) ? "application/octet-stream" : st;
    }

    internal static async Task<Guid?> RequireUserIdForPlatformAsync(HttpContext ctx, SloncordDbContext db)
        => await RequireUserIdAsync(ctx, db);

    private static async Task<Guid?> RequireUserIdAsync(HttpContext ctx, SloncordDbContext db)
    {
        var t = GetBearer(ctx);
        if (t is null) return null;
        var id = await GetUserIdFromTokenAsync(db, t);
        if (id is null) return null;
        await SloncordPlatformBan.TryExpireAsync(db, id.Value);
        if (await SloncordPlatformPermissions.IsPlatformBannedAsync(db, id.Value)) return null;
        await TouchSessionIpAsync(db, t, SloncordClientIp.Resolve(ctx));
        return id;
    }

    private static async Task TouchSessionIpAsync(SloncordDbContext db, string token, string? ip)
    {
        var norm = SloncordClientIp.Normalize(ip);
        if (string.IsNullOrWhiteSpace(norm)) return;

        var session = await db.Sessions.FirstOrDefaultAsync(x => x.Token == token);
        if (session is null) return;

        var now = DateTime.UtcNow;
        if (session.LastSeenAtUtc is not null && (now - session.LastSeenAtUtc.Value).TotalMinutes < 5)
            return;

        session.LastSeenIp = norm;
        session.LastSeenAtUtc = now;
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == session.UserId);
        if (user is not null)
        {
            user.LastKnownIp = norm;
            user.LastKnownIpAtUtc = now;
        }
        await db.SaveChangesAsync();
    }

    internal static async Task<bool> UserCanAccessFileAsync(
        HttpContext ctx,
        SloncordDbContext db,
        Guid userId,
        Guid fileId)
    {
        var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == fileId);
        if (f is null) return false;
        if (f.UploadedByUserId == userId) return true;

        var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
        if (await SloncordPlatformPermissions.IsPlatformModeratorAsync(config, db, userId, ctx.RequestAborted))
            return true;

        if (await db.Messages.AnyAsync(m =>
                m.FileId == fileId &&
                db.ChannelMembers.Any(cm => cm.UserId == userId && cm.ChannelId == m.ChannelId)))
            return true;

        return await db.MessageAttachments.AnyAsync(a =>
            a.FileId == fileId &&
            db.ChannelMembers.Any(cm =>
                cm.UserId == userId &&
                cm.ChannelId == db.Messages.Where(m => m.Id == a.MessageId).Select(m => m.ChannelId).FirstOrDefault()));
    }

    private static async Task<Guid?> RequireFileCallerAsync(
        HttpContext ctx, SloncordDbContext db, FileAccessTicketStore tickets, Guid fileId)
    {
        var me = await RequireUserIdAsyncFromHeaderOrQuery(ctx, db);
        if (me is not null) return me;
        if (ctx.Request.Query.TryGetValue("ft", out var ft)
            && tickets.TryAuthorize(ft.ToString(), fileId, out var ticketUser))
            return ticketUser;
        return null;
    }

    private static async Task<Guid?> RequireUserIdAsyncFromHeaderOrQuery(HttpContext ctx, SloncordDbContext db)
    {
        var t = GetBearer(ctx);
        if (!string.IsNullOrWhiteSpace(t))
        {
            var id0 = await GetUserIdFromTokenAsync(db, t);
            if (id0 is not null) return id0;
        }

        if (ctx.Request.Query.TryGetValue("access_token", out var q0))
        {
            var q = q0.ToString();
            if (!string.IsNullOrWhiteSpace(q))
            {
                var id1 = await GetUserIdFromTokenAsync(db, q);
                if (id1 is not null) return id1;
            }
        }
        return null;
    }

    private static async Task<UserEntity?> RequireUserAsync(HttpContext ctx, SloncordDbContext db)
    {
        var id = await RequireUserIdAsync(ctx, db);
        if (id is null) return null;
        return await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.Id == id.Value);
    }

    private static string? GetBearer(HttpContext ctx)
    {
        if (!ctx.Request.Headers.TryGetValue("Authorization", out var v)) return null;
        var s = v.ToString();
        if (string.IsNullOrWhiteSpace(s) || !s.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return null;
        var token = s[7..].Trim();
        return string.IsNullOrWhiteSpace(token) ? null : token;
    }

    internal static async Task<bool> IsChannelMemberAsync(SloncordDbContext db, Guid channelId, Guid userId)
    {
        if (await db.ChannelMembers.AnyAsync(m => m.ChannelId == channelId && m.UserId == userId))
            return true;

        var ch = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => new { c.ServerId, c.Kind, c.IsPrivate })
            .FirstOrDefaultAsync();
        if (ch is null || ch.ServerId is null || ch.Kind == ChannelKindEntity.Direct)
            return false;
        if (ch.IsPrivate) return false;

        return await db.ServerMembers.AnyAsync(m => m.ServerId == ch.ServerId && m.UserId == userId);
    }

    private static async Task<bool> IsMemberAsync(SloncordDbContext db, Guid channelId, Guid userId) =>
        await IsChannelMemberAsync(db, channelId, userId);

    private static bool TryParseChannelRoom(string roomId, out Guid channelId)
    {
        channelId = Guid.Empty;
        if (string.IsNullOrWhiteSpace(roomId)) return false;
        if (!roomId.StartsWith("channel:", StringComparison.OrdinalIgnoreCase)) return false;
        var s = roomId["channel:".Length..].Trim();
        return Guid.TryParse(s, out channelId);
    }

    private static bool IsLikelyImageContentType(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType)) return true;
        var ct = contentType.Trim().ToLowerInvariant();
        return ct.StartsWith("image/");
    }

    private static async Task<Guid> StoreFileFromBase64Async(
        SloncordDbContext db,
        SloncordAppState s,
        Guid uploadedByUserId,
        string fileBase64,
        string fileName,
        string? contentType)
    {
        if (fileBase64.Length > 6_000_000) throw new BadHttpRequestException("Слишком большой файл");

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(fileBase64);
        }
        catch (FormatException)
        {
            throw new BadHttpRequestException("fileBase64 некорректен");
        }

        if (bytes.Length > 2_500_000) throw new BadHttpRequestException("Слишком большой файл");

        var fileId = Guid.NewGuid();
        var storage = $"{fileId:N}.bin";
        var path = Path.Combine(s.StorageDir, storage);
        await File.WriteAllBytesAsync(path, bytes);

        var stored = new StoredFileEntity
        {
            Id = fileId,
            OriginalName = fileName.Trim(),
            ContentType = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType!,
            SizeBytes = bytes.Length,
            StorageName = storage,
            UploadedByUserId = uploadedByUserId,
            UploadedAtUtc = DateTime.UtcNow
        };
        db.Files.Add(stored);
        await db.SaveChangesAsync();
        return fileId;
    }

    private static async Task<List<ServerListItemDto>> BuildServerListDtosForUserAsync(SloncordDbContext db, Guid me)
    {
        var serverIds = await db.ServerMembers.AsNoTracking()
            .Where(m => m.UserId == me)
            .Select(m => m.ServerId)
            .ToListAsync();
        var res = new List<ServerListItemDto>();
        foreach (var sid in serverIds)
        {
            var srv = await db.Servers.AsNoTracking().FirstOrDefaultAsync(s => s.Id == sid);
            if (srv is null) continue;
            var chans = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId == sid
                    && (c.Kind == ChannelKindEntity.Public || c.Kind == ChannelKindEntity.Voice)
                    && db.ChannelMembers.Any(m => m.ChannelId == c.Id && m.UserId == me))
                .OrderBy(c => c.Position)
                .ThenBy(c => c.Name)
                .ToListAsync();
            var chDtos = new List<ChannelListItemDto>();
            foreach (var c in chans) chDtos.Add(await ToChannelListItemAsync(db, me, c.Id));
            var canMod = await SloncordServerPermissions.CanModerateServerAsync(db, sid, me);
            var cats = await db.ChannelCategories.AsNoTracking()
                .Where(c => c.ServerId == sid
                    && (!c.IsPrivate || canMod || db.CategoryMembers.Any(m => m.CategoryId == c.Id && m.UserId == me)))
                .OrderBy(c => c.Position)
                .ThenBy(c => c.Name)
                .Select(c => new CategoryListItemDto
                {
                    Id = c.Id.ToString("D"),
                    Name = c.Name,
                    Position = c.Position,
                    IsPrivate = c.IsPrivate
                })
                .ToListAsync();
            var serverUnread = chDtos.Sum(x => x.UnreadCount);
            var adminIds = await SloncordServerPermissions.GetAdminUserIdsAsync(db, sid);
            res.Add(new ServerListItemDto
            {
                Id = srv.Id.ToString("D"),
                Name = srv.Name,
                Description = srv.Description,
                OwnerUserId = srv.OwnerUserId.ToString("D"),
                AvatarFileId = srv.AvatarFileId?.ToString("D"),
                InviteCode = srv.InviteCode,
                UnreadCount = serverUnread,
                AdminUserIds = adminIds,
                Categories = cats,
                Channels = chDtos
            });
        }
        return res;
    }

    internal static async Task BroadcastServerListForUserAsync(SloncordDbContext db, SloncordRealtime r, Guid userId)
    {
        var list = await BuildServerListDtosForUserAsync(db, userId);
        try
        {
            await r.ToUserAsync(userId, SloncordHubEvents.ServerListUpdated, new { servers = list });
        }
        catch
        {
        }
    }

    internal static async Task RevokeVoiceOnlyChannelAccessAsync(SloncordDbContext db, SloncordRealtime r, Guid userId, Guid channelId)
    {
        var cm = await db.ChannelMembers.FirstOrDefaultAsync(m =>
            m.ChannelId == channelId && m.UserId == userId && m.IsVoiceOnly);
        if (cm is null) return;
        db.ChannelMembers.Remove(cm);
        await db.SaveChangesAsync();
        await BroadcastServerListForUserAsync(db, r, userId);
    }

    private static async Task RevokeVoiceOnlyAccessForUserOnServerAsync(
        SloncordDbContext db, SloncordRealtime r, Guid serverId, Guid userId)
    {
        var channelIds = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId && c.Kind == ChannelKindEntity.Voice && c.IsPrivate)
            .Select(c => c.Id)
            .ToListAsync();
        var removed = false;
        foreach (var chId in channelIds)
        {
            var cm = await db.ChannelMembers.FirstOrDefaultAsync(m =>
                m.ChannelId == chId && m.UserId == userId && m.IsVoiceOnly);
            if (cm is null) continue;
            db.ChannelMembers.Remove(cm);
            removed = true;
        }
        if (!removed) return;
        await db.SaveChangesAsync();
        await BroadcastServerListForUserAsync(db, r, userId);
    }

    private static async Task BroadcastAllServerMemberListsAsync(SloncordDbContext db, SloncordRealtime r, Guid serverId)
    {
        var users = await db.ServerMembers.AsNoTracking()
            .Where(m => m.ServerId == serverId)
            .Select(m => m.UserId)
            .ToListAsync();
        foreach (var u in users) await BroadcastServerListForUserAsync(db, r, u);
    }

    private static async Task RemoveUserFromServerAsync(SloncordDbContext db, SloncordAppState app, Guid serverId, Guid userId)
    {
        var sm = await db.ServerMembers.FirstOrDefaultAsync(x => x.ServerId == serverId && x.UserId == userId);
        if (sm is not null) db.ServerMembers.Remove(sm);

        var channelIds = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId)
            .Select(c => c.Id)
            .ToListAsync();
        db.ChannelMembers.RemoveRange(db.ChannelMembers.Where(m => channelIds.Contains(m.ChannelId) && m.UserId == userId));
        db.ChannelReadStates.RemoveRange(db.ChannelReadStates.Where(x => channelIds.Contains(x.ChannelId) && x.UserId == userId));

        var roomIds = await db.Channels.AsNoTracking()
            .Where(c => c.ServerId == serverId && c.Kind == ChannelKindEntity.Voice)
            .Select(c => $"channel:{c.Id:D}")
            .ToListAsync();
        app.Voice.ForceDisconnectUser(userId, roomIds);
    }

    /// <summary>Finds 1:1 direct channel. Implemented without correlated Count() in a single query — that pattern fails to translate to SQL on some Npgsql+EF versions.</summary>
    private static async Task<Guid?> FindDirectChannelAsync(SloncordDbContext db, Guid a, Guid b, CancellationToken ct = default)
    {
        var aCh = await db.ChannelMembers.AsNoTracking()
            .Where(m => m.UserId == a)
            .Select(m => m.ChannelId)
            .ToListAsync(ct);
        foreach (var chId in aCh)
        {
            if (!await db.Channels.AsNoTracking()
                    .AnyAsync(c => c.Id == chId && c.Kind == ChannelKindEntity.Direct, ct))
                continue;
            if (await db.ChannelMembers.CountAsync(m => m.ChannelId == chId, ct) != 2) continue;
            if (!await db.ChannelMembers.AnyAsync(m => m.ChannelId == chId && m.UserId == b, ct)) continue;
            return chId;
        }
        return null;
    }

    private sealed class ChannelListItemDto
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        [JsonPropertyName("ownerUserId")]
        public string OwnerUserId { get; set; } = string.Empty;
        [JsonPropertyName("avatarFileId")]
        public string? AvatarFileId { get; set; }
        [JsonPropertyName("unreadCount")]
        public int UnreadCount { get; set; }
        [JsonPropertyName("lastMessageAtUtc")]
        public string? LastMessageAtUtc { get; set; }
        public string Kind { get; set; } = "public";
        [JsonPropertyName("serverId")]
        public string? ServerId { get; set; }
        [JsonPropertyName("memberUserIds")]
        public List<Guid> MemberUserIds { get; set; } = new();
        [JsonPropertyName("categoryId")]
        public string? CategoryId { get; set; }
        [JsonPropertyName("position")]
        public int Position { get; set; }
        [JsonPropertyName("isPrivate")]
        public bool IsPrivate { get; set; }
    }

    private sealed class CategoryListItemDto
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public int Position { get; set; }
        [JsonPropertyName("isPrivate")]
        public bool IsPrivate { get; set; }
    }

    private sealed class ServerListItemDto
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string Description { get; set; } = string.Empty;
        [JsonPropertyName("ownerUserId")]
        public string OwnerUserId { get; set; } = string.Empty;
        [JsonPropertyName("avatarFileId")]
        public string? AvatarFileId { get; set; }
        public string InviteCode { get; set; } = string.Empty;
        [JsonPropertyName("unreadCount")]
        public int UnreadCount { get; set; }
        [JsonPropertyName("adminUserIds")]
        public List<string> AdminUserIds { get; set; } = new();
        public List<CategoryListItemDto> Categories { get; set; } = new();
        public List<ChannelListItemDto> Channels { get; set; } = new();
    }

    private static async Task<ChannelListItemDto> ToChannelListItemAsync(
        SloncordDbContext db, Guid me, Guid channelId)
    {
        var c = await db.Channels
            .AsNoTracking()
            .Include(x => x.Members)
            .FirstOrDefaultAsync(x => x.Id == channelId);
        if (c is null) throw new InvalidOperationException("Channel missing");
        if (c.Members is null || c.Members.All(m => m.UserId != me)) throw new InvalidOperationException("not a member");

        var memberIds = c.Members.Select(m => m.UserId).ToList();
        var unread = await SloncordQueries.UnreadCountAsync(db, me, c.Id);
        var lastAt = await db.Messages.AsNoTracking()
            .Where(m => m.ChannelId == c.Id && !m.IsDeleted)
            .OrderByDescending(m => m.CreatedAtUtc)
            .Select(m => m.CreatedAtUtc)
            .FirstOrDefaultAsync();
        var lastAtStr = lastAt == default ? null : lastAt.ToString("O");
        if (c.Kind == ChannelKindEntity.Public)
        {
            return new ChannelListItemDto
            {
                Id = c.Id.ToString("D"),
                Name = c.Name,
                OwnerUserId = c.OwnerUserId.ToString("D"),
                AvatarFileId = c.AvatarFileId?.ToString("D"),
                UnreadCount = unread,
                LastMessageAtUtc = lastAtStr,
                Kind = "public",
                ServerId = c.ServerId?.ToString("D"),
                MemberUserIds = memberIds,
                CategoryId = c.CategoryId?.ToString("D"),
                Position = c.Position,
                IsPrivate = c.IsPrivate
            };
        }

        if (c.Kind == ChannelKindEntity.Voice)
        {
            return new ChannelListItemDto
            {
                Id = c.Id.ToString("D"),
                Name = c.Name,
                OwnerUserId = c.OwnerUserId.ToString("D"),
                AvatarFileId = c.AvatarFileId?.ToString("D"),
                UnreadCount = unread,
                LastMessageAtUtc = lastAtStr,
                Kind = "voice",
                ServerId = c.ServerId?.ToString("D"),
                MemberUserIds = memberIds,
                CategoryId = c.CategoryId?.ToString("D"),
                Position = c.Position,
                IsPrivate = c.IsPrivate
            };
        }

        // DM: name for viewer is the other user nickname
        var otherId = memberIds.FirstOrDefault(x => x != me);
        var otherNick = c.Name;
        if (otherId != Guid.Empty)
        {
            var n = await db.Users.AsNoTracking().Where(x => x.Id == otherId).Select(x => x.Nickname).FirstOrDefaultAsync();
            if (!string.IsNullOrWhiteSpace(n)) otherNick = n!;
        }

        return new ChannelListItemDto
        {
            Id = c.Id.ToString("D"),
            Name = otherNick,
            OwnerUserId = c.OwnerUserId.ToString("D"),
            AvatarFileId = c.AvatarFileId?.ToString("D"),
            UnreadCount = unread,
            LastMessageAtUtc = lastAtStr,
            Kind = "dm",
            MemberUserIds = memberIds
        };
    }

    private static async Task MarkReadAsync(SloncordDbContext db, SloncordRealtime r, Guid userId, Guid channelId)
    {
        var clearedUpTo = await SloncordQueries.GetDmClearedUpToUtcAsync(db, userId, channelId);
        var last = await db.Messages.AsNoTracking()
            .Where(m => m.ChannelId == channelId && !m.IsDeleted)
            .Where(m => clearedUpTo == null || m.CreatedAtUtc > clearedUpTo.Value)
            .OrderByDescending(m => m.CreatedAtUtc)
            .Select(m => m.Id)
            .FirstOrDefaultAsync();

        var st = await db.ChannelReadStates.FirstOrDefaultAsync(x => x.UserId == userId && x.ChannelId == channelId);
        if (st is null)
        {
            st = new ChannelReadStateEntity { UserId = userId, ChannelId = channelId, UpdatedAtUtc = DateTime.UtcNow };
            db.ChannelReadStates.Add(st);
        }

        st.LastReadMessageId = last == default ? null : last;
        st.UpdatedAtUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();

        var n = await SloncordQueries.UnreadCountAsync(db, userId, channelId);
        try
        {
            await r.ToUserAsync(userId, SloncordHubEvents.UnreadChanged, new { channelId = channelId.ToString("D"), unread = n });
            await BroadcastServerListForUserAsync(db, r, userId);
        }
        catch
        {
        }
    }

    private static async Task BroadcastChannelListAsync(
        SloncordDbContext db, SloncordRealtime r, Guid userId, bool isDm)
    {
        if (!isDm)
        {
            await BroadcastServerListForUserAsync(db, r, userId);
            return;
        }

        var list = await SloncordQueries.DirectChannelsForUser(db, userId).OrderBy(c => c.CreatedAtUtc).ToListAsync();
        var dtos = new List<ChannelListItemDto>();
        foreach (var c in list) dtos.Add(await ToChannelListItemAsync(db, userId, c.Id));
        dtos = dtos
            .OrderByDescending(x => DateTime.TryParse(x.LastMessageAtUtc, out var d) ? d : DateTime.MinValue)
            .ToList();
        try
        {
            await r.ToUserAsync(userId, SloncordHubEvents.ChannelListUpdated, new { kind = "dm", channels = dtos });
        }
        catch
        {
        }
    }

    private static async Task BroadcastChannelListForUsersAsync(
        SloncordDbContext db, SloncordRealtime r, Guid channelId, Guid u1, Guid u2, bool isDm)
    {
        // Ensure both users are still members, then send fresh lists
        if (await IsMemberAsync(db, channelId, u1)) await BroadcastChannelListAsync(db, r, u1, isDm: isDm);
        if (await IsMemberAsync(db, channelId, u2)) await BroadcastChannelListAsync(db, r, u2, isDm: isDm);
    }

    private static async Task<object> ToMessageDtoAsync(SloncordDbContext db, MessageEntity m)
    {
        var sender = await db.Users.AsNoTracking()
            .Where(u => u.Id == m.SenderUserId)
            .Select(u => new { u.Nickname, u.AvatarFileId, u.Login, u.IsPlatformModerator })
            .FirstOrDefaultAsync();
        var senderNick = sender?.Nickname;
        var senderAvatar = sender?.AvatarFileId;
        var senderIsRoot = sender is not null && SloncordPlatformPermissions.IsPlatformRoot(sender.Login);
        var senderIsMod = sender is not null && !senderIsRoot && sender.IsPlatformModerator;
        if (string.IsNullOrEmpty(senderNick)) senderNick = "удалён";
        // Legacy single attachment (file) is kept for backwards compatibility.
        object? file = null;
        if (m.FileId is not null)
        {
            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == m.FileId);
            if (f is not null)
            {
                file = new
                {
                    id = f.Id.ToString("D"),
                    f.OriginalName
                };
            }
        }

        var attachments = new List<object>();
        try
        {
            var list = await db.MessageAttachments
                .AsNoTracking()
                .Where(a => a.MessageId == m.Id)
                .OrderBy(a => a.Order)
                .Select(a => a.FileId)
                .ToListAsync();

            if (list.Count > 0)
            {
                // Defensive: if duplicates exist in DB (race/bug), do not surface them in DTO.
                var seenAttach = new HashSet<Guid>();
                var uniq = new List<Guid>();
                foreach (var fid in list)
                {
                    if (fid == Guid.Empty) continue;
                    if (!seenAttach.Add(fid)) continue;
                    uniq.Add(fid);
                }

                var files = await db.Files.AsNoTracking()
                    .Where(f => uniq.Contains(f.Id))
                    .ToListAsync();

                var byId = files.ToDictionary(x => x.Id, x => x);
                foreach (var fid in uniq)
                {
                    if (!byId.TryGetValue(fid, out var f)) continue;
                    attachments.Add(new
                    {
                        id = f.Id.ToString("D"),
                        originalName = f.OriginalName,
                        contentType = f.ContentType,
                        sizeBytes = f.SizeBytes
                    });
                }
            }
        }
        catch
        {
            // best-effort
        }

        // If there are no normalized attachments yet, but legacy FileId is set, expose it as a single attachment too.
        if (attachments.Count == 0 && m.FileId is not null && file is not null)
        {
            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == m.FileId);
            if (f is not null)
            {
                attachments.Add(new
                {
                    id = f.Id.ToString("D"),
                    originalName = f.OriginalName,
                    contentType = f.ContentType,
                    sizeBytes = f.SizeBytes
                });
            }
        }

        object? replyTo = null;
        if (m.ReplyToMessageId is not null)
        {
            try
            {
                var rm = await db.Messages.AsNoTracking()
                    .FirstOrDefaultAsync(x => x.Id == m.ReplyToMessageId.Value && x.ChannelId == m.ChannelId);
                if (rm is not null)
                {
                    var rs = await db.Users.AsNoTracking()
                        .Where(u => u.Id == rm.SenderUserId)
                        .Select(u => new { u.Nickname })
                        .FirstOrDefaultAsync();
                    var rsNick = string.IsNullOrWhiteSpace(rs?.Nickname) ? "удалён" : rs!.Nickname;

                    // very small preview for the replied message
                    var rmText = rm.IsDeleted ? "" : (rm.Text ?? "");
                    if (rmText.Length > 140) rmText = rmText[..140];

                    object? firstAttachment = null;
                    try
                    {
                        var fid = await db.MessageAttachments.AsNoTracking()
                            .Where(a => a.MessageId == rm.Id)
                            .OrderBy(a => a.Order)
                            .Select(a => a.FileId)
                            .FirstOrDefaultAsync();
                        if (fid != Guid.Empty)
                        {
                            var f = await db.Files.AsNoTracking().FirstOrDefaultAsync(x => x.Id == fid);
                            if (f is not null)
                            {
                                firstAttachment = new
                                {
                                    id = f.Id.ToString("D"),
                                    originalName = f.OriginalName,
                                    contentType = f.ContentType,
                                    sizeBytes = f.SizeBytes
                                };
                            }
                        }
                    }
                    catch
                    {
                    }

                    replyTo = new
                    {
                        id = rm.Id.ToString("D"),
                        senderUserId = rm.SenderUserId.ToString("D"),
                        senderNickname = rsNick,
                        text = rmText,
                        isDeleted = rm.IsDeleted,
                        createdAtUtc = rm.CreatedAtUtc,
                        firstAttachment
                    };
                }
            }
            catch
            {
            }
        }
        return new
        {
            id = m.Id.ToString("D"),
            channelId = m.ChannelId.ToString("D"),
            text = m.Text,
            createdAtUtc = m.CreatedAtUtc,
            editedAtUtc = m.EditedAtUtc,
            replyToMessageId = m.ReplyToMessageId?.ToString("D"),
            replyTo,
            senderUserId = m.SenderUserId.ToString("D"),
            senderNickname = senderNick,
            senderAvatarFileId = senderAvatar?.ToString("D"),
            senderIsPlatformRoot = senderIsRoot,
            senderIsPlatformModerator = senderIsMod,
            isDeleted = m.IsDeleted,
            file,
            attachments
        };
    }

    private static async Task<object> CreateMessageInChannelAsync(
        HttpContext ctx, SloncordDbContext db, SloncordAppState s, Guid me, Guid channelId, NewMessageRequest req)
    {
        var msg = new MessageEntity
        {
            Id = Guid.NewGuid(),
            ChannelId = channelId,
            SenderUserId = me,
            Text = req.Text?.Trim() ?? string.Empty,
            CreatedAtUtc = DateTime.UtcNow,
            IsDeleted = false
        };

        // Reply-to message (optional)
        if (!string.IsNullOrWhiteSpace(req.ReplyToMessageId)
            && Guid.TryParse(req.ReplyToMessageId, out var replyId))
        {
            // Must be in same channel and visible to member. (Membership is already checked by caller.)
            var exists = await db.Messages.AsNoTracking()
                .AnyAsync(x => x.Id == replyId && x.ChannelId == channelId);
            if (exists) msg.ReplyToMessageId = replyId;
        }

        // Base64-uploaded file ids (created in this request).
        var normalizedAttachmentFileIds = new List<Guid>();
        // Client-provided attachment ids (from chunked uploads), keep order as sent.
        var clientAttachmentFileIds = new List<Guid>();
        if (req.AttachmentFileIds is not null && req.AttachmentFileIds.Count > 0)
        {
            foreach (var raw in req.AttachmentFileIds)
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                if (Guid.TryParse(raw.Trim(), out var id) && id != Guid.Empty)
                    clientAttachmentFileIds.Add(id);
            }
        }
        // Validate combined attachment count (base64 + chunked) early.
        if (clientAttachmentFileIds.Count > 10)
            throw new BadHttpRequestException("В одном сообщении может быть не более 10 вложений");

        // Multiple files upload (base64) in one message (legacy-friendly, limited by client).
        if (req.Files is not null && req.Files.Count > 0)
        {
            if (req.Files.Count > 10) throw new BadHttpRequestException("В одном сообщении может быть не более 10 вложений");
            foreach (var part in req.Files)
            {
                if (part is null) continue;
                if (string.IsNullOrWhiteSpace(part.FileBase64)) continue;
                if (string.IsNullOrWhiteSpace(part.FileName)) throw new BadHttpRequestException("fileName обязателен");

                byte[] bytes;
                try
                {
                    bytes = Convert.FromBase64String(part.FileBase64);
                }
                catch (FormatException)
                {
                    throw new BadHttpRequestException("Некорректный fileBase64");
                }
                if (bytes.Length == 0) throw new BadHttpRequestException("Пустой файл");

                var fileId = Guid.NewGuid();
                var ext = Path.GetExtension(part.FileName);
                if (ext.Length > 8) ext = string.Empty;
                var storage = $"{fileId:N}{ext}";
                var full = Path.Combine(s.StorageDir, storage);
                Directory.CreateDirectory(s.StorageDir);
                await File.WriteAllBytesAsync(full, bytes);

                var stored = new StoredFileEntity
                {
                    Id = fileId,
                    OriginalName = part.FileName,
                    ContentType = string.IsNullOrWhiteSpace(part.ContentType) ? "application/octet-stream" : part.ContentType!,
                    SizeBytes = bytes.Length,
                    StorageName = storage,
                    UploadedByUserId = me,
                    UploadedAtUtc = DateTime.UtcNow
                };
                db.Files.Add(stored);
                normalizedAttachmentFileIds.Add(fileId);
            }
        }

        // After base64 files were normalized into ids, validate combined count.
        if (normalizedAttachmentFileIds.Count + clientAttachmentFileIds.Count > 10)
            throw new BadHttpRequestException("В одном сообщении может быть не более 10 вложений");

        if (!string.IsNullOrWhiteSpace(req.FileBase64))
        {
            if (string.IsNullOrWhiteSpace(req.FileName)) throw new BadHttpRequestException("fileName обязателен");

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(req.FileBase64);
            }
            catch (FormatException)
            {
                throw new BadHttpRequestException("Некорректный fileBase64");
            }
            if (bytes.Length == 0) throw new BadHttpRequestException("Пустой файл");

            var fileId = Guid.NewGuid();
            var ext = Path.GetExtension(req.FileName);
            if (ext.Length > 8) ext = string.Empty;
            var storage = $"{fileId:N}{ext}";
            var full = Path.Combine(s.StorageDir, storage);
            Directory.CreateDirectory(s.StorageDir);
            await File.WriteAllBytesAsync(full, bytes);

            var stored = new StoredFileEntity
            {
                Id = fileId,
                OriginalName = req.FileName,
                ContentType = string.IsNullOrWhiteSpace(req.ContentType) ? "application/octet-stream" : req.ContentType!,
                SizeBytes = bytes.Length,
                StorageName = storage,
                UploadedByUserId = me,
                UploadedAtUtc = DateTime.UtcNow
            };
            db.Files.Add(stored);
            msg.FileId = fileId;
            normalizedAttachmentFileIds.Add(fileId);
        }

        db.Messages.Add(msg);

        // Attachments:
        // - normalizedAttachmentFileIds were created in THIS request (base64 upload) and are tracked in this DbContext,
        //   so they are safe to attach without querying the DB (querying would miss unsaved entities).
        // - clientAttachmentFileIds come from chunked uploads and must exist in DB and belong to the sender.
        if (normalizedAttachmentFileIds.Count > 0 || clientAttachmentFileIds.Count > 0)
        {
            var canSet = new HashSet<Guid>(normalizedAttachmentFileIds);
            if (clientAttachmentFileIds.Count > 0)
            {
                var uniqClient = clientAttachmentFileIds.Distinct().ToList();
                var canUseClient = await db.Files.AsNoTracking()
                    .Where(f => uniqClient.Contains(f.Id) && f.UploadedByUserId == me)
                    .Select(f => f.Id)
                    .ToListAsync();
                foreach (var id in canUseClient) canSet.Add(id);
            }

            var order = 0;
            // Keep message order as the client sent it.
            var seen = new HashSet<Guid>();
            foreach (var fid in normalizedAttachmentFileIds)
            {
                if (!canSet.Contains(fid)) continue;
                if (!seen.Add(fid)) continue;
                db.MessageAttachments.Add(new MessageAttachmentEntity
                {
                    MessageId = msg.Id,
                    FileId = fid,
                    Order = order++
                });
            }
            foreach (var fid in clientAttachmentFileIds)
            {
                if (!canSet.Contains(fid)) continue;
                if (!seen.Add(fid)) continue;
                db.MessageAttachments.Add(new MessageAttachmentEntity
                {
                    MessageId = msg.Id,
                    FileId = fid,
                    Order = order++
                });
            }
        }

        var hasFile = msg.FileId is not null || normalizedAttachmentFileIds.Count > 0 || clientAttachmentFileIds.Count > 0;
        await SloncordUserActivity.LogMessageSendAsync(db, me, channelId, msg.Text, hasFile, SloncordClientIp.Resolve(ctx));

        await db.SaveChangesAsync();

        var dto = await ToMessageDtoAsync(db, msg);

        var senderNick = await db.Users.AsNoTracking()
            .Where(u => u.Id == me)
            .Select(u => u.Nickname)
            .FirstAsync();
        var preview = string.IsNullOrWhiteSpace(msg.Text) ? "📎 Файл" : msg.Text;
        var chKind = await db.Channels.AsNoTracking()
            .Where(c => c.Id == channelId)
            .Select(c => new { c.Kind, c.Name, c.ServerId })
            .FirstOrDefaultAsync();
        var kind = chKind?.Kind == ChannelKindEntity.Direct ? "dm" : "channel";
        var open = $"{kind}:{channelId:D}";

        var members = await db.ChannelMembers.AsNoTracking()
            .Where(m => m.ChannelId == channelId && m.UserId != me)
            .Select(m => m.UserId)
            .ToListAsync();

        // Realtime is best-effort — a hub/serialization error must not 500 a persisted message
        try
        {
            await s.Realtime.ToChannelAsync(channelId, SloncordHubEvents.MessageCreated, new { channelId = channelId.ToString("D"), message = dto });

            foreach (var u in members)
            {
                var n = await SloncordQueries.UnreadCountAsync(db, u, channelId);
                await s.Realtime.ToUserAsync(u, SloncordHubEvents.UnreadChanged, new { channelId = channelId.ToString("D"), unread = n });
                await BroadcastServerListForUserAsync(db, s.Realtime, u);
            }
        }
        catch
        {
        }

        // Push: await so this request's DbContext is not used after the scope is disposed
        foreach (var u in members)
        {
            try
            {
                string title;
                string body;
                object data;
                if (kind == "dm")
                {
                    title = $"От {senderNick}";
                    body = $"ЛС: {preview}";
                    data = new { kind, channelId = channelId.ToString("D"), url = $"/?open={open}" };
                }
                else
                {
                    var channelName = chKind?.Name ?? "канал";
                    string serverName = "Sloncord";
                    string? serverId = chKind?.ServerId?.ToString("D");
                    if (chKind?.ServerId is not null)
                    {
                        try
                        {
                            serverName = await db.Servers.AsNoTracking()
                                .Where(srv => srv.Id == chKind.ServerId.Value)
                                .Select(srv => srv.Name)
                                .FirstOrDefaultAsync(ctx.RequestAborted) ?? serverName;
                        }
                        catch
                        {
                            // ignore
                        }
                    }
                    title = $"{serverName} • #{channelName}";
                    body = $"{senderNick}: {preview}";
                    data = new { kind, channelId = channelId.ToString("D"), serverId, serverName, channelName, url = $"/?open={open}" };
                }
                await s.Push.NotifyUserAsync(
                    db,
                    u,
                    title,
                    body,
                    data,
                    ctx.RequestAborted);
            }
            catch
            {
                // best-effort
            }
        }

        return dto;
    }

    private sealed record RegisterRequest(string Login, string Password, string Nickname);
    private sealed record LoginRequest(string Login, string Password);
    private sealed record ProfileUpdateRequest(string Nickname, string? Bio);
    private sealed record PushSubscribeRequest(string Endpoint, string P256dh, string Auth);
    private sealed record CreateServerRequest(string Name, string? Description);
    private sealed record ServerUpdateRequest(string Name, string? Description);
    private sealed record ChannelUpdateNameRequest(string Name);
    private sealed record JoinServerRequest(string InviteCode);
    private sealed record CreateChannelRequest(string Name, string? Type, string? CategoryId, bool? IsPrivate);
    private sealed record CreateCategoryRequest(string Name, bool? IsPrivate);
    private sealed record CategoryPrivacyRequest(bool? IsPrivate);
    private sealed record MoveVoiceRequest(string ChannelId);
    private sealed record ServerLayoutRequest(
        List<ServerLayoutCategoryItem>? Categories,
        List<ServerLayoutChannelItem>? Channels);
    private sealed record ServerLayoutCategoryItem(string Id, int Position, string? Name);
    private sealed record ServerLayoutChannelItem(string Id, int Position, string? CategoryId);
    private sealed record ChannelMemberRequest(string UserId);
    private sealed record InviteRequest(string Nickname);
    private sealed record StartDmByUserRequest(string UserId);
    private sealed record DmCallStartRequest(string CallId);
    private sealed record DmCallRespondRequest(string CallId, string Action, string ToUserId);
    private sealed record DmCallCancelRequest(string CallId);
    private sealed record NewMessageRequest(
        string? Text,
        string? FileBase64,
        string? FileName,
        string? ContentType,
        string? ReplyToMessageId,
        List<string>? AttachmentFileIds,
        List<UploadedFilePart>? Files);

    private sealed record UploadedFilePart(string FileBase64, string FileName, string? ContentType);
    private sealed record EditMessageRequest(string? Text, List<string>? RemoveAttachmentFileIds);
    private sealed record DeleteDmConversationRequest(bool? DeleteForPeer);
    private sealed record AvatarUploadRequest(string FileBase64, string FileName, string? ContentType);
    private sealed record SfuTokenRequest(string RoomId);
    private sealed record PasswordChangeRequest(string CurrentPassword, string NewPassword);
    private sealed record SetServerAdminRequest(bool IsAdmin);
    private sealed record UploadInitRequest(string FileName, long TotalBytes, string? ContentType);

    private sealed record ProfileDto
    {
        public static object FromUser(
            UserEntity u,
            bool? online = null,
            bool includeChatMute = false,
            IConfiguration? config = null)
        {
            var (isRoot, isMod, isTeam) = SloncordPlatformPermissions.GetPublicTeamFlags(u, config);
            if (includeChatMute && SloncordChatMute.IsActive(u))
            {
                return new
                {
                    id = u.Id.ToString("D"),
                    login = u.Login,
                    nickname = u.Nickname,
                    bio = u.Bio,
                    avatarFileId = u.AvatarFileId?.ToString("D"),
                    online,
                    lastSeenAtUtc = u.LastSeenAtUtc?.ToString("O"),
                    isPlatformRoot = isRoot,
                    isPlatformModerator = isMod,
                    isSloncordTeam = isTeam,
                    chatMuted = true,
                    chatMuteReason = u.ChatMuteReason ?? "",
                    chatMutedUntilUtc = u.ChatMutedUntilUtc!.Value.ToString("O")
                };
            }

            return new
            {
                id = u.Id.ToString("D"),
                login = u.Login,
                nickname = u.Nickname,
                bio = u.Bio,
                avatarFileId = u.AvatarFileId?.ToString("D"),
                online,
                lastSeenAtUtc = u.LastSeenAtUtc?.ToString("O"),
                isPlatformRoot = isRoot,
                isPlatformModerator = isMod,
                isSloncordTeam = isTeam
            };
        }
    }
}
