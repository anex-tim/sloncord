using Microsoft.EntityFrameworkCore;
using Sloncord.Data;

namespace Sloncord;

/// <summary>Когда БД создана раньше, чем в модель добавили серверы — догоняем схему (EnsureCreated не обновляет существующие таблицы).</summary>
internal static class SloncordServerSchema
{
    public static async Task ApplyAsync(SloncordDbContext db, CancellationToken ct = default)
    {
        // Presence: store last-seen timestamp.
        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "LastSeenAtUtc" timestamp with time zone NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "Servers" (
                "Id" uuid NOT NULL,
                "Name" text NOT NULL,
                "Description" text NOT NULL DEFAULT '',
                "OwnerUserId" uuid NOT NULL,
                "InviteCode" text NOT NULL,
                "CreatedAtUtc" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_Servers" PRIMARY KEY ("Id")
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_Servers_InviteCode" ON "Servers" ("InviteCode");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Servers" ADD COLUMN IF NOT EXISTS "Description" text NOT NULL DEFAULT '';
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Servers" ADD COLUMN IF NOT EXISTS "AvatarFileId" uuid NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "ServerMembers" (
                "ServerId" uuid NOT NULL,
                "UserId" uuid NOT NULL,
                "JoinedAtUtc" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_ServerMembers" PRIMARY KEY ("ServerId", "UserId"),
                CONSTRAINT "FK_ServerMembers_Servers_ServerId" FOREIGN KEY ("ServerId") REFERENCES "Servers" ("Id") ON DELETE CASCADE,
                CONSTRAINT "FK_ServerMembers_Users_UserId" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
            );
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Channels" ADD COLUMN IF NOT EXISTS "ServerId" uuid NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "AvatarFileId" uuid NULL;
            ALTER TABLE "Channels" ADD COLUMN IF NOT EXISTS "AvatarFileId" uuid NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            DO $ef$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Users_Files_AvatarFileId') THEN
                    ALTER TABLE "Users" ADD CONSTRAINT "FK_Users_Files_AvatarFileId"
                        FOREIGN KEY ("AvatarFileId") REFERENCES "Files" ("Id") ON DELETE SET NULL;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Servers_Files_AvatarFileId') THEN
                    ALTER TABLE "Servers" ADD CONSTRAINT "FK_Servers_Files_AvatarFileId"
                        FOREIGN KEY ("AvatarFileId") REFERENCES "Files" ("Id") ON DELETE SET NULL;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Channels_Files_AvatarFileId') THEN
                    ALTER TABLE "Channels" ADD CONSTRAINT "FK_Channels_Files_AvatarFileId"
                        FOREIGN KEY ("AvatarFileId") REFERENCES "Files" ("Id") ON DELETE SET NULL;
                END IF;
            END
            $ef$;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            DO $ef$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Channels_Servers_ServerId') THEN
                    ALTER TABLE "Channels" ADD CONSTRAINT "FK_Channels_Servers_ServerId"
                        FOREIGN KEY ("ServerId") REFERENCES "Servers" ("Id") ON DELETE CASCADE;
                END IF;
            END
            $ef$;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "ChannelReadStates" ADD COLUMN IF NOT EXISTS "DmClearedUpToUtc" timestamp with time zone NULL;
            """, cancellationToken: ct);

        // Message attachments (up to N files per message).
        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "MessageAttachments" (
                "MessageId" uuid NOT NULL,
                "FileId" uuid NOT NULL,
                "Order" integer NOT NULL DEFAULT 0,
                CONSTRAINT "PK_MessageAttachments" PRIMARY KEY ("MessageId", "FileId"),
                CONSTRAINT "FK_MessageAttachments_Messages_MessageId" FOREIGN KEY ("MessageId") REFERENCES "Messages" ("Id") ON DELETE CASCADE,
                CONSTRAINT "FK_MessageAttachments_Files_FileId" FOREIGN KEY ("FileId") REFERENCES "Files" ("Id") ON DELETE RESTRICT
            );
            CREATE INDEX IF NOT EXISTS "IX_MessageAttachments_MessageId_Order" ON "MessageAttachments" ("MessageId", "Order");
            """, cancellationToken: ct);

