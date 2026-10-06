using Microsoft.EntityFrameworkCore;
using Sloncord.Data;
using Sloncord.Hubs;

namespace Sloncord;

internal static class SloncordPlatformEndpoints
{
    public static void Map(WebApplication app, SloncordAppState s)
    {
        app.MapGet("/platform/access", async (HttpContext ctx, SloncordDbContext db) =>
        {
            var (me, deny) = await RequireAccessOrDenyAsync(ctx, db);
            if (deny is not null) return deny;
            return Results.Ok(new { ok = true, userId = me!.Value.ToString("D") });
        });

        app.MapGet("/platform/me", async (HttpContext ctx, SloncordDbContext db) =>
        {
            var (me, deny) = await RequireAccessOrDenyAsync(ctx, db);
            if (deny is not null) return deny;

            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var u = await db.Users.AsNoTracking().FirstAsync(x => x.Id == me!.Value);
            var perms = await SloncordPlatformPermissions.GetEffectivePermissionsAsync(config, db, me.Value);
            var isRoot = SloncordPlatformPermissions.IsPlatformRoot(u.Login);
            return Results.Ok(new
            {
                userId = u.Id.ToString("D"),
                login = u.Login,
                nickname = u.Nickname,
                isRoot,
                isPlatformModerator = u.IsPlatformModerator || isRoot,
                permissions = SloncordPlatformModeratorPerms.ToKeys(perms),
                permissionDefs = SloncordPlatformModeratorPerms.DescribeAll()
            });
        });

        app.MapGet("/platform/users", async (HttpContext ctx, SloncordDbContext db, string? q, string? role, int? skip, int? take) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewUsers);
            if (modDeny is not null) return modDeny;

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 50, 1, 200);
            var query = db.Users.AsNoTracking().AsQueryable();
            var roleNorm = (role ?? "users").Trim().ToLowerInvariant();
            if (roleNorm is "moderators" or "moderator")
                query = query.Where(u => u.IsPlatformModerator);
            else if (roleNorm is "users" or "user")
                query = query.Where(u => !u.IsPlatformModerator);

            var term = (q ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(term))
            {
                var t = term.ToLowerInvariant();
                query = query.Where(u =>
                    u.Login.ToLower().Contains(t)
                    || u.Nickname.ToLower().Contains(t));
            }

            var total = await query.CountAsync();
            var users = await query
                .OrderByDescending(u => u.CreatedAtUtc)
                .Skip(offset)
                .Take(limit)
                .ToListAsync();

