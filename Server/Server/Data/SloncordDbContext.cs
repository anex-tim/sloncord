using Microsoft.EntityFrameworkCore;

namespace Sloncord.Data;

public sealed class SloncordDbContext : DbContext
{
    public SloncordDbContext(DbContextOptions<SloncordDbContext> options) : base(options)
    {
    }

    public DbSet<UserEntity> Users => Set<UserEntity>();
    public DbSet<UserSessionEntity> Sessions => Set<UserSessionEntity>();
    public DbSet<ChannelEntity> Channels => Set<ChannelEntity>();
    public DbSet<ChannelMemberEntity> ChannelMembers => Set<ChannelMemberEntity>();
    public DbSet<MessageEntity> Messages => Set<MessageEntity>();
    public DbSet<MessageAttachmentEntity> MessageAttachments => Set<MessageAttachmentEntity>();
    public DbSet<StoredFileEntity> Files => Set<StoredFileEntity>();
    public DbSet<UploadSessionEntity> UploadSessions => Set<UploadSessionEntity>();
    public DbSet<ChannelReadStateEntity> ChannelReadStates => Set<ChannelReadStateEntity>();
    public DbSet<PushSubscriptionEntity> PushSubscriptions => Set<PushSubscriptionEntity>();
    public DbSet<ServerEntity> Servers => Set<ServerEntity>();
    public DbSet<ServerMemberEntity> ServerMembers => Set<ServerMemberEntity>();
    public DbSet<ServerBanEntity> ServerBans => Set<ServerBanEntity>();
    public DbSet<ChannelCategoryEntity> ChannelCategories => Set<ChannelCategoryEntity>();
    public DbSet<CategoryMemberEntity> CategoryMembers => Set<CategoryMemberEntity>();
    public DbSet<PlatformModerationLogEntity> PlatformModerationLogs => Set<PlatformModerationLogEntity>();
    public DbSet<MessageReportEntity> MessageReports => Set<MessageReportEntity>();
    public DbSet<UserActivityLogEntity> UserActivityLogs => Set<UserActivityLogEntity>();
    public DbSet<PlatformIpBanEntity> PlatformIpBans => Set<PlatformIpBanEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<UserEntity>(b =>
        {
            b.HasIndex(x => x.Login).IsUnique();
            b.HasIndex(x => x.Nickname).IsUnique();
        });

