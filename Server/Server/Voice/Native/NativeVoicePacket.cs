using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Sloncord.Voice.Native;

/// <summary>Binary UDP framing for Sloncord native voice (Opus payloads, server SFU forward).</summary>
internal static class NativeVoicePacket
{
    public const uint Magic = 0x534C4E56; // SLNV
    public const byte Version = 1;
    public const int HeaderSize = 24;

    public const byte KindAudio = 0;
    public const byte KindKeepAlive = 1;
    public const byte KindBind = 2;
    public const byte KindVideo = 3;
    public const byte KindVideoFrag = 4;
    public const byte KindScreenAudio = 5;

    public const int MaxPayloadLength = 1200;

    public static bool TryParse(ReadOnlySpan<byte> data, out NativeVoiceHeader header, out ReadOnlySpan<byte> payload)
    {
        header = default;
        payload = default;
        if (data.Length < HeaderSize) return false;

        var magic = BinaryPrimitives.ReadUInt32BigEndian(data[..4]);
        if (magic != Magic) return false;

        var version = data[4];
        if (version != Version) return false;

        var kind = data[5];
        var sessionId = BinaryPrimitives.ReadUInt16BigEndian(data[6..8]);
        var sequence = BinaryPrimitives.ReadUInt32BigEndian(data[8..12]);
        var timestampMs = BinaryPrimitives.ReadUInt32BigEndian(data[12..16]);
        var payloadLen = BinaryPrimitives.ReadUInt16BigEndian(data[16..18]);
        if (payloadLen > MaxPayloadLength) return false;
        if (data.Length < HeaderSize + payloadLen) return false;

        header = new NativeVoiceHeader(kind, sessionId, sequence, timestampMs, payloadLen);
        payload = data.Slice(HeaderSize, payloadLen);
        return true;
    }

    public static int WriteHeader(Span<byte> dest, byte kind, ushort sessionId, uint sequence, uint timestampMs, ushort payloadLen)
    {
        BinaryPrimitives.WriteUInt32BigEndian(dest[..4], Magic);
        dest[4] = Version;
        dest[5] = kind;
        BinaryPrimitives.WriteUInt16BigEndian(dest[6..8], sessionId);
        BinaryPrimitives.WriteUInt32BigEndian(dest[8..12], sequence);
        BinaryPrimitives.WriteUInt32BigEndian(dest[12..16], timestampMs);
        BinaryPrimitives.WriteUInt16BigEndian(dest[16..18], payloadLen);
        dest[18] = 0;
        dest[19] = 0;
        dest[20] = 0;
        dest[21] = 0;
        dest[22] = 0;
        dest[23] = 0;
        return HeaderSize;
    }

    public static byte[] CreateBindPayload(string sessionTokenHex)
    {
        var token = sessionTokenHex.Trim();
        if (token.Length % 2 != 0) throw new ArgumentException("bad token hex");
        var bytes = new byte[token.Length / 2];
        for (var i = 0; i < bytes.Length; i++)
            bytes[i] = Convert.ToByte(token.Substring(i * 2, 2), 16);
        return bytes;
    }

    public static ushort DeriveSessionId(Guid userId, string roomId)
    {
        var input = Encoding.UTF8.GetBytes($"{userId:N}:{roomId}");
        var hash = SHA256.HashData(input);
        return BinaryPrimitives.ReadUInt16BigEndian(hash.AsSpan(0, 2));
    }
}

internal readonly record struct NativeVoiceHeader(byte Kind, ushort SessionId, uint Sequence, uint TimestampMs, ushort PayloadLength);