            var ids = users.Select(u => u.Id).ToList();
            var serverCounts = await db.ServerMembers.AsNoTracking()
                .Where(m => ids.Contains(m.UserId))
                .GroupBy(m => m.UserId)
                .Select(g => new { UserId = g.Key, Count = g.Count() })
                .ToDictionaryAsync(x => x.UserId, x => x.Count);

            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                items = users.Select(u => PlatformUserSummary(u, serverCounts.GetValueOrDefault(u.Id))).ToList()
            });
        });

        app.MapGet("/platform/users/{userId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid userId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewUsers);
            if (modDeny is not null) return modDeny;

            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var canViewIps = await SloncordPlatformPermissions.HasPermissionAsync(
                config, db, actor!.Value, PlatformModeratorPerm.ViewUserIps);

            var u = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });

            var memberships = await (
                from m in db.ServerMembers.AsNoTracking()
                join srv in db.Servers.AsNoTracking() on m.ServerId equals srv.Id
                where m.UserId == userId
                orderby srv.Name
                select new
                {
                    serverId = srv.Id.ToString("D"),
                    serverName = srv.Name,
                    isOwner = srv.OwnerUserId == userId,
                    isAdmin = m.IsAdmin,
                    joinedAtUtc = m.JoinedAtUtc.ToString("O")
                }).ToListAsync();

            var sessionCount = await db.Sessions.AsNoTracking().CountAsync(x => x.UserId == userId);

            object? ipInfo = null;
            if (canViewIps)
            {
                var sessionRows = await db.Sessions.AsNoTracking()
                    .Where(x => x.UserId == userId)
                    .OrderByDescending(x => x.LastSeenAtUtc ?? x.CreatedAtUtc)
                    .Take(10)
                    .ToListAsync();
                var recentSessions = sessionRows.Select(x => new
                {
                    id = x.Id.ToString("D"),
                    createdAtUtc = x.CreatedAtUtc.ToString("O"),
                    createdFromIp = x.CreatedFromIp,
                    lastSeenIp = x.LastSeenIp,
                    lastSeenAtUtc = x.LastSeenAtUtc?.ToString("O")
                }).ToList();
                ipInfo = new
                {
                    lastKnownIp = u.LastKnownIp,
                    lastKnownIpAtUtc = u.LastKnownIpAtUtc?.ToString("O"),
                    sessions = recentSessions
                };
            }

            return Results.Ok(new
            {
                user = PlatformUserSummary(u, memberships.Count),
                memberships,
                sessionCount,
                ip = ipInfo
            });
        });

        app.MapGet("/platform/users/{userId:guid}/activity", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid userId,
            int? skip,
            int? take,
            string? sort,
            string? sortBy,
            string? action) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewUserActivity);
            if (modDeny is not null) return modDeny;

            if (!await db.Users.AsNoTracking().AnyAsync(x => x.Id == userId))
                return Results.NotFound(new { error = "Пользователь не найден" });

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 50, 1, 500);
            var sortDir = string.Equals(sort, "asc", StringComparison.OrdinalIgnoreCase) ? "asc" : "desc";
            var sortField = string.Equals(sortBy, "action", StringComparison.OrdinalIgnoreCase) ? "action" : "time";
            var actionFilter = (action ?? "").Trim();

            IQueryable<UserActivityLogEntity> query = db.UserActivityLogs.AsNoTracking().Where(x => x.UserId == userId);
            if (!string.IsNullOrWhiteSpace(actionFilter))
                query = query.Where(x => x.Action == actionFilter);

            var total = await query.CountAsync();
            query = sortField == "action"
                ? (sortDir == "asc"
                    ? query.OrderBy(x => x.Action).ThenByDescending(x => x.CreatedAtUtc)
                    : query.OrderByDescending(x => x.Action).ThenByDescending(x => x.CreatedAtUtc))
                : (sortDir == "asc"
                    ? query.OrderBy(x => x.CreatedAtUtc)
                    : query.OrderByDescending(x => x.CreatedAtUtc));

            var items = await query.Skip(offset).Take(limit).ToListAsync();

            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                items = items.Select(x => new
                {
                    id = x.Id.ToString("D"),
                    action = x.Action,
                    actionLabel = SloncordUserActivity.FormatActionLabel(x.Action),
                    details = x.Details,
                    detailsLabel = SloncordUserActivity.FormatDetailsLabel(x.Action, x.Details),
                    ipAddress = x.IpAddress,
                    createdAtUtc = x.CreatedAtUtc.ToString("O")
                }).ToList()
            });
        });

        app.MapDelete("/platform/users/{userId:guid}/activity", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid userId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ClearUserActivity);
            if (modDeny is not null) return modDeny;

            var u = await db.Users.AsNoTracking()
                .Where(x => x.Id == userId)
                .Select(x => new { x.Id, x.Nickname })
                .FirstOrDefaultAsync();
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });

            var removed = await db.UserActivityLogs.Where(x => x.UserId == userId).ExecuteDeleteAsync();
            await LogAsync(db, actor!.Value, "user.activity.clear", "user", userId.ToString("D"), $"count={removed}");
            await db.SaveChangesAsync();

            return Results.Ok(new { ok = true, removed });
        });

        app.MapDelete("/platform/user-activity", async (
            HttpContext ctx,
            SloncordDbContext db) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ClearUserActivity);
            if (modDeny is not null) return modDeny;

            var removed = await db.UserActivityLogs.ExecuteDeleteAsync();
            await LogAsync(db, actor!.Value, "user.activity.clear_all", "system", "all", $"count={removed}");
            await db.SaveChangesAsync();

            return Results.Ok(new { ok = true, removed });
        });

        app.MapPost("/platform/users/{userId:guid}/ban", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid userId,
            PlatformBanRequest? req) =>
        {
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.BanUsers);
            if (modDeny is not null) return modDeny;
            if (actor!.Value == userId) return Results.BadRequest(new { error = "Нельзя заблокировать себя" });

            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });
            if (SloncordPlatformPermissions.IsPlatformRoot(u.Login))
                return Results.BadRequest(new { error = "Нельзя заблокировать root" });
            if (await SloncordPlatformPermissions.HasModeratorPrivilegesAsync(config, db, userId))
                return Results.BadRequest(new { error = "Нельзя заблокировать модератора платформы" });

            var reason = (req?.Reason ?? "").Trim();
            var durationMinutes = req?.DurationMinutes;
            var permanent = durationMinutes is null or <= 0;
            if (permanent && !await SloncordPlatformPermissions.HasPermissionAsync(config, db, actor.Value, PlatformModeratorPerm.PermanentBan))
                return Results.Json(new { error = "Нет права на вечную блокировку" }, statusCode: StatusCodes.Status403Forbidden);

            SloncordPlatformBan.Apply(u, actor.Value, reason, durationMinutes);

            var sessions = await db.Sessions.Where(x => x.UserId == userId).ToListAsync();
            db.Sessions.RemoveRange(sessions);

            await LogAsync(db, actor.Value, "user.ban", "user", userId.ToString("D"),
                durationMinutes is > 0 ? $"until={u.PlatformBannedUntilUtc:O};minutes={durationMinutes};reason={reason}" : $"permanent;reason={reason}");
            await db.SaveChangesAsync();
            await SloncordPlatformBan.NotifyBannedAsync(s, userId, reason, u.PlatformBannedUntilUtc);

            return Results.Ok(new
            {
                ok = true,
                platformBanReason = reason,
                platformBannedUntilUtc = u.PlatformBannedUntilUtc?.ToString("O"),
                platformBanPermanent = u.PlatformBannedUntilUtc is null
            });
        });

        app.MapDelete("/platform/users/{userId:guid}/ban", async (HttpContext ctx, SloncordDbContext db, Guid userId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.BanUsers);
            if (modDeny is not null) return modDeny;

            var rootDeny = await SloncordPlatformPermissions.ShouldDenyModeratorActionOnRootAsync(db, actor!.Value, userId);
            if (rootDeny.Deny) return Results.Json(new { error = rootDeny.Error }, statusCode: StatusCodes.Status403Forbidden);

            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });

            SloncordPlatformBan.Clear(u);

            await LogAsync(db, actor.Value, "user.unban", "user", userId.ToString("D"), "");
            await db.SaveChangesAsync();

            return Results.Ok(new { ok = true });
        });

        app.MapPost("/platform/users/{userId:guid}/chat-mute", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid userId,
            PlatformChatMuteRequest? req) =>
        {
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.MuteChat);
            if (modDeny is not null) return modDeny;
            if (actor!.Value == userId) return Results.BadRequest(new { error = "Нельзя заблокировать чат себе" });

            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });
            if (SloncordPlatformPermissions.IsPlatformRoot(u.Login))
                return Results.BadRequest(new { error = "Нельзя заблокировать чат root" });
            if (await SloncordPlatformPermissions.HasModeratorPrivilegesAsync(config, db, userId))
                return Results.BadRequest(new { error = "Нельзя заблокировать чат модератору платформы" });

            var minutes = Math.Clamp(req?.DurationMinutes ?? 0, 1, 525_600);
            var reason = (req?.Reason ?? "").Trim();
            if (string.IsNullOrWhiteSpace(reason))
                return Results.BadRequest(new { error = "Укажите причину блокировки чата" });

            var until = DateTime.UtcNow.AddMinutes(minutes);
            SloncordChatMute.Apply(u, actor.Value, reason, until);

            await LogAsync(db, actor.Value, "user.chat_mute", "user", userId.ToString("D"),
                $"until={until:O};minutes={minutes};reason={reason}");
            await db.SaveChangesAsync();
            await SloncordChatMute.NotifyChangedAsync(s, userId, muted: true, reason, until);

            return Results.Ok(new
            {
                ok = true,
                chatMutedUntilUtc = until.ToString("O"),
                chatMuteReason = reason
            });
        });

        app.MapDelete("/platform/users/{userId:guid}/chat-mute", async (HttpContext ctx, SloncordDbContext db, Guid userId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.MuteChat);
            if (modDeny is not null) return modDeny;

            var rootDeny = await SloncordPlatformPermissions.ShouldDenyModeratorActionOnRootAsync(db, actor!.Value, userId);
            if (rootDeny.Deny) return Results.Json(new { error = rootDeny.Error }, statusCode: StatusCodes.Status403Forbidden);

            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });

            SloncordChatMute.Clear(u);
            await LogAsync(db, actor.Value, "user.chat_unmute", "user", userId.ToString("D"), "");
            await db.SaveChangesAsync();
            await SloncordChatMute.NotifyChangedAsync(s, userId, muted: false);

            return Results.Ok(new { ok = true });
        });

        app.MapDelete("/platform/users/{userId:guid}/sessions", async (HttpContext ctx, SloncordDbContext db, Guid userId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.RevokeSessions);
            if (modDeny is not null) return modDeny;

            var rootDeny = await SloncordPlatformPermissions.ShouldDenyModeratorActionOnRootAsync(db, actor!.Value, userId);
            if (rootDeny.Deny) return Results.Json(new { error = rootDeny.Error }, statusCode: StatusCodes.Status403Forbidden);

            var sessions = await db.Sessions.Where(x => x.UserId == userId).ToListAsync();
            db.Sessions.RemoveRange(sessions);
            await LogAsync(db, actor.Value, "user.sessions.revoke", "user", userId.ToString("D"), $"count={sessions.Count}");
            await db.SaveChangesAsync();
            await SloncordSessions.NotifyRevokedAsync(s, userId);

            return Results.Ok(new { ok = true, revoked = sessions.Count });
        });

        app.MapPut("/platform/moderators/{userId:guid}", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid userId,
            PlatformModeratorUpdateRequest? req) =>
        {
            var (actor, rootDeny) = await RequireRootOrDenyAsync(ctx, db);
            if (rootDeny is not null) return rootDeny;

            var u = await db.Users.FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });
            if (SloncordPlatformPermissions.IsPlatformRoot(u.Login))
                return Results.BadRequest(new { error = "Нельзя изменить права root" });

            var teamFlagsChanged = false;
            if (req?.Revoke == true)
            {
                if (!u.IsPlatformModerator)
                    return Results.Ok(new { ok = true, isPlatformModerator = false, permissions = Array.Empty<string>() });
                u.IsPlatformModerator = false;
                u.PlatformModeratorPermissions = 0;
                teamFlagsChanged = true;
                await LogAsync(db, actor!.Value, "moderator.revoke", "user", userId.ToString("D"), "");
            }
            else
            {
                var wasModerator = u.IsPlatformModerator;
                u.IsPlatformModerator = true;
                if (req?.Permissions is not null)
                    u.PlatformModeratorPermissions = SloncordPlatformModeratorPerms.FromKeys(req.Permissions);
                teamFlagsChanged = !wasModerator;
                await LogAsync(db, actor!.Value, wasModerator ? "moderator.permissions" : "moderator.grant", "user",
                    userId.ToString("D"),
                    string.Join(",", SloncordPlatformModeratorPerms.ToKeys(u.PlatformModeratorPermissions)));
            }

            await db.SaveChangesAsync();
            if (teamFlagsChanged)
            {
                var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
                try
                {
                    await SloncordPlatformPermissions.BroadcastTeamFlagsChangedAsync(s.Realtime, config, u);
                }
                catch
                {
                    // best-effort
                }
            }
            return Results.Ok(new
            {
                ok = true,
                isPlatformModerator = u.IsPlatformModerator,
                permissions = SloncordPlatformModeratorPerms.ToKeys(u.PlatformModeratorPermissions)
            });
        });

        app.MapGet("/platform/servers", async (HttpContext ctx, SloncordDbContext db, string? q, int? skip, int? take) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewServers);
            if (modDeny is not null) return modDeny;

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 50, 1, 200);
            var query = db.Servers.AsNoTracking().AsQueryable();
            var term = (q ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(term))
            {
                var t = term.ToLowerInvariant();
                query = query.Where(s =>
                    s.Name.ToLower().Contains(t)
                    || s.InviteCode.ToLower().Contains(t));
            }

            var total = await query.CountAsync();
            var servers = await query
                .OrderByDescending(s => s.CreatedAtUtc)
                .Skip(offset)
                .Take(limit)
                .ToListAsync();

            var ids = servers.Select(s => s.Id).ToList();
            var channelCounts = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId != null && ids.Contains(c.ServerId.Value))
                .GroupBy(c => c.ServerId!.Value)
                .Select(g => new { ServerId = g.Key, Count = g.Count() })
                .ToDictionaryAsync(x => x.ServerId, x => x.Count);
            var memberCounts = await db.ServerMembers.AsNoTracking()
                .Where(m => ids.Contains(m.ServerId))
                .GroupBy(m => m.ServerId)
                .Select(g => new { ServerId = g.Key, Count = g.Count() })
                .ToDictionaryAsync(x => x.ServerId, x => x.Count);

            var ownerIds = servers.Select(s => s.OwnerUserId).Distinct().ToList();
            var owners = await db.Users.AsNoTracking()
                .Where(u => ownerIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.Nickname);

            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                items = servers.Select(s => new
                {
                    id = s.Id.ToString("D"),
                    name = s.Name,
                    description = s.Description,
                    inviteCode = s.InviteCode,
                    ownerUserId = s.OwnerUserId.ToString("D"),
                    ownerNickname = owners.GetValueOrDefault(s.OwnerUserId, "?"),
                    channelCount = channelCounts.GetValueOrDefault(s.Id),
                    memberCount = memberCounts.GetValueOrDefault(s.Id),
                    createdAtUtc = s.CreatedAtUtc.ToString("O")
                }).ToList()
            });
        });

        app.MapGet("/platform/servers/{serverId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid serverId) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewServers);
            if (modDeny is not null) return modDeny;

            var srv = await db.Servers.AsNoTracking().FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound(new { error = "Сервер не найден" });

            var owner = await db.Users.AsNoTracking()
                .Where(u => u.Id == srv.OwnerUserId)
                .Select(u => new { u.Nickname, u.Login })
                .FirstOrDefaultAsync();

            var channels = await db.Channels.AsNoTracking()
                .Where(c => c.ServerId == serverId)
                .OrderBy(c => c.Name)
                .Select(c => new
                {
                    id = c.Id.ToString("D"),
                    name = c.Name,
                    kind = c.Kind.ToString().ToLowerInvariant(),
                    ownerUserId = c.OwnerUserId.ToString("D"),
                    createdAtUtc = c.CreatedAtUtc.ToString("O")
                })
                .ToListAsync();

            var members = await (
                from m in db.ServerMembers.AsNoTracking()
                join u in db.Users.AsNoTracking() on m.UserId equals u.Id
                where m.ServerId == serverId
                orderby u.Nickname
                select new
                {
                    userId = u.Id.ToString("D"),
                    login = u.Login,
                    nickname = u.Nickname,
                    isAdmin = m.IsAdmin,
                    isOwner = srv.OwnerUserId == u.Id,
                    joinedAtUtc = m.JoinedAtUtc.ToString("O"),
                    isPlatformBanned = u.IsPlatformBanned
                }).ToListAsync();

            return Results.Ok(new
            {
                server = new
                {
                    id = srv.Id.ToString("D"),
                    name = srv.Name,
                    description = srv.Description,
                    inviteCode = srv.InviteCode,
                    ownerUserId = srv.OwnerUserId.ToString("D"),
                    ownerNickname = owner?.Nickname ?? "?",
                    ownerLogin = owner?.Login ?? "?",
                    createdAtUtc = srv.CreatedAtUtc.ToString("O")
                },
                channels,
                members
            });
        });

        app.MapDelete("/platform/servers/{serverId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid serverId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.DeleteServers);
            if (modDeny is not null) return modDeny;

            var srv = await db.Servers.FirstOrDefaultAsync(x => x.Id == serverId);
            if (srv is null) return Results.NotFound(new { error = "Сервер не найден" });

            var users = await db.ServerMembers.AsNoTracking()
                .Where(m => m.ServerId == serverId)
                .Select(m => m.UserId)
                .ToListAsync();

            db.Servers.Remove(srv);
            await LogAsync(db, actor.Value, "server.delete", "server", serverId.ToString("D"), srv.Name);
            await db.SaveChangesAsync();

            foreach (var u in users.Distinct())
            {
                try
                {
                    await SloncordEndpoints.BroadcastServerListForUserAsync(db, s.Realtime, u);
                }
                catch
                {
                    // best-effort
                }
            }

            return Results.Ok(new { ok = true });
        });

        app.MapGet("/platform/channels", async (
            HttpContext ctx,
            SloncordDbContext db,
            string? q,
            Guid? serverId,
            string? kind,
            int? skip,
            int? take) =>
        {
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewChats);
            if (modDeny is not null) return modDeny;

            var canViewDms = await SloncordPlatformPermissions.HasPermissionAsync(
                config, db, actor!.Value, PlatformModeratorPerm.ViewDms);

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 100, 1, 500);
            var query =
                from ch in db.Channels.AsNoTracking()
                join srv in db.Servers.AsNoTracking() on ch.ServerId equals srv.Id into srvJoin
                from srv in srvJoin.DefaultIfEmpty()
                where ch.Kind != ChannelKindEntity.Voice
                select new { ch, srv };

            if (serverId is not null)
                query = query.Where(x => x.ch.ServerId == serverId);

            var kindNorm = (kind ?? "").Trim().ToLowerInvariant();
            if (kindNorm == "dm" || kindNorm == "direct")
            {
                if (!canViewDms)
                    return Results.Json(new { error = "Нет права на просмотр личных сообщений" }, statusCode: StatusCodes.Status403Forbidden);
                query = query.Where(x => x.ch.Kind == ChannelKindEntity.Direct);
            }
            else if (kindNorm == "text" || kindNorm == "public")
                query = query.Where(x => x.ch.Kind == ChannelKindEntity.Public);
            else if (!canViewDms)
                query = query.Where(x => x.ch.Kind != ChannelKindEntity.Direct);

            var term = (q ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(term))
            {
                var t = term.ToLowerInvariant();
                query = query.Where(x =>
                    x.ch.Name.ToLower().Contains(t)
                    || (x.srv != null && x.srv.Name.ToLower().Contains(t)));
            }

            var total = await query.CountAsync();
            var rows = await query
                .OrderBy(x => x.srv != null ? x.srv.Name : "zzz")
                .ThenBy(x => x.ch.Name)
                .Skip(offset)
                .Take(limit)
                .ToListAsync();

            var dmIds = rows.Where(x => x.ch.Kind == ChannelKindEntity.Direct).Select(x => x.ch.Id).ToList();
            var dmNames = await ResolveDirectChannelDisplayNamesAsync(db, dmIds);

            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                items = rows.Select(x => new
                {
                    id = x.ch.Id.ToString("D"),
                    name = x.ch.Kind == ChannelKindEntity.Direct
                        ? dmNames.GetValueOrDefault(x.ch.Id, x.ch.Name)
                        : x.ch.Name,
                    kind = x.ch.Kind.ToString().ToLowerInvariant(),
                    serverId = x.ch.ServerId?.ToString("D"),
                    serverName = x.srv?.Name,
                    createdAtUtc = x.ch.CreatedAtUtc.ToString("O")
                }).ToList()
            });
        });

        app.MapGet("/platform/reports", async (
            HttpContext ctx,
            SloncordDbContext db,
            string? status,
            int? skip,
            int? take) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewReports);
            if (modDeny is not null) return modDeny;

            try
            {
                var offset = Math.Max(0, skip ?? 0);
                var limit = Math.Clamp(take ?? 50, 1, 200);
                var st = (status ?? "pending").Trim().ToLowerInvariant();
                var query = db.MessageReports.AsNoTracking().AsQueryable();
                if (st != "all" && st != "")
                    query = query.Where(r => r.Status == st);

                var total = await query.CountAsync();
                var reports = await query
                    .OrderByDescending(r => r.CreatedAtUtc)
                    .Skip(offset)
                    .Take(limit)
                    .ToListAsync();

                return Results.Ok(new
                {
                    total,
                    skip = offset,
                    take = limit,
                    items = await BuildReportSummariesAsync(db, reports)
                });
            }
            catch (Exception ex)
            {
                return Results.Json(
                    new { error = "Не удалось загрузить жалобы. Убедитесь, что сервер обновлён и перезапущен (таблица MessageReports).", detail = ex.Message },
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        app.MapGet("/platform/reports/{reportId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid reportId) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewReports);
            if (modDeny is not null) return modDeny;

            var report = await db.MessageReports.AsNoTracking().FirstOrDefaultAsync(r => r.Id == reportId);
            if (report is null) return Results.NotFound(new { error = "Жалоба не найдена" });

            var items = await BuildReportSummariesAsync(db, new List<MessageReportEntity> { report });
            return Results.Ok(items.FirstOrDefault());
        });

        app.MapPost("/platform/reports/{reportId:guid}/resolve", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid reportId,
            PlatformResolveReportRequest? req) =>
        {
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewReports);
            if (modDeny is not null) return modDeny;

            var report = await db.MessageReports.FirstOrDefaultAsync(r => r.Id == reportId);
            if (report is null) return Results.NotFound(new { error = "Жалоба не найдена" });
            if (report.Status != "pending")
                return Results.BadRequest(new { error = "Жалоба уже обработана" });

            var nextStatus = (req?.Status ?? "resolved").Trim().ToLowerInvariant();
            if (nextStatus is not ("resolved" or "dismissed"))
                return Results.BadRequest(new { error = "status: resolved или dismissed" });

            if (req?.DeleteMessage == true
                && !await SloncordPlatformPermissions.HasPermissionAsync(config, db, actor!.Value, PlatformModeratorPerm.DeleteMessages))
                return Results.Json(new { error = "Нет права на удаление сообщений" }, statusCode: StatusCodes.Status403Forbidden);
            if (req?.BanUser == true
                && !await SloncordPlatformPermissions.HasPermissionAsync(config, db, actor!.Value, PlatformModeratorPerm.BanUsers))
                return Results.Json(new { error = "Нет права на блокировку аккаунта" }, statusCode: StatusCodes.Status403Forbidden);
            if (req?.BanUser == true)
            {
                var banDur = req?.BanDurationMinutes;
                var permanent = banDur is null or <= 0;
                if (permanent && !await SloncordPlatformPermissions.HasPermissionAsync(config, db, actor!.Value, PlatformModeratorPerm.PermanentBan))
                    return Results.Json(new { error = "Нет права на вечную блокировку" }, statusCode: StatusCodes.Status403Forbidden);
            }
            if (req?.MuteChat == true
                && !await SloncordPlatformPermissions.HasPermissionAsync(config, db, actor!.Value, PlatformModeratorPerm.MuteChat))
                return Results.Json(new { error = "Нет права на блокировку чата" }, statusCode: StatusCodes.Status403Forbidden);

            if (req?.DeleteMessage == true || req?.BanUser == true || req?.MuteChat == true)
            {
                var rootDeny = await SloncordPlatformPermissions.ShouldDenyModeratorActionOnRootMessageAsync(
                    db, actor!.Value, report.MessageId);
                if (rootDeny.Deny)
                    return Results.Json(new { error = rootDeny.Error }, statusCode: StatusCodes.Status403Forbidden);
            }

            report.Status = nextStatus;
            report.ResolvedByUserId = actor;
            report.ResolvedAtUtc = DateTime.UtcNow;
            report.ModeratorNote = (req?.Note ?? "").Trim();

            if (req?.DeleteMessage == true)
            {
                var msg = await db.Messages.FirstOrDefaultAsync(m => m.Id == report.MessageId);
                if (msg is not null && !msg.IsDeleted)
                {
                    msg.IsDeleted = true;
                    msg.EditedAtUtc = DateTime.UtcNow;
                    try
                    {
                        await s.Realtime.ToChannelAsync(msg.ChannelId, SloncordHubEvents.MessageDeleted, new
                        {
                            channelId = msg.ChannelId.ToString("D"),
                            messageId = msg.Id.ToString("D")
                        });
                    }
                    catch { /* ignore */ }
                }
            }

            Guid? bannedNotifyUserId = null;
            string? bannedNotifyReason = null;
            DateTime? bannedNotifyUntil = null;
            if (req?.BanUser == true)
            {
                var msg = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == report.MessageId);
                var targetUserId = msg?.SenderUserId ?? Guid.Empty;
                if (targetUserId != Guid.Empty && targetUserId != actor.Value)
                {
                    var u = await db.Users.FirstOrDefaultAsync(x => x.Id == targetUserId);
                    if (u is not null
                        && !SloncordPlatformPermissions.IsPlatformRoot(u.Login)
                        && !await SloncordPlatformPermissions.HasModeratorPrivilegesAsync(config, db, targetUserId))
                    {
                        var banReason = (req?.BanReason ?? report.Reason ?? "").Trim();
                        SloncordPlatformBan.Apply(u, actor!.Value, banReason, req?.BanDurationMinutes);
                        var sessions = await db.Sessions.Where(x => x.UserId == targetUserId).ToListAsync();
                        db.Sessions.RemoveRange(sessions);
                        bannedNotifyUserId = targetUserId;
                        bannedNotifyReason = banReason;
                        bannedNotifyUntil = u.PlatformBannedUntilUtc;
                    }
                }
            }

            Guid? muteNotifyUserId = null;
            string? muteNotifyReason = null;
            DateTime? muteNotifyUntil = null;
            if (req?.MuteChat == true)
            {
                var msg = await db.Messages.AsNoTracking().FirstOrDefaultAsync(m => m.Id == report.MessageId);
                var targetUserId = msg?.SenderUserId ?? Guid.Empty;
                if (targetUserId != Guid.Empty && targetUserId != actor.Value)
                {
                    var u = await db.Users.FirstOrDefaultAsync(x => x.Id == targetUserId);
                    if (u is not null
                        && !SloncordPlatformPermissions.IsPlatformRoot(u.Login)
                        && !await SloncordPlatformPermissions.HasModeratorPrivilegesAsync(config, db, targetUserId))
                    {
                        var minutes = Math.Clamp(req?.ChatMuteDurationMinutes ?? 1440, 1, 525_600);
                        var muteReason = (req?.ChatMuteReason ?? report.Reason ?? "").Trim();
                        if (string.IsNullOrWhiteSpace(muteReason))
                            muteReason = "Нарушение правил";
                        muteNotifyUntil = DateTime.UtcNow.AddMinutes(minutes);
                        SloncordChatMute.Apply(u, actor.Value, muteReason, muteNotifyUntil.Value);
                        muteNotifyUserId = targetUserId;
                        muteNotifyReason = muteReason;
                    }
                }
            }

            await LogAsync(db, actor.Value, "report." + nextStatus, "report", reportId.ToString("D"), report.ModeratorNote);
            await db.SaveChangesAsync();

            if (bannedNotifyUserId is not null)
                await SloncordPlatformBan.NotifyBannedAsync(s, bannedNotifyUserId.Value, bannedNotifyReason ?? "", bannedNotifyUntil);
            if (muteNotifyUserId is not null)
                await SloncordChatMute.NotifyChangedAsync(s, muteNotifyUserId.Value, muted: true, muteNotifyReason, muteNotifyUntil);

            await SloncordPlatformReports.NotifyChangedAsync(s, db);

            return Results.Ok(new { ok = true });
        });

        app.MapGet("/platform/channels/{channelId:guid}/messages", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid channelId,
            int? limit,
            int? skip,
            string? sort,
            string? before,
            Guid? beforeId) =>
        {
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewChats);
            if (modDeny is not null) return modDeny;

            var ch = await db.Channels.AsNoTracking().FirstOrDefaultAsync(c => c.Id == channelId);
            if (ch is null) return Results.NotFound(new { error = "Канал не найден" });
            if (ch.Kind == ChannelKindEntity.Direct
                && !await SloncordPlatformPermissions.HasPermissionAsync(config, db, actor!.Value, PlatformModeratorPerm.ViewDms))
                return Results.Json(new { error = "Нет права на просмотр личных сообщений" }, statusCode: StatusCodes.Status403Forbidden);

            var take = Math.Clamp(limit ?? 50, 1, 500);
            var offset = Math.Max(0, skip ?? 0);
            var orderAsc = string.Equals(sort, "asc", StringComparison.OrdinalIgnoreCase);
            var baseQ = db.Messages.AsNoTracking().Where(m => m.ChannelId == channelId);
            var total = await baseQ.CountAsync();

            List<MessageEntity> list;
            var hasMore = false;

            if (beforeId is not null && beforeId != Guid.Empty && skip is null)
            {
                var q = baseQ;
                var pivot = await db.Messages.AsNoTracking()
                    .Where(m => m.Id == beforeId && m.ChannelId == channelId)
                    .Select(m => new { m.CreatedAtUtc, m.Id })
                    .FirstOrDefaultAsync();
                if (pivot is not null)
                {
                    q = q.Where(m =>
                        m.CreatedAtUtc < pivot.CreatedAtUtc
                        || (m.CreatedAtUtc == pivot.CreatedAtUtc && m.Id.CompareTo(pivot.Id) < 0));
                }
                else if (!string.IsNullOrWhiteSpace(before) && DateTime.TryParse(before, out var beforeDt))
                {
                    q = q.Where(m => m.CreatedAtUtc < beforeDt);
                }

                list = await q
                    .OrderByDescending(m => m.CreatedAtUtc)
                    .ThenByDescending(m => m.Id)
                    .Take(take)
                    .ToListAsync();
                hasMore = list.Count >= take;
                list.Reverse();
            }
            else
            {
                if (orderAsc)
                {
                    list = await baseQ
                        .OrderBy(m => m.CreatedAtUtc)
                        .ThenBy(m => m.Id)
                        .Skip(offset)
                        .Take(take)
                        .ToListAsync();
                }
                else
                {
                    list = await baseQ
                        .OrderByDescending(m => m.CreatedAtUtc)
                        .ThenByDescending(m => m.Id)
                        .Skip(offset)
                        .Take(take)
                        .ToListAsync();
                }
                hasMore = offset + list.Count < total;
            }

            var dtos = await PlatformMessageDtosAsync(db, list, ch);
            var channelDisplayName = await ResolveChannelDisplayNameAsync(db, ch);
            var totalPages = take > 0 ? (int)Math.Ceiling(total / (double)take) : 0;
            return Results.Ok(new
            {
                channelId = channelId.ToString("D"),
                channelName = channelDisplayName,
                channelKind = ch.Kind.ToString().ToLowerInvariant(),
                serverId = ch.ServerId?.ToString("D"),
                messages = dtos,
                total,
                skip = offset,
                take,
                sort = orderAsc ? "asc" : "desc",
                page = take > 0 ? offset / take + 1 : 1,
                totalPages,
                hasMore
            });
        });

        app.MapGet("/platform/messages/search", async (
            HttpContext ctx,
            SloncordDbContext db,
            string? q,
            int? limit) =>
        {
            var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.SearchMessages);
            if (modDeny is not null) return modDeny;

            var canViewDms = await SloncordPlatformPermissions.HasPermissionAsync(
                config, db, actor!.Value, PlatformModeratorPerm.ViewDms);

            var term = (q ?? "").Trim();
            if (term.Length < 2) return Results.BadRequest(new { error = "Минимум 2 символа для поиска" });

            var take = Math.Clamp(limit ?? 50, 1, 200);
            var pattern = $"%{term}%";

            var rows = await (
                from m in db.Messages.AsNoTracking()
                join ch in db.Channels.AsNoTracking() on m.ChannelId equals ch.Id
                join u in db.Users.AsNoTracking() on m.SenderUserId equals u.Id
                where !m.IsDeleted && EF.Functions.ILike(m.Text, pattern)
                    && (canViewDms || ch.Kind != ChannelKindEntity.Direct)
                orderby m.CreatedAtUtc descending
                select new { m, ch, u }
            ).Take(take).ToListAsync();

            var serverIds = rows
                .Where(x => x.ch.ServerId != null)
                .Select(x => x.ch.ServerId!.Value)
                .Distinct()
                .ToList();
            var servers = serverIds.Count > 0
                ? await db.Servers.AsNoTracking()
                    .Where(s => serverIds.Contains(s.Id))
                    .ToDictionaryAsync(s => s.Id, s => s.Name)
                : new Dictionary<Guid, string>();

            var dmIds = rows.Where(x => x.ch.Kind == ChannelKindEntity.Direct).Select(x => x.ch.Id).Distinct().ToList();
            var dmNames = await ResolveDirectChannelDisplayNamesAsync(db, dmIds);

            return Results.Ok(rows.Select(x => new
            {
                id = x.m.Id.ToString("D"),
                channelId = x.m.ChannelId.ToString("D"),
                channelName = x.ch.Kind == ChannelKindEntity.Direct
                    ? dmNames.GetValueOrDefault(x.ch.Id, x.ch.Name)
                    : x.ch.Name,
                channelKind = x.ch.Kind.ToString().ToLowerInvariant(),
                serverId = x.ch.ServerId?.ToString("D"),
                serverName = x.ch.ServerId is not null ? servers.GetValueOrDefault(x.ch.ServerId.Value) : null,
                senderUserId = x.m.SenderUserId.ToString("D"),
                senderNickname = x.u.Nickname,
                senderIsPlatformRoot = SloncordPlatformPermissions.IsPlatformRoot(x.u.Login),
                text = x.m.Text,
                isDeleted = x.m.IsDeleted,
                createdAtUtc = x.m.CreatedAtUtc.ToString("O")
            }).ToList());
        });

        app.MapDelete("/platform/messages/{messageId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid messageId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.DeleteMessages);
            if (modDeny is not null) return modDeny;

            var rootDeny = await SloncordPlatformPermissions.ShouldDenyModeratorActionOnRootMessageAsync(
                db, actor!.Value, messageId);
            if (rootDeny.Deny) return Results.Json(new { error = rootDeny.Error }, statusCode: StatusCodes.Status403Forbidden);

            var m = await db.Messages.FirstOrDefaultAsync(x => x.Id == messageId);
            if (m is null) return Results.NotFound(new { error = "Сообщение не найдено" });
            if (m.IsDeleted) return Results.Ok(new { ok = true });

            m.IsDeleted = true;
            m.EditedAtUtc = DateTime.UtcNow;
            await LogAsync(db, actor.Value, "message.delete", "message", messageId.ToString("D"), m.ChannelId.ToString("D"));
            await db.SaveChangesAsync();

            try
            {
                await s.Realtime.ToChannelAsync(m.ChannelId, SloncordHubEvents.MessageDeleted, new
                {
                    channelId = m.ChannelId.ToString("D"),
                    messageId = messageId.ToString("D")
                });
            }
            catch
            {
                // best-effort
            }

            return Results.Ok(new { ok = true });
        });

        app.MapGet("/platform/audit", async (
            HttpContext ctx,
            SloncordDbContext db,
            int? skip,
            int? take,
            string? sort,
            string? sortBy) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewAudit);
            if (modDeny is not null) return modDeny;

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 100, 1, 500);
            var ascending = string.Equals(sort?.Trim(), "asc", StringComparison.OrdinalIgnoreCase);
            var sortField = (sortBy ?? "time").Trim().ToLowerInvariant();

            var query = db.PlatformModerationLogs.AsNoTracking();
            var total = await query.CountAsync();

            IOrderedQueryable<PlatformModerationLogEntity> ordered = sortField switch
            {
                "action" => ascending
                    ? query.OrderBy(x => x.Action)
                    : query.OrderByDescending(x => x.Action),
                "actor" => ascending
                    ? query.OrderBy(x => db.Users.Where(u => u.Id == x.ActorUserId).Select(u => u.Nickname).FirstOrDefault())
                    : query.OrderByDescending(x => db.Users.Where(u => u.Id == x.ActorUserId).Select(u => u.Nickname).FirstOrDefault()),
                "target" => ascending
                    ? query.OrderBy(x => x.TargetType).ThenBy(x => x.TargetId)
                    : query.OrderByDescending(x => x.TargetType).ThenByDescending(x => x.TargetId),
                _ => ascending
                    ? query.OrderBy(x => x.CreatedAtUtc)
                    : query.OrderByDescending(x => x.CreatedAtUtc),
            };

            var logs = await ordered.Skip(offset).Take(limit).ToListAsync();

            var actorIds = logs.Select(x => x.ActorUserId).Distinct().ToList();
            var actors = await db.Users.AsNoTracking()
                .Where(u => actorIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, u => u.Nickname);

            var targetLabels = await SloncordPlatformAudit.ResolveTargetLabelsAsync(db, logs);

            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                sort = ascending ? "asc" : "desc",
                sortBy = sortField,
                items = logs.Select(x =>
                {
                    var targetKey = $"{x.TargetType}:{x.TargetId}";
                    var targetLabel = targetLabels.GetValueOrDefault(targetKey)
                        ?? SloncordPlatformAudit.FallbackTargetLabel(x.TargetType, x.TargetId);
                    return new
                    {
                        id = x.Id.ToString("D"),
                        actorUserId = x.ActorUserId.ToString("D"),
                        actorNickname = actors.GetValueOrDefault(x.ActorUserId, "?"),
                        action = x.Action,
                        actionLabel = SloncordPlatformAudit.FormatActionLabel(x.Action),
                        targetType = x.TargetType,
                        targetId = x.TargetId,
                        targetLabel,
                        details = x.Details,
                        detailsLabel = SloncordPlatformAudit.FormatDetailsLabel(x.Action, x.Details),
                        createdAtUtc = x.CreatedAtUtc.ToString("O")
                    };
                }).ToList()
            });
        });

        app.MapGet("/platform/server-logs", async (
            HttpContext ctx,
            SloncordDbContext db,
            SloncordServerLogStore logs,
            int? skip,
            int? take,
            string? level,
            string? q) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.ViewServerLogs);
            if (modDeny is not null) return modDeny;

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 100, 1, 500);
            var (items, total) = logs.Query(offset, limit, level, q);
            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                items = items.Select(x => new
                {
                    createdAtUtc = x.CreatedAtUtc.ToString("O"),
                    level = x.Level,
                    category = x.Category,
                    message = x.Message,
                    exception = x.Exception
                }).ToList()
            });
        });

        app.MapGet("/platform/ip-bans", async (HttpContext ctx, SloncordDbContext db, int? skip, int? take) =>
        {
            var (_, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.BanIps);
            if (modDeny is not null) return modDeny;

            var offset = Math.Max(0, skip ?? 0);
            var limit = Math.Clamp(take ?? 50, 1, 200);
            var query = db.PlatformIpBans.AsNoTracking();
            var total = await query.CountAsync();
            var items = await query
                .OrderByDescending(x => x.BannedAtUtc)
                .Skip(offset)
                .Take(limit)
                .ToListAsync();

            return Results.Ok(new
            {
                total,
                skip = offset,
                take = limit,
                items = items.Select(x => new
                {
                    id = x.Id.ToString("D"),
                    ipAddress = x.IpAddress,
                    reason = x.Reason,
                    bannedAtUtc = x.BannedAtUtc.ToString("O"),
                    bannedUntilUtc = x.BannedUntilUtc?.ToString("O"),
                    permanent = x.BannedUntilUtc is null,
                    active = SloncordPlatformIpBan.IsActive(x)
                }).ToList()
            });
        });

        app.MapPost("/platform/ip-bans", async (
            HttpContext ctx,
            SloncordDbContext db,
            PlatformIpBanRequest? req) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.BanIps);
            if (modDeny is not null) return modDeny;

            var ip = SloncordClientIp.Normalize(req?.IpAddress);
            if (string.IsNullOrWhiteSpace(ip))
                return Results.BadRequest(new { error = "Укажите IP-адрес" });

            var durationMinutes = req?.DurationMinutes;
            if (durationMinutes is null or <= 0)
            {
                var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
                if (!await SloncordPlatformPermissions.HasPermissionAsync(
                        config, db, actor!.Value, PlatformModeratorPerm.PermanentBan))
                    return Results.Json(new { error = "Нет права на вечную блокировку IP" }, statusCode: StatusCodes.Status403Forbidden);
            }

            var ban = new PlatformIpBanEntity { Id = Guid.NewGuid() };
            SloncordPlatformIpBan.Apply(ban, ip, actor!.Value, req?.Reason ?? "", durationMinutes);
            db.PlatformIpBans.Add(ban);
            await LogAsync(db, actor.Value, "ip.ban", "ip", ip,
                durationMinutes is > 0 ? $"until={ban.BannedUntilUtc:O};minutes={durationMinutes}" : "permanent");
            await db.SaveChangesAsync();

            return Results.Ok(new
            {
                ok = true,
                id = ban.Id.ToString("D"),
                ipAddress = ban.IpAddress,
                bannedUntilUtc = ban.BannedUntilUtc?.ToString("O"),
                permanent = ban.BannedUntilUtc is null
            });
        });

        app.MapPost("/platform/users/{userId:guid}/ban-ip", async (
            HttpContext ctx,
            SloncordDbContext db,
            Guid userId,
            PlatformIpBanRequest? req) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.BanIps);
            if (modDeny is not null) return modDeny;

            var rootDeny = await SloncordPlatformPermissions.ShouldDenyModeratorActionOnRootAsync(db, actor!.Value, userId);
            if (rootDeny.Deny) return Results.Json(new { error = rootDeny.Error }, statusCode: StatusCodes.Status403Forbidden);

            var u = await db.Users.AsNoTracking().FirstOrDefaultAsync(x => x.Id == userId);
            if (u is null) return Results.NotFound(new { error = "Пользователь не найден" });

            var ip = SloncordClientIp.Normalize(u.LastKnownIp);
            if (string.IsNullOrWhiteSpace(ip))
                return Results.BadRequest(new { error = "IP пользователя неизвестен" });

            var durationMinutes = req?.DurationMinutes;
            if (durationMinutes is null or <= 0)
            {
                var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
                if (!await SloncordPlatformPermissions.HasPermissionAsync(
                        config, db, actor.Value, PlatformModeratorPerm.PermanentBan))
                    return Results.Json(new { error = "Нет права на вечную блокировку IP" }, statusCode: StatusCodes.Status403Forbidden);
            }

            var ban = new PlatformIpBanEntity { Id = Guid.NewGuid() };
            SloncordPlatformIpBan.Apply(ban, ip, actor.Value, req?.Reason ?? "", durationMinutes);
            db.PlatformIpBans.Add(ban);
            await LogAsync(db, actor.Value, "ip.ban", "user", userId.ToString("D"),
                $"ip={ip};{(durationMinutes is > 0 ? $"until={ban.BannedUntilUtc:O}" : "permanent")}");
            await db.SaveChangesAsync();

            return Results.Ok(new
            {
                ok = true,
                id = ban.Id.ToString("D"),
                ipAddress = ban.IpAddress,
                bannedUntilUtc = ban.BannedUntilUtc?.ToString("O"),
                permanent = ban.BannedUntilUtc is null
            });
        });

        app.MapDelete("/platform/ip-bans/{banId:guid}", async (HttpContext ctx, SloncordDbContext db, Guid banId) =>
        {
            var (actor, modDeny) = await RequirePermOrDenyAsync(ctx, db, PlatformModeratorPerm.BanIps);
            if (modDeny is not null) return modDeny;

            var ban = await db.PlatformIpBans.FirstOrDefaultAsync(x => x.Id == banId);
            if (ban is null) return Results.NotFound(new { error = "Блокировка IP не найдена" });

            var ip = ban.IpAddress;
            db.PlatformIpBans.Remove(ban);
            await LogAsync(db, actor!.Value, "ip.unban", "ip", ip, "");
            await db.SaveChangesAsync();
            return Results.Ok(new { ok = true });
        });
    }

    private sealed record PlatformModeratorUpdateRequest(bool? Revoke, string[]? Permissions);
    private sealed record PlatformIpBanRequest(string? IpAddress, string? Reason, int? DurationMinutes);
    private sealed record PlatformBanRequest(string? Reason, int? DurationMinutes);
    private sealed record PlatformChatMuteRequest(string? Reason, int? DurationMinutes);
    private sealed record PlatformResolveReportRequest(
        string? Status,
        string? Note,
        bool? DeleteMessage,
        bool? BanUser,
        string? BanReason,
        int? BanDurationMinutes,
        bool? MuteChat,
        string? ChatMuteReason,
        int? ChatMuteDurationMinutes);

    private static async Task<List<object>> BuildReportSummariesAsync(
        SloncordDbContext db,
        List<MessageReportEntity> reports)
    {
        if (reports.Count == 0) return new List<object>();

        var messageIds = reports.Select(r => r.MessageId).Distinct().ToList();
        var reporterIds = reports.Select(r => r.ReporterUserId).Distinct().ToList();
        var resolverIds = reports.Where(r => r.ResolvedByUserId != null).Select(r => r.ResolvedByUserId!.Value).Distinct().ToList();
        var userIds = reporterIds.Concat(resolverIds).Distinct().ToList();

        var messages = await db.Messages.AsNoTracking()
            .Where(m => messageIds.Contains(m.Id))
            .ToDictionaryAsync(m => m.Id);
        var senderIds = messages.Values.Select(m => m.SenderUserId).Distinct().ToList();
        var allUserIds = userIds.Concat(senderIds).Distinct().ToList();
        var users = allUserIds.Count > 0
            ? await db.Users.AsNoTracking().Where(u => allUserIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id)
            : new Dictionary<Guid, UserEntity>();

        var channelIds = reports.Select(r => r.ChannelId).Distinct().ToList();
        var channels = await db.Channels.AsNoTracking()
            .Where(c => channelIds.Contains(c.Id))
            .ToDictionaryAsync(c => c.Id);
        var serverIds = channels.Values.Where(c => c.ServerId != null).Select(c => c.ServerId!.Value).Distinct().ToList();
        var servers = serverIds.Count > 0
            ? await db.Servers.AsNoTracking().Where(s => serverIds.Contains(s.Id)).ToDictionaryAsync(s => s.Id)
            : new Dictionary<Guid, ServerEntity>();

        var dmIds = channels.Values.Where(c => c.Kind == ChannelKindEntity.Direct).Select(c => c.Id).ToList();
        var dmNames = await ResolveDirectChannelDisplayNamesAsync(db, dmIds);

        var attachRows = await db.MessageAttachments.AsNoTracking()
            .Where(a => messageIds.Contains(a.MessageId))
            .OrderBy(a => a.Order)
            .ToListAsync();
        var attachFileIds = attachRows.Select(a => a.FileId).ToList();
        var legacyFileIds = messages.Values.Where(m => m.FileId is not null).Select(m => m.FileId!.Value);
        var allFileIds = attachFileIds.Concat(legacyFileIds).Distinct().ToList();
        var reportFiles = allFileIds.Count > 0
            ? await db.Files.AsNoTracking().Where(f => allFileIds.Contains(f.Id)).ToDictionaryAsync(f => f.Id)
            : new Dictionary<Guid, StoredFileEntity>();
        var attachmentsByMessage = attachRows
            .GroupBy(a => a.MessageId)
            .ToDictionary(g => g.Key, g => g.Select(a => a.FileId).ToList());

        return reports.Select(r =>
        {
            messages.TryGetValue(r.MessageId, out var msg);
            channels.TryGetValue(r.ChannelId, out var ch);
            ServerEntity? srv = null;
            if (ch?.ServerId is not null) servers.TryGetValue(ch.ServerId.Value, out srv);
            users.TryGetValue(r.ReporterUserId, out var reporter);
            UserEntity? resolver = null;
            if (r.ResolvedByUserId is not null) users.TryGetValue(r.ResolvedByUserId.Value, out resolver);
            UserEntity? sender = null;
            if (msg is not null) users.TryGetValue(msg.SenderUserId, out sender);

            var attachments = new List<object>();
            object? legacyFile = null;
            if (msg is not null)
            {
                if (attachmentsByMessage.TryGetValue(msg.Id, out var fids))
                {
                    var seen = new HashSet<Guid>();
                    foreach (var fid in fids)
                    {
                        if (!seen.Add(fid)) continue;
                        if (reportFiles.TryGetValue(fid, out var f))
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
                }
                if (attachments.Count == 0 && msg.FileId is not null && reportFiles.TryGetValue(msg.FileId.Value, out var legacy))
                    attachments.Add(new
                    {
                        id = legacy.Id.ToString("D"),
                        originalName = legacy.OriginalName,
                        contentType = legacy.ContentType,
                        sizeBytes = legacy.SizeBytes
                    });
                if (msg.FileId is not null && reportFiles.TryGetValue(msg.FileId.Value, out var lf))
                    legacyFile = new { id = lf.Id.ToString("D"), originalName = lf.OriginalName };
            }

            return (object)new
            {
                id = r.Id.ToString("D"),
                status = r.Status,
                reason = r.Reason,
                createdAtUtc = r.CreatedAtUtc.ToString("O"),
                resolvedAtUtc = r.ResolvedAtUtc?.ToString("O"),
                moderatorNote = r.ModeratorNote,
                reporterUserId = r.ReporterUserId.ToString("D"),
                reporterNickname = reporter?.Nickname ?? "?",
                resolvedByNickname = resolver?.Nickname,
                message = msg is null ? null : new
                {
                    id = msg.Id.ToString("D"),
                    channelId = msg.ChannelId.ToString("D"),
                    channelName = ch is null
                        ? null
                        : ch.Kind == ChannelKindEntity.Direct
                            ? dmNames.GetValueOrDefault(ch.Id, ch.Name)
                            : ch.Name,
                    channelKind = ch?.Kind.ToString().ToLowerInvariant(),
                    serverId = ch?.ServerId?.ToString("D"),
                    serverName = srv?.Name,
                    senderUserId = msg.SenderUserId.ToString("D"),
                    senderNickname = sender?.Nickname ?? "?",
                    senderIsPlatformRoot = sender is not null && SloncordPlatformPermissions.IsPlatformRoot(sender.Login),
                    text = msg.Text,
                    isDeleted = msg.IsDeleted,
                    createdAtUtc = msg.CreatedAtUtc.ToString("O"),
                    file = legacyFile,
                    attachments
                }
            };
        }).ToList();
    }

    private static object PlatformUserSummary(UserEntity u, int serverCount) => new
    {
        id = u.Id.ToString("D"),
        login = u.Login,
        nickname = u.Nickname,
        bio = u.Bio,
        createdAtUtc = u.CreatedAtUtc.ToString("O"),
        lastSeenAtUtc = u.LastSeenAtUtc?.ToString("O"),
        isPlatformRoot = SloncordPlatformPermissions.IsPlatformRoot(u.Login),
        isPlatformModerator = u.IsPlatformModerator,
        platformModeratorPermissions = SloncordPlatformModeratorPerms.ToKeys(u.PlatformModeratorPermissions),
        isPlatformBanned = SloncordPlatformBan.IsActive(u),
        platformBannedAtUtc = u.PlatformBannedAtUtc?.ToString("O"),
        platformBannedUntilUtc = SloncordPlatformBan.IsActive(u) ? u.PlatformBannedUntilUtc?.ToString("O") : null,
        platformBanPermanent = SloncordPlatformBan.IsActive(u) && u.PlatformBannedUntilUtc is null,
        platformBanReason = SloncordPlatformBan.IsActive(u) ? (u.PlatformBanReason ?? "") : "",
        isChatMuted = SloncordChatMute.IsActive(u),
        chatMutedUntilUtc = SloncordChatMute.IsActive(u) ? u.ChatMutedUntilUtc!.Value.ToString("O") : null,
        chatMuteReason = SloncordChatMute.IsActive(u) ? (u.ChatMuteReason ?? "") : "",
        serverCount
    };

    private static async Task<(Guid? Id, IResult? Deny)> RequireAccessOrDenyAsync(HttpContext ctx, SloncordDbContext db)
    {
        var userId = await SloncordEndpoints.RequireUserIdForPlatformAsync(ctx, db);
        if (userId is null)
            return (null, Results.Json(new { error = "Требуется авторизация" }, statusCode: StatusCodes.Status401Unauthorized));

        var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
        if (!await SloncordPlatformPermissions.HasAnyModerationAccessAsync(config, db, userId.Value))
            return (null, Results.Json(new { error = "Нет прав модератора платформы" }, statusCode: StatusCodes.Status403Forbidden));

        return (userId, null);
    }

    private static async Task<(Guid? Id, IResult? Deny)> RequirePermOrDenyAsync(
        HttpContext ctx,
        SloncordDbContext db,
        PlatformModeratorPerm perm)
    {
        var userId = await SloncordEndpoints.RequireUserIdForPlatformAsync(ctx, db);
        if (userId is null)
            return (null, Results.Json(new { error = "Требуется авторизация" }, statusCode: StatusCodes.Status401Unauthorized));

        var config = ctx.RequestServices.GetRequiredService<IConfiguration>();
        if (!await SloncordPlatformPermissions.HasPermissionAsync(config, db, userId.Value, perm))
            return (null, Results.Json(new { error = "Недостаточно прав" }, statusCode: StatusCodes.Status403Forbidden));

        return (userId, null);
    }

    private static async Task<(Guid? Id, IResult? Deny)> RequireRootOrDenyAsync(HttpContext ctx, SloncordDbContext db)
    {
        var userId = await SloncordEndpoints.RequireUserIdForPlatformAsync(ctx, db);
        if (userId is null)
            return (null, Results.Json(new { error = "Требуется авторизация" }, statusCode: StatusCodes.Status401Unauthorized));

        var login = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId.Value)
            .Select(u => u.Login)
            .FirstOrDefaultAsync();
        if (!SloncordPlatformPermissions.IsPlatformRoot(login))
            return (null, Results.Json(new { error = "Только root может управлять модераторами" }, statusCode: StatusCodes.Status403Forbidden));

        return (userId, null);
    }

    private static async Task LogAsync(
        SloncordDbContext db,
        Guid actorUserId,
        string action,
        string targetType,
        string targetId,
        string details)
    {
        db.PlatformModerationLogs.Add(new PlatformModerationLogEntity
        {
            Id = Guid.NewGuid(),
            ActorUserId = actorUserId,
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Details = details ?? "",
            CreatedAtUtc = DateTime.UtcNow
        });
        await Task.CompletedTask;
    }

    private static async Task<List<object>> PlatformMessageDtosAsync(
        SloncordDbContext db,
        List<MessageEntity> list,
        ChannelEntity ch)
    {
        if (list.Count == 0) return new List<object>();

        string? serverName = null;
        string? serverId = ch.ServerId?.ToString("D");
        if (ch.ServerId is not null)
        {
            serverName = await db.Servers.AsNoTracking()
                .Where(s => s.Id == ch.ServerId.Value)
                .Select(s => s.Name)
                .FirstOrDefaultAsync();
        }

        var senderIds = list.Select(m => m.SenderUserId).Distinct().ToList();
        var senders = await db.Users.AsNoTracking()
            .Where(u => senderIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id);

        var messageIds = list.Select(m => m.Id).ToList();
        var attachRows = await db.MessageAttachments.AsNoTracking()
            .Where(a => messageIds.Contains(a.MessageId))
            .OrderBy(a => a.Order)
            .ToListAsync();
        var attachFileIds = attachRows.Select(a => a.FileId).ToList();
        var legacyFileIds = list.Where(m => m.FileId is not null).Select(m => m.FileId!.Value);
        var allFileIds = attachFileIds.Concat(legacyFileIds).Distinct().ToList();
        var files = allFileIds.Count > 0
            ? await db.Files.AsNoTracking().Where(f => allFileIds.Contains(f.Id)).ToDictionaryAsync(f => f.Id)
            : new Dictionary<Guid, StoredFileEntity>();

        var attachmentsByMessage = attachRows
            .GroupBy(a => a.MessageId)
            .ToDictionary(g => g.Key, g => g.Select(a => a.FileId).ToList());

        static object? FileDto(StoredFileEntity f) => new
        {
            id = f.Id.ToString("D"),
            originalName = f.OriginalName,
            contentType = f.ContentType,
            sizeBytes = f.SizeBytes
        };

        var channelDisplayName = await ResolveChannelDisplayNameAsync(db, ch);

        return list.Select(m =>
        {
            var attachments = new List<object>();
            if (attachmentsByMessage.TryGetValue(m.Id, out var fids))
            {
                var seen = new HashSet<Guid>();
                foreach (var fid in fids)
                {
                    if (!seen.Add(fid)) continue;
                    if (files.TryGetValue(fid, out var f)) attachments.Add(FileDto(f)!);
                }
            }
            if (attachments.Count == 0 && m.FileId is not null && files.TryGetValue(m.FileId.Value, out var legacy))
                attachments.Add(FileDto(legacy)!);

            object? legacyFile = m.FileId is not null && files.TryGetValue(m.FileId.Value, out var lf)
                ? new { id = lf.Id.ToString("D"), originalName = lf.OriginalName }
                : null;

            return (object)new
            {
                id = m.Id.ToString("D"),
                channelId = m.ChannelId.ToString("D"),
                channelName = channelDisplayName,
                channelKind = ch.Kind.ToString().ToLowerInvariant(),
                serverId,
                serverName,
                senderUserId = m.SenderUserId.ToString("D"),
                senderNickname = senders.TryGetValue(m.SenderUserId, out var sender) ? sender.Nickname : "?",
                senderIsPlatformRoot = senders.TryGetValue(m.SenderUserId, out var senderRoot)
                    && SloncordPlatformPermissions.IsPlatformRoot(senderRoot.Login),
                text = m.Text,
                isDeleted = m.IsDeleted,
                createdAtUtc = m.CreatedAtUtc.ToString("O"),
                editedAtUtc = m.EditedAtUtc?.ToString("O"),
                file = legacyFile,
                attachments
            };
        }).ToList();
    }

    private static string FormatDirectChannelLabel(IEnumerable<(Guid UserId, string Login, string Nickname)> members)
    {
        var labels = members
            .Select(m =>
            {
                var login = (m.Login ?? "").Trim();
                if (login.Length > 0) return login;
                var nick = (m.Nickname ?? "").Trim();
                if (nick.Length > 0) return nick;
                return m.UserId.ToString("D")[..8];
            })
            .Where(s => s.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return labels.Count >= 2 ? string.Join(":", labels)
            : labels.Count == 1 ? labels[0]
            : "DM";
    }

    private static async Task<Dictionary<Guid, string>> ResolveDirectChannelDisplayNamesAsync(
        SloncordDbContext db,
        IEnumerable<Guid> channelIds,
        CancellationToken ct = default)
    {
        var ids = channelIds.Distinct().ToList();
        if (ids.Count == 0) return new Dictionary<Guid, string>();

        var members = await db.ChannelMembers.AsNoTracking()
            .Where(m => ids.Contains(m.ChannelId))
            .Select(m => new { m.ChannelId, m.UserId })
            .ToListAsync(ct);

        var userIds = members.Select(m => m.UserId).Distinct().ToList();
        var users = userIds.Count > 0
            ? await db.Users.AsNoTracking()
                .Where(u => userIds.Contains(u.Id))
                .ToDictionaryAsync(u => u.Id, ct)
            : new Dictionary<Guid, UserEntity>();

        var result = new Dictionary<Guid, string>();
        foreach (var g in members.GroupBy(m => m.ChannelId))
        {
            var parts = g.Select(m =>
            {
                if (users.TryGetValue(m.UserId, out var u))
                    return (m.UserId, u.Login, u.Nickname);
                return (m.UserId, "", "");
            });
            result[g.Key] = FormatDirectChannelLabel(parts);
        }

        return result;
    }

    private static async Task<string> ResolveChannelDisplayNameAsync(
        SloncordDbContext db,
        ChannelEntity ch,
        CancellationToken ct = default)
    {
        if (ch.Kind != ChannelKindEntity.Direct) return ch.Name;
        var resolved = await ResolveDirectChannelDisplayNamesAsync(db, new[] { ch.Id }, ct);
        return resolved.GetValueOrDefault(ch.Id, ch.Name);
    }
}