        modelBuilder.Entity<UserSessionEntity>(b =>
        {
            b.HasIndex(x => x.Token).IsUnique();
            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ServerEntity>(b =>
        {
            b.HasIndex(x => x.InviteCode).IsUnique();
        });

        modelBuilder.Entity<ServerMemberEntity>(b =>
        {
            b.HasKey(x => new { x.ServerId, x.UserId });
            b.HasOne(x => x.Server)
                .WithMany(x => x.Members!)
                .HasForeignKey(x => x.ServerId)
                .OnDelete(DeleteBehavior.Cascade);
            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ServerBanEntity>(b =>
        {
            b.HasKey(x => new { x.ServerId, x.UserId });
            b.HasOne(x => x.Server)
                .WithMany()
                .HasForeignKey(x => x.ServerId)
                .OnDelete(DeleteBehavior.Cascade);
            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
            b.HasOne(x => x.BannedByUser)
                .WithMany()
                .HasForeignKey(x => x.BannedByUserId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<ChannelCategoryEntity>(b =>
        {
            b.HasOne(x => x.Server)
                .WithMany(x => x.Categories)
                .HasForeignKey(x => x.ServerId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<CategoryMemberEntity>(b =>
        {
            b.HasKey(x => new { x.CategoryId, x.UserId });

            b.HasOne(x => x.Category)
                .WithMany(x => x.Members!)
                .HasForeignKey(x => x.CategoryId)
                .OnDelete(DeleteBehavior.Cascade);

            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ChannelEntity>(b =>
        {
            b.Property(x => x.Kind).HasConversion<string>();
            b.HasOne(x => x.Server)
                .WithMany(x => x.Channels)
                .HasForeignKey(x => x.ServerId)
                .OnDelete(DeleteBehavior.Cascade);
            b.HasOne(x => x.Category)
                .WithMany(x => x.Channels)
                .HasForeignKey(x => x.CategoryId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<ChannelMemberEntity>(b =>
        {
            b.HasKey(x => new { x.ChannelId, x.UserId });

            b.HasOne(x => x.Channel)
                .WithMany(x => x.Members!)
                .HasForeignKey(x => x.ChannelId)
                .OnDelete(DeleteBehavior.Cascade);

            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<MessageEntity>(b =>
        {
            b.HasIndex(x => new { x.ChannelId, x.CreatedAtUtc });

            b.HasOne(x => x.Channel)
                .WithMany(x => x.Messages!)
                .HasForeignKey(x => x.ChannelId)
                .OnDelete(DeleteBehavior.Cascade);

            b.HasOne(x => x.Sender)
                .WithMany()
                .HasForeignKey(x => x.SenderUserId)
                .OnDelete(DeleteBehavior.Restrict);

            b.HasOne(x => x.File)
                .WithMany()
                .HasForeignKey(x => x.FileId)
                .OnDelete(DeleteBehavior.SetNull);

            // Reply-to (self-reference). If the referenced message is deleted, keep this message.
            b.HasOne(x => x.ReplyTo)
                .WithMany()
                .HasForeignKey(x => x.ReplyToMessageId)
                .OnDelete(DeleteBehavior.SetNull);
        });

        modelBuilder.Entity<MessageAttachmentEntity>(b =>
        {
            b.HasKey(x => new { x.MessageId, x.FileId });
            b.HasIndex(x => new { x.MessageId, x.Order });

            b.HasOne(x => x.Message)
                .WithMany(m => m.Attachments)
                .HasForeignKey(x => x.MessageId)
                .OnDelete(DeleteBehavior.Cascade);

            b.HasOne(x => x.File)
                .WithMany()
                .HasForeignKey(x => x.FileId)
                .OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<StoredFileEntity>(b =>
        {
            b.HasIndex(x => x.StorageName).IsUnique();
        });

        modelBuilder.Entity<UploadSessionEntity>(b =>
        {
            b.HasIndex(x => new { x.UserId, x.CreatedAtUtc });
            b.HasIndex(x => x.ExpiresAtUtc);
            b.HasIndex(x => x.TempStorageName).IsUnique();
        });

        modelBuilder.Entity<ChannelReadStateEntity>(b =>
        {
            b.HasKey(x => new { x.UserId, x.ChannelId });

            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            b.HasOne(x => x.Channel)
                .WithMany()
                .HasForeignKey(x => x.ChannelId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<PushSubscriptionEntity>(b =>
        {
            b.HasIndex(x => new { x.UserId, x.Endpoint }).IsUnique();

            b.HasOne(x => x.User)
                .WithMany()
                .HasForeignKey(x => x.UserId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<PlatformModerationLogEntity>(b =>
        {
            b.HasIndex(x => x.CreatedAtUtc);
            b.HasIndex(x => new { x.TargetType, x.TargetId });
        });

        modelBuilder.Entity<MessageReportEntity>(b =>
        {
            b.HasIndex(x => x.Status);
            b.HasIndex(x => x.CreatedAtUtc);
            b.HasIndex(x => x.MessageId);
            b.HasIndex(x => new { x.ReporterUserId, x.MessageId, x.Status });
        });

        modelBuilder.Entity<UserActivityLogEntity>(b =>
        {
            b.HasIndex(x => x.UserId);
            b.HasIndex(x => x.CreatedAtUtc);
        });

        modelBuilder.Entity<PlatformIpBanEntity>(b =>
        {
            b.HasIndex(x => x.IpAddress);
            b.HasIndex(x => x.BannedAtUtc);
        });

    }
}

public enum ChannelKindEntity
{
    Public,
    Direct,
    Voice
}

public sealed class UserEntity
{
    public Guid Id { get; set; }
    public string Login { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string Salt { get; set; } = string.Empty;
    public string Nickname { get; set; } = string.Empty;
    public string Bio { get; set; } = string.Empty;
    public Guid? AvatarFileId { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime? LastSeenAtUtc { get; set; }
    public bool AccountApproved { get; set; } = true;
    public bool IsPlatformModerator { get; set; }
    public ulong PlatformModeratorPermissions { get; set; }
    public bool IsPlatformBanned { get; set; }
    public DateTime? PlatformBannedAtUtc { get; set; }
    public DateTime? PlatformBannedUntilUtc { get; set; }
    public string? PlatformBanReason { get; set; }
    public Guid? PlatformBannedByUserId { get; set; }
    public DateTime? ChatMutedUntilUtc { get; set; }
    public string? ChatMuteReason { get; set; }
    public Guid? ChatMutedByUserId { get; set; }
    public string? LastKnownIp { get; set; }
    public DateTime? LastKnownIpAtUtc { get; set; }
}

public sealed class UserSessionEntity
{
    public Guid Id { get; set; }
    public string Token { get; set; } = string.Empty;
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public string? CreatedFromIp { get; set; }
    public string? LastSeenIp { get; set; }
    public DateTime? LastSeenAtUtc { get; set; }
}

public sealed class ServerEntity
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public Guid OwnerUserId { get; set; }
    public string InviteCode { get; set; } = string.Empty;
    public Guid? AvatarFileId { get; set; }
    public DateTime CreatedAtUtc { get; set; }

    public List<ServerMemberEntity>? Members { get; set; }
    public List<ChannelEntity>? Channels { get; set; }
    public List<ChannelCategoryEntity>? Categories { get; set; }
}

public sealed class ChannelCategoryEntity
{
    public Guid Id { get; set; }
    public Guid ServerId { get; set; }
    public ServerEntity? Server { get; set; }
    public string Name { get; set; } = string.Empty;
    public int Position { get; set; }
    public bool IsPrivate { get; set; }
    public List<ChannelEntity>? Channels { get; set; }
    public List<CategoryMemberEntity>? Members { get; set; }
}

public sealed class CategoryMemberEntity
{
    public Guid CategoryId { get; set; }
    public ChannelCategoryEntity? Category { get; set; }
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }
    public DateTime JoinedAtUtc { get; set; }
}

public sealed class ServerMemberEntity
{
    public Guid ServerId { get; set; }
    public ServerEntity? Server { get; set; }
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }
    public DateTime JoinedAtUtc { get; set; }
    public bool IsAdmin { get; set; }
}

public sealed class ServerBanEntity
{
    public Guid ServerId { get; set; }
    public ServerEntity? Server { get; set; }
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }
    public Guid? BannedByUserId { get; set; }
    public UserEntity? BannedByUser { get; set; }
    public DateTime BannedAtUtc { get; set; }
}

public sealed class ChannelEntity
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public ChannelKindEntity Kind { get; set; } = ChannelKindEntity.Public;
    public Guid OwnerUserId { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public Guid? ServerId { get; set; }
    public ServerEntity? Server { get; set; }
    public Guid? AvatarFileId { get; set; }
    public Guid? CategoryId { get; set; }
    public ChannelCategoryEntity? Category { get; set; }
    public int Position { get; set; }
    public bool IsPrivate { get; set; }

    public List<ChannelMemberEntity>? Members { get; set; }
    public List<MessageEntity>? Messages { get; set; }
}

public sealed class ChannelMemberEntity
{
    public Guid ChannelId { get; set; }
    public ChannelEntity? Channel { get; set; }

    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }

    public DateTime JoinedAtUtc { get; set; }

    /// <summary>Временный доступ только на время голосового подключения (перетаскивание модератором).</summary>
    public bool IsVoiceOnly { get; set; }
}

public sealed class MessageEntity
{
    public Guid Id { get; set; }
    public Guid ChannelId { get; set; }
    public ChannelEntity? Channel { get; set; }

    public Guid SenderUserId { get; set; }
    public UserEntity? Sender { get; set; }

    public string Text { get; set; } = string.Empty;
    public bool IsDeleted { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime? EditedAtUtc { get; set; }

    public Guid? ReplyToMessageId { get; set; }
    public MessageEntity? ReplyTo { get; set; }

    public Guid? FileId { get; set; }
    public StoredFileEntity? File { get; set; }

    public List<MessageAttachmentEntity>? Attachments { get; set; }
}

public sealed class MessageAttachmentEntity
{
    public Guid MessageId { get; set; }
    public MessageEntity? Message { get; set; }

    public Guid FileId { get; set; }
    public StoredFileEntity? File { get; set; }

    public int Order { get; set; }
}

public sealed class StoredFileEntity
{
    public Guid Id { get; set; }
    public string OriginalName { get; set; } = string.Empty;
    public string ContentType { get; set; } = "application/octet-stream";
    public long SizeBytes { get; set; }
    public string StorageName { get; set; } = string.Empty;
    public Guid UploadedByUserId { get; set; }
    public DateTime UploadedAtUtc { get; set; }
}

public sealed class UploadSessionEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }

    public string FileName { get; set; } = string.Empty;
    public string ContentType { get; set; } = "application/octet-stream";
    public long TotalBytes { get; set; }
    public long UploadedBytes { get; set; }

    public string TempStorageName { get; set; } = string.Empty;
    public DateTime CreatedAtUtc { get; set; }
    public DateTime ExpiresAtUtc { get; set; }
    public string State { get; set; } = "active"; // active | completed | aborted
}

public sealed class ChannelReadStateEntity
{
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }

    public Guid ChannelId { get; set; }
    public ChannelEntity? Channel { get; set; }

    // Points to the last message the user has "seen" in this channel.
    public Guid? LastReadMessageId { get; set; }
    public DateTime UpdatedAtUtc { get; set; }

    /// <summary>
    /// Личка: не показывать сообщения с createdAtUtc &lt;= этой границы (локальная «очистка»).
    /// </summary>
    public DateTime? DmClearedUpToUtc { get; set; }
}


public sealed class PushSubscriptionEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }
    public string Endpoint { get; set; } = string.Empty;
    public string P256dh { get; set; } = string.Empty;
    public string Auth { get; set; } = string.Empty;
    public DateTime CreatedAtUtc { get; set; }
}

public sealed class PlatformModerationLogEntity
{
    public Guid Id { get; set; }
    public Guid ActorUserId { get; set; }
    public string Action { get; set; } = string.Empty;
    public string TargetType { get; set; } = string.Empty;
    public string TargetId { get; set; } = string.Empty;
    public string Details { get; set; } = string.Empty;
    public DateTime CreatedAtUtc { get; set; }
}

public sealed class MessageReportEntity
{
    public Guid Id { get; set; }
    public Guid MessageId { get; set; }
    public Guid ChannelId { get; set; }
    public Guid ReporterUserId { get; set; }
    public string Reason { get; set; } = string.Empty;
    /// <summary>pending | resolved | dismissed</summary>
    public string Status { get; set; } = "pending";
    public DateTime CreatedAtUtc { get; set; }
    public Guid? ResolvedByUserId { get; set; }
    public DateTime? ResolvedAtUtc { get; set; }
    public string ModeratorNote { get; set; } = string.Empty;
}

public sealed class UserActivityLogEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public UserEntity? User { get; set; }
    public string Action { get; set; } = string.Empty;
    public string Details { get; set; } = string.Empty;
    public string? IpAddress { get; set; }
    public DateTime CreatedAtUtc { get; set; }
}

public sealed class PlatformIpBanEntity
{
    public Guid Id { get; set; }
    public string IpAddress { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public Guid? BannedByUserId { get; set; }
    public UserEntity? BannedByUser { get; set; }
    public DateTime BannedAtUtc { get; set; }
    public DateTime? BannedUntilUtc { get; set; }
}
