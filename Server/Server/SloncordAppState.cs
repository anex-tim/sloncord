namespace Sloncord;

internal sealed record SloncordAppState(
    string DataDir,
    string StorageDir,
    VapidKeyStore Vapid,
    WebPushSender Push,
    VoiceSignalingServer Voice,
    SloncordRealtime Realtime);
