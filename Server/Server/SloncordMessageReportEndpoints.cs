using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

internal static class SloncordMessageReportEndpoints
{
    public static void Map(WebApplication app, SloncordAppState s)
    {
        app.MapPost("/channels/{channelId:guid}/messages/{messageId:guid}/report", ReportMessageHandler);
        app.MapPost("/dm/{channelId:guid}/messages/{messageId:guid}/report", ReportMessageHandler);

        async Task<IResult> ReportMessageHandler(
            HttpContext ctx,
            SloncordDbContext db,
            Guid channelId,
            Guid messageId,
            ReportMessageRequest? req)
        {
            var me = await SloncordEndpoints.RequireUserIdForPlatformAsync(ctx, db);
            if (me is null) return Results.Unauthorized();
            if (!await SloncordEndpoints.IsChannelMemberAsync(db, channelId, me.Value))
                return Results.Json(new { error = "Нет доступа к этому каналу" }, statusCode: StatusCodes.Status403Forbidden);

            var chKind = await db.Channels.AsNoTracking()
                .Where(c => c.Id == channelId)
                .Select(c => c.Kind)
                .FirstOrDefaultAsync();
            if (chKind == ChannelKindEntity.Voice)
                return Results.BadRequest(new { error = "Нельзя пожаловаться на сообщение в голосовом канале" });

            var msg = await db.Messages.AsNoTracking()
                .FirstOrDefaultAsync(m => m.Id == messageId && m.ChannelId == channelId);
            if (msg is null) return Results.NotFound(new { error = "Сообщение не найдено" });
            if (msg.IsDeleted) return Results.BadRequest(new { error = "Сообщение уже удалено" });
            if (msg.SenderUserId == me.Value)
                return Results.BadRequest(new { error = "Нельзя пожаловаться на своё сообщение" });

            var hasPending = await db.MessageReports.AsNoTracking()
                .AnyAsync(r => r.ReporterUserId == me.Value && r.MessageId == messageId && r.Status == "pending");
            if (hasPending)
                return Results.BadRequest(new { error = "Вы уже отправили жалобу на это сообщение" });

            var reason = (req?.Reason ?? "").Trim();
            if (reason.Length > 2000) reason = reason[..2000];

            var report = new MessageReportEntity
            {
                Id = Guid.NewGuid(),
                MessageId = messageId,
                ChannelId = channelId,
                ReporterUserId = me.Value,
                Reason = reason,
                Status = "pending",
                CreatedAtUtc = DateTime.UtcNow
            };
            db.MessageReports.Add(report);
            SloncordUserActivity.Add(db, me.Value, "report.submit", $"reason={SloncordUserActivity.Truncate(reason, 120)}", SloncordClientIp.Resolve(ctx));
            try
            {
                await db.SaveChangesAsync();
            }
            catch (Exception ex)
            {
                return Results.Json(
                    new { error = "Не удалось сохранить жалобу. Перезапустите сервер после деплоя (таблица MessageReports)." , detail = ex.Message },
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            await SloncordPlatformReports.NotifyChangedAsync(s, db);

            return Results.Ok(new { ok = true, reportId = report.Id.ToString("D") });
        }
    }

    private sealed record ReportMessageRequest(string? Reason);
}
