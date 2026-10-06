namespace Sloncord.Voice;

internal static class VoiceRoomHelper
{
    public static bool TryParseChannelRoom(string roomId, out Guid channelId)
    {
        channelId = Guid.Empty;
        if (string.IsNullOrWhiteSpace(roomId)) return false;
        if (!roomId.StartsWith("channel:", StringComparison.OrdinalIgnoreCase)) return false;
        var s = roomId["channel:".Length..].Trim();
        return Guid.TryParse(s, out channelId);
    }
}