        // Message replies (self-reference). EnsureCreated does not add new columns on existing DBs.
        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Messages" ADD COLUMN IF NOT EXISTS "ReplyToMessageId" uuid NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            DO $ef$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Messages_Messages_ReplyToMessageId') THEN
                    ALTER TABLE "Messages" ADD CONSTRAINT "FK_Messages_Messages_ReplyToMessageId"
                        FOREIGN KEY ("ReplyToMessageId") REFERENCES "Messages" ("Id") ON DELETE SET NULL;
                END IF;
            END
            $ef$;
            """, cancellationToken: ct);

        // Resumable uploads (large files / videos).
        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "UploadSessions" (
                "Id" uuid NOT NULL,
                "UserId" uuid NOT NULL,
                "FileName" text NOT NULL,
                "ContentType" text NOT NULL,
                "TotalBytes" bigint NOT NULL,
                "UploadedBytes" bigint NOT NULL DEFAULT 0,
                "TempStorageName" text NOT NULL,
                "CreatedAtUtc" timestamp with time zone NOT NULL,
                "ExpiresAtUtc" timestamp with time zone NOT NULL,
                "State" text NOT NULL DEFAULT 'active',
                CONSTRAINT "PK_UploadSessions" PRIMARY KEY ("Id"),
                CONSTRAINT "FK_UploadSessions_Users_UserId" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_UploadSessions_TempStorageName" ON "UploadSessions" ("TempStorageName");
            CREATE INDEX IF NOT EXISTS "IX_UploadSessions_UserId_CreatedAtUtc" ON "UploadSessions" ("UserId", "CreatedAtUtc");
            CREATE INDEX IF NOT EXISTS "IX_UploadSessions_ExpiresAtUtc" ON "UploadSessions" ("ExpiresAtUtc");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "ServerMembers" ADD COLUMN IF NOT EXISTS "IsAdmin" boolean NOT NULL DEFAULT FALSE;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "ServerBans" (
                "ServerId" uuid NOT NULL,
                "UserId" uuid NOT NULL,
                "BannedByUserId" uuid NULL,
                "BannedAtUtc" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_ServerBans" PRIMARY KEY ("ServerId", "UserId"),
                CONSTRAINT "FK_ServerBans_Servers_ServerId" FOREIGN KEY ("ServerId") REFERENCES "Servers" ("Id") ON DELETE CASCADE,
                CONSTRAINT "FK_ServerBans_Users_UserId" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE,
                CONSTRAINT "FK_ServerBans_Users_BannedByUserId" FOREIGN KEY ("BannedByUserId") REFERENCES "Users" ("Id") ON DELETE SET NULL
            );
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "IsPlatformModerator" boolean NOT NULL DEFAULT FALSE;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "PlatformModeratorPermissions" bigint NOT NULL DEFAULT 0;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "IsPlatformBanned" boolean NOT NULL DEFAULT FALSE;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "PlatformBannedAtUtc" timestamp with time zone NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "PlatformBannedUntilUtc" timestamp with time zone NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "PlatformBanReason" text NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "PlatformBannedByUserId" uuid NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "ChatMutedUntilUtc" timestamp with time zone NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "ChatMuteReason" text NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "ChatMutedByUserId" uuid NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "PlatformModerationLogs" (
                "Id" uuid NOT NULL,
                "ActorUserId" uuid NOT NULL,
                "Action" text NOT NULL,
                "TargetType" text NOT NULL,
                "TargetId" text NOT NULL,
                "Details" text NOT NULL DEFAULT '',
                "CreatedAtUtc" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_PlatformModerationLogs" PRIMARY KEY ("Id")
            );
            CREATE INDEX IF NOT EXISTS "IX_PlatformModerationLogs_CreatedAtUtc" ON "PlatformModerationLogs" ("CreatedAtUtc");
            CREATE INDEX IF NOT EXISTS "IX_PlatformModerationLogs_TargetType_TargetId" ON "PlatformModerationLogs" ("TargetType", "TargetId");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "MessageReports" (
                "Id" uuid NOT NULL,
                "MessageId" uuid NOT NULL,
                "ChannelId" uuid NOT NULL,
                "ReporterUserId" uuid NOT NULL,
                "Reason" text NOT NULL DEFAULT '',
                "Status" text NOT NULL DEFAULT 'pending',
                "CreatedAtUtc" timestamp with time zone NOT NULL,
                "ResolvedByUserId" uuid NULL,
                "ResolvedAtUtc" timestamp with time zone NULL,
                "ModeratorNote" text NOT NULL DEFAULT '',
                CONSTRAINT "PK_MessageReports" PRIMARY KEY ("Id")
            );
            CREATE INDEX IF NOT EXISTS "IX_MessageReports_Status" ON "MessageReports" ("Status");
            CREATE INDEX IF NOT EXISTS "IX_MessageReports_CreatedAtUtc" ON "MessageReports" ("CreatedAtUtc");
            CREATE INDEX IF NOT EXISTS "IX_MessageReports_MessageId" ON "MessageReports" ("MessageId");
            CREATE INDEX IF NOT EXISTS "IX_MessageReports_ReporterUserId_MessageId_Status" ON "MessageReports" ("ReporterUserId", "MessageId", "Status");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "LastKnownIp" text NULL;
            ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "LastKnownIpAtUtc" timestamp with time zone NULL;
            ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "CreatedFromIp" text NULL;
            ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "LastSeenIp" text NULL;
            ALTER TABLE "Sessions" ADD COLUMN IF NOT EXISTS "LastSeenAtUtc" timestamp with time zone NULL;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "UserActivityLogs" (
                "Id" uuid NOT NULL,
                "UserId" uuid NOT NULL,
                "Action" text NOT NULL,
                "Details" text NOT NULL DEFAULT '',
                "IpAddress" text NULL,
                "CreatedAtUtc" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_UserActivityLogs" PRIMARY KEY ("Id"),
                CONSTRAINT "FK_UserActivityLogs_Users_UserId" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "IX_UserActivityLogs_UserId" ON "UserActivityLogs" ("UserId");
            CREATE INDEX IF NOT EXISTS "IX_UserActivityLogs_CreatedAtUtc" ON "UserActivityLogs" ("CreatedAtUtc");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "PlatformIpBans" (
                "Id" uuid NOT NULL,
                "IpAddress" text NOT NULL,
                "Reason" text NOT NULL DEFAULT '',
                "BannedByUserId" uuid NULL,
                "BannedAtUtc" timestamp with time zone NOT NULL,
                "BannedUntilUtc" timestamp with time zone NULL,
                CONSTRAINT "PK_PlatformIpBans" PRIMARY KEY ("Id"),
                CONSTRAINT "FK_PlatformIpBans_Users_BannedByUserId" FOREIGN KEY ("BannedByUserId") REFERENCES "Users" ("Id") ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS "IX_PlatformIpBans_IpAddress" ON "PlatformIpBans" ("IpAddress");
            CREATE INDEX IF NOT EXISTS "IX_PlatformIpBans_BannedAtUtc" ON "PlatformIpBans" ("BannedAtUtc");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "ChannelCategories" (
                "Id" uuid NOT NULL,
                "ServerId" uuid NOT NULL,
                "Name" text NOT NULL,
                "Position" integer NOT NULL DEFAULT 0,
                CONSTRAINT "PK_ChannelCategories" PRIMARY KEY ("Id"),
                CONSTRAINT "FK_ChannelCategories_Servers_ServerId" FOREIGN KEY ("ServerId") REFERENCES "Servers" ("Id") ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "IX_ChannelCategories_ServerId_Position" ON "ChannelCategories" ("ServerId", "Position");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "Channels" ADD COLUMN IF NOT EXISTS "CategoryId" uuid NULL;
            ALTER TABLE "Channels" ADD COLUMN IF NOT EXISTS "Position" integer NOT NULL DEFAULT 0;
            ALTER TABLE "Channels" ADD COLUMN IF NOT EXISTS "IsPrivate" boolean NOT NULL DEFAULT FALSE;
            ALTER TABLE "ChannelCategories" ADD COLUMN IF NOT EXISTS "IsPrivate" boolean NOT NULL DEFAULT FALSE;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TABLE IF NOT EXISTS "CategoryMembers" (
                "CategoryId" uuid NOT NULL,
                "UserId" uuid NOT NULL,
                "JoinedAtUtc" timestamp with time zone NOT NULL,
                CONSTRAINT "PK_CategoryMembers" PRIMARY KEY ("CategoryId", "UserId"),
                CONSTRAINT "FK_CategoryMembers_ChannelCategories_CategoryId" FOREIGN KEY ("CategoryId") REFERENCES "ChannelCategories" ("Id") ON DELETE CASCADE,
                CONSTRAINT "FK_CategoryMembers_Users_UserId" FOREIGN KEY ("UserId") REFERENCES "Users" ("Id") ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS "IX_CategoryMembers_UserId" ON "CategoryMembers" ("UserId");
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            DO $ef$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_Channels_ChannelCategories_CategoryId') THEN
                    ALTER TABLE "Channels" ADD CONSTRAINT "FK_Channels_ChannelCategories_CategoryId"
                        FOREIGN KEY ("CategoryId") REFERENCES "ChannelCategories" ("Id") ON DELETE SET NULL;
                END IF;
            END
            $ef$;
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            WITH ranked AS (
                SELECT "Id", ROW_NUMBER() OVER (PARTITION BY "ServerId" ORDER BY "Name") - 1 AS pos
                FROM "Channels"
                WHERE "ServerId" IS NOT NULL AND "Position" = 0
            )
            UPDATE "Channels" c SET "Position" = r.pos
            FROM ranked r WHERE c."Id" = r."Id";
            """, cancellationToken: ct);

        await db.Database.ExecuteSqlRawAsync(
            """
            ALTER TABLE "ChannelMembers" ADD COLUMN IF NOT EXISTS "IsVoiceOnly" boolean NOT NULL DEFAULT FALSE;
            """, cancellationToken: ct);

    }
}
