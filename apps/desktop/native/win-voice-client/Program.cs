using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Concentus.Enums;
using Concentus.Structs;
using NAudio.CoreAudioApi;
using NAudio.Wave;
using NAudio.Wasapi;

namespace SloncordNativeVoice;

internal static class VoiceProtocol
{
    public const uint Magic = 0x534C4E56;
    public const byte Version = 1;
    public const byte KindAudio = 0;
    public const byte KindBind = 2;
    public const byte KindVideo = 3;
    public const byte KindVideoFrag = 4;
    public const int MaxPayload = 1200;
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static async Task Main()
    {
        var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        VoiceRuntime? runtime = null;

        while (true)
        {
            var line = await reader.ReadLineAsync();
            if (line is null) break;
            if (string.IsNullOrWhiteSpace(line)) continue;

            JsonDocument doc;
            try { doc = JsonDocument.Parse(line); }
            catch { continue; }

            using (doc)
            {
                if (!doc.RootElement.TryGetProperty("cmd", out var cmdEl)) continue;
                var cmd = cmdEl.GetString() ?? "";
                if (cmd == "stop")
                {
                    if (runtime is not null)
                    {
                        await runtime.StopAsync();
                        runtime = null;
                    }
                    continue;
                }

                if (cmd == "setMuted" && runtime is not null)
                {
                    runtime.Muted = doc.RootElement.TryGetProperty("muted", out var m) && m.GetBoolean();
                    continue;
                }

        if (cmd == "setDeafened" && runtime is not null)
        {
            runtime.Deafened = doc.RootElement.TryGetProperty("deafened", out var d) && d.GetBoolean();
            continue;
        }

        if (cmd == "setInputDevice" && runtime is not null)
        {
            var id = doc.RootElement.TryGetProperty("deviceId", out var dEl) ? dEl.GetString() : null;
            runtime.SetInputDeviceId(id);
            continue;
        }

        if (cmd == "setOutputDevice" && runtime is not null)
        {
            var id = doc.RootElement.TryGetProperty("deviceId", out var dEl) ? dEl.GetString() : null;
            runtime.SetOutputDeviceId(id);
            continue;
        }

        if (cmd == "videoFrame" && runtime is not null)
        {
            var b64 = doc.RootElement.TryGetProperty("jpegBase64", out var jEl) ? jEl.GetString() : null;
            if (!string.IsNullOrWhiteSpace(b64))
            {
                try { runtime.SendVideoJpeg(Convert.FromBase64String(b64)); } catch { /* ignore */ }
            }
            continue;
        }

        if (cmd == "mixScreenPcm" && runtime is not null)
        {
            var b64 = doc.RootElement.TryGetProperty("pcmBase64", out var pEl) ? pEl.GetString() : null;
            if (!string.IsNullOrWhiteSpace(b64))
            {
                try { runtime.PushScreenStereo(Convert.FromBase64String(b64)); } catch { /* ignore */ }
            }
            continue;
        }

        if (cmd == "clearScreenPcm" && runtime is not null)
        {
            runtime.ClearScreenPcm();
            continue;
        }

        if (cmd == "start")
                {
                    if (runtime is not null) await runtime.StopAsync();
                    var cfg = doc.RootElement;
                    runtime = new VoiceRuntime(
                        cfg.GetProperty("udpHost").GetString() ?? "127.0.0.1",
                        cfg.GetProperty("udpPort").GetInt32(),
                        cfg.GetProperty("sessionToken").GetString() ?? "",
                        (ushort)cfg.GetProperty("sessionId").GetInt32(),
                        Emit);
                    runtime.Muted = cfg.TryGetProperty("muted", out var mu) && mu.GetBoolean();
                    runtime.Deafened = cfg.TryGetProperty("deafened", out var de) && de.GetBoolean();
                    try { await runtime.StartAsync(); }
                    catch (Exception ex) { Emit(new { type = "error", message = ex.Message }); }
                }
            }
        }

        if (runtime is not null) await runtime.StopAsync();
    }

    private static void Emit(object obj) => Console.WriteLine(JsonSerializer.Serialize(obj, JsonOpts));
}

internal sealed class VoiceRuntime
{
    private readonly string _host;
    private readonly int _port;
    private readonly string _sessionTokenHex;
    private readonly ushort _sessionId;
    private readonly Action<object> _emit;
    private UdpClient? _udp;
    private IPEndPoint? _remote;
    private WaveInEvent? _waveIn;
    private Timer? _silencePump;
    private bool _stopping;
    private readonly byte[] _silence20ms = new byte[1920];
    private IWavePlayer? _waveOut;
    private BufferedWaveProvider? _playBuffer;
    private OpusEncoder? _encoder;
    private OpusDecoder? _decoder;
    private CancellationTokenSource? _cts;
    private uint _seq;
    private readonly object _sync = new();
    private readonly List<short> _pcmQueue = new(4096);
    private readonly List<short> _screenMono = new(8192);
    private readonly object _screenLock = new();
    private readonly Dictionary<string, (byte Total, Dictionary<byte, byte[]> Parts, DateTime At)> _videoFrags = new();

    public bool Muted { get; set; }
    public bool Deafened { get; set; }
    private string? _inputDeviceId;
    private string? _outputDeviceId;
    private int _inputDeviceIndex;
    private int _outputDeviceIndex;

    public VoiceRuntime(string host, int port, string sessionTokenHex, ushort sessionId, Action<object> emit)
    {
        _host = host;
        _port = port;
        _sessionTokenHex = sessionTokenHex;
        _sessionId = sessionId;
        _emit = emit;
    }

    public async Task StartAsync()
    {
        _cts = new CancellationTokenSource();
        _udp = new UdpClient();
        _remote = new IPEndPoint(IPAddress.Parse(_host), _port);
        _encoder = new OpusEncoder(48000, 1, OpusApplication.OPUS_APPLICATION_VOIP);
        _decoder = new OpusDecoder(48000, 1);

        await SendBindAsync();

        _playBuffer = new BufferedWaveProvider(new WaveFormat(48000, 16, 1))
        {
            BufferDuration = TimeSpan.FromMilliseconds(500),
            DiscardOnBufferOverflow = true
        };
        _waveOut = CreateOutputDevice(_outputDeviceId);
        try
        {
            _waveOut.Init(_playBuffer);
            _waveOut.Play();
        }
        catch
        {
            try { _waveOut.Dispose(); } catch { /* ignore */ }
            _waveOut = null;
        }

        _outputDeviceIndex = ResolveWaveOutIndex(_outputDeviceId);
        TryStartMicrophone();

        _ = Task.Run(() => ReceiveLoop(_cts.Token));
        _emit(new { type = "ready" });
    }

    private async Task SendBindAsync()
    {
        var tokenBytes = Convert.FromHexString(_sessionTokenHex);
        var packet = BuildPacket(VoiceProtocol.KindBind, _sessionId, _seq++, 0, tokenBytes);
        if (_udp is null || _remote is null) return;
        await _udp.SendAsync(packet, packet.Length, _remote);
    }

    /// <summary>s16le stereo (обычно 48 kHz с WASAPI process-loopback) → моно в очередь микса.</summary>
    public void PushScreenStereo(byte[] pcm)
    {
        if (pcm.Length < 4) return;
        var frames = pcm.Length / 4;
        lock (_screenLock)
        {
            for (var i = 0; i < frames; i++)
            {
                var l = BitConverter.ToInt16(pcm, i * 4);
                var r = BitConverter.ToInt16(pcm, i * 4 + 2);
                _screenMono.Add((short)((l + r) / 2));
            }
            const int cap = 48000;
            if (_screenMono.Count > cap)
                _screenMono.RemoveRange(0, _screenMono.Count - cap);
        }
    }

    public void ClearScreenPcm()
    {
        lock (_screenLock) _screenMono.Clear();
    }

    private void PullScreen(short[] dst)
    {
        lock (_screenLock)
        {
            var n = Math.Min(dst.Length, _screenMono.Count);
            for (var i = 0; i < n; i++) dst[i] = _screenMono[i];
            if (n > 0) _screenMono.RemoveRange(0, n);
            for (var i = n; i < dst.Length; i++) dst[i] = 0;
        }
    }

    private void OnCapture(byte[] buffer, int count)
    {
        if (_encoder is null || _udp is null || _remote is null) return;
        var samples = count / 2;
        if (samples <= 0) return;
        var screen = new short[samples];
        PullScreen(screen);
        var screenEnergy = 0;
        for (var i = 0; i < samples; i++) screenEnergy = Math.Max(screenEnergy, Math.Abs(screen[i]));
        if (Muted && screenEnergy == 0) return;

        var micPeak = 0;
        for (var i = 0; i < samples; i++)
        {
            var mic = Muted ? (short)0 : BitConverter.ToInt16(buffer, i * 2);
            if (!Muted) micPeak = Math.Max(micPeak, Math.Abs(mic));
            var mixed = mic + screen[i];
            if (mixed > 32767) mixed = 32767;
            if (mixed < -32768) mixed = -32768;
            _pcmQueue.Add((short)mixed);
        }

        var level = Math.Min(1.0, micPeak / 8000.0);
        _emit(new { type = "speaking", speaking = !Muted && level > 0.02, level });

        const int frameSize = 960;
        while (_pcmQueue.Count >= frameSize)
        {
            var frame = _pcmQueue.GetRange(0, frameSize).ToArray();
            _pcmQueue.RemoveRange(0, frameSize);
            var opus = new byte[4000];
            var len = _encoder.Encode(frame, 0, frameSize, opus, 0, opus.Length);
            if (len <= 0) continue;
            var payload = opus.AsSpan(0, len).ToArray();
            var packet = BuildPacket(VoiceProtocol.KindAudio, _sessionId, _seq++, (uint)Environment.TickCount, payload);
            try { _udp.Send(packet, packet.Length, _remote); } catch { /* ignore */ }
        }
    }

    private async Task ReceiveLoop(CancellationToken ct)
    {
        if (_udp is null || _decoder is null || _playBuffer is null) return;
        while (!ct.IsCancellationRequested)
        {
            UdpReceiveResult res;
            try { res = await _udp.ReceiveAsync(ct); }
            catch { break; }

            if (!TryParse(res.Buffer, out var kind, out var sessionId, out var sequence, out var payload)) continue;
            if (kind is VoiceProtocol.KindVideo or VoiceProtocol.KindVideoFrag)
            {
                HandleRemoteVideo(sessionId, sequence, kind, payload);
                continue;
            }
            if (kind != VoiceProtocol.KindAudio || Deafened) continue;
            if (sessionId == _sessionId) continue;
            var pcm = new short[960 * 6];
            var decoded = _decoder.Decode(payload, 0, payload.Length, pcm, 0, pcm.Length, false);
            if (decoded <= 0) continue;
            var bytes = new byte[decoded * 2];
            Buffer.BlockCopy(pcm, 0, bytes, 0, bytes.Length);
            lock (_sync)
            {
                _playBuffer.AddSamples(bytes, 0, bytes.Length);
            }
        }
    }

    public void SetInputDeviceId(string? deviceId)
    {
        _inputDeviceId = deviceId;
        TryStartMicrophone();
    }

    /// <summary>
    /// Нет микрофона — не ошибка: остаёмся в канале, слушаем и микшируем звук демонстрации тишиной.
    /// </summary>
    private bool TryStartMicrophone()
    {
        var count = 0;
        try { count = WaveInEvent.DeviceCount; } catch { count = 0; }
        if (count <= 0)
        {
            ReleaseMicrophone();
            StartSilencePump();
            return false;
        }

        var idx = ResolveWaveInIndex(_inputDeviceId);
        if (idx < 0 || idx >= count) idx = 0;
        if (_waveIn is not null && _silencePump is null && _inputDeviceIndex == idx) return true;

        ReleaseMicrophone();
        StopSilencePump();
        try
        {
            var waveIn = new WaveInEvent
            {
                DeviceNumber = idx,
                WaveFormat = new WaveFormat(48000, 16, 1),
                BufferMilliseconds = 20
            };
            waveIn.DataAvailable += (_, e) => OnCapture(e.Buffer, e.BytesRecorded);
            waveIn.RecordingStopped += (_, _) =>
            {
                if (_stopping || !ReferenceEquals(_waveIn, waveIn)) return;
                ReleaseMicrophone();
                StartSilencePump();
            };
            waveIn.StartRecording();
            _waveIn = waveIn;
            _inputDeviceIndex = idx;
            return true;
        }
        catch
        {
            ReleaseMicrophone();
            StartSilencePump();
            return false;
        }
    }

    private void ReleaseMicrophone()
    {
        var waveIn = _waveIn;
        _waveIn = null;
        try { waveIn?.StopRecording(); } catch { /* ignore */ }
        try { waveIn?.Dispose(); } catch { /* ignore */ }
    }

    private void StartSilencePump()
    {
        if (_silencePump is not null || _stopping) return;
        _silencePump = new Timer(_ =>
        {
            try { OnCapture(_silence20ms, _silence20ms.Length); } catch { /* ignore */ }
        }, null, 20, 20);
    }

    private void StopSilencePump()
    {
        var pump = _silencePump;
        _silencePump = null;
        try { pump?.Dispose(); } catch { /* ignore */ }
    }

    public void SetOutputDeviceId(string? deviceId)
    {
        _outputDeviceId = deviceId;
        if (_playBuffer is null) return;
        try
        {
            _waveOut?.Stop();
            _waveOut?.Dispose();
        }
        catch { /* ignore */ }
        _waveOut = CreateOutputDevice(deviceId);
        _waveOut.Init(_playBuffer);
        _waveOut.Play();
    }

    public void SendVideoJpeg(byte[] jpeg)
    {
        if (_udp is null || _remote is null || jpeg.Length == 0) return;
        const int chunkMax = VoiceProtocol.MaxPayload - 2;
        var count = (jpeg.Length + chunkMax - 1) / chunkMax;
        if (count <= 0 || count > 255) return;
        // Один номер кадра на все куски, иначе приёмник никогда не собирает картинку и копит буферы.
        var frameSeq = _seq++;
        var tick = (uint)Environment.TickCount;
        for (var i = 0; i < count; i++)
        {
            var offset = i * chunkMax;
            var len = Math.Min(chunkMax, jpeg.Length - offset);
            var payload = new byte[2 + len];
            payload[0] = (byte)i;
            payload[1] = (byte)count;
            Buffer.BlockCopy(jpeg, offset, payload, 2, len);
            var kind = count == 1 ? VoiceProtocol.KindVideo : VoiceProtocol.KindVideoFrag;
            var packet = BuildPacket(kind, _sessionId, frameSeq, tick, payload);
            try { _udp.Send(packet, packet.Length, _remote); } catch { /* ignore */ }
        }
    }

    private void PurgeVideoFrags()
    {
        if (_videoFrags.Count == 0) return;
        var now = DateTime.UtcNow;
        List<string>? stale = null;
        foreach (var kv in _videoFrags)
        {
            if ((now - kv.Value.At).TotalSeconds > 2)
            {
                stale ??= new List<string>();
                stale.Add(kv.Key);
            }
        }
        if (stale is not null)
        {
            foreach (var key in stale) _videoFrags.Remove(key);
        }
        if (_videoFrags.Count > 24) _videoFrags.Clear();
    }

    private void HandleRemoteVideo(ushort sessionId, uint sequence, byte kind, byte[] payload)
    {
        PurgeVideoFrags();
        byte[]? jpeg = null;
        if (kind == VoiceProtocol.KindVideo)
        {
            jpeg = payload;
        }
        else if (kind == VoiceProtocol.KindVideoFrag && payload.Length >= 2)
        {
            var fragIndex = payload[0];
            var fragCount = payload[1];
            if (fragCount == 0) return;
            var body = payload.AsSpan(2).ToArray();
            var key = $"{sessionId}:{sequence}";
            if (!_videoFrags.TryGetValue(key, out var entry))
            {
                entry = (fragCount, new Dictionary<byte, byte[]>(), DateTime.UtcNow);
                _videoFrags[key] = entry;
            }
            entry.Parts[fragIndex] = body;
            if (entry.Parts.Count < fragCount) return;
            using var ms = new MemoryStream();
            for (byte f = 0; f < fragCount; f++)
            {
                if (!entry.Parts.TryGetValue(f, out var part)) return;
                ms.Write(part, 0, part.Length);
            }
            _videoFrags.Remove(key);
            jpeg = ms.ToArray();
        }
        if (jpeg is null || jpeg.Length == 0) return;
        _emit(new { type = "remoteVideo", sessionId, jpegBase64 = Convert.ToBase64String(jpeg) });
    }

    private IWavePlayer CreateOutputDevice(string? deviceId)
    {
        try
        {
            var dev = ResolveWasapiRenderDevice(deviceId);
            if (dev is not null) return new WasapiOut(dev, AudioClientShareMode.Shared, false, 50);
        }
        catch { /* fallback */ }
        return new WaveOutEvent { DeviceNumber = 0 };
    }

    private static MMDevice? ResolveWasapiRenderDevice(string? deviceId)
    {
        using var enumerator = new MMDeviceEnumerator();
        var ends = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
        if (string.IsNullOrWhiteSpace(deviceId)) return ends.FirstOrDefault();
        var key = deviceId.Trim();
        foreach (var d in ends)
        {
            if (key.Equals(d.ID, StringComparison.OrdinalIgnoreCase)) return d;
            if (d.FriendlyName.Contains(key, StringComparison.OrdinalIgnoreCase)) return d;
            if (key.Contains(d.FriendlyName, StringComparison.OrdinalIgnoreCase)) return d;
        }
        return ends.FirstOrDefault();
    }

    private static int ResolveWaveInIndex(string? deviceId)
    {
        if (string.IsNullOrWhiteSpace(deviceId)) return 0;
        var key = deviceId.Trim();
        for (var i = 0; i < WaveInEvent.DeviceCount; i++)
        {
            var cap = WaveInEvent.GetCapabilities(i);
            if (key.Equals(cap.ProductGuid.ToString(), StringComparison.OrdinalIgnoreCase)) return i;
            if (cap.ProductName.Contains(key, StringComparison.OrdinalIgnoreCase)) return i;
            if (key.Contains(cap.ProductName, StringComparison.OrdinalIgnoreCase)) return i;
        }
        return 0;
    }

    private static int ResolveWaveOutIndex(string? deviceId)
    {
        // WaveOutEvent uses WinMM device order; fine-grained WASAPI output routing — later.
        if (string.IsNullOrWhiteSpace(deviceId)) return 0;
        return 0;
    }

    public Task StopAsync()
    {
        _stopping = true;
        try { _cts?.Cancel(); } catch { /* ignore */ }
        StopSilencePump();
        ReleaseMicrophone();
        try { _waveOut?.Stop(); } catch { /* ignore */ }
        try { _waveOut?.Dispose(); } catch { /* ignore */ }
        try { _udp?.Dispose(); } catch { /* ignore */ }
        _waveIn = null;
        _waveOut = null;
        _udp = null;
        return Task.CompletedTask;
    }

    private static byte[] BuildPacket(byte kind, ushort sessionId, uint sequence, uint ts, byte[] payload)
    {
        var buf = new byte[24 + payload.Length];
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(0, 4), VoiceProtocol.Magic);
        buf[4] = VoiceProtocol.Version;
        buf[5] = kind;
        BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(6, 2), sessionId);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(8, 4), sequence);
        BinaryPrimitives.WriteUInt32BigEndian(buf.AsSpan(12, 4), ts);
        BinaryPrimitives.WriteUInt16BigEndian(buf.AsSpan(16, 2), (ushort)payload.Length);
        payload.CopyTo(buf, 24);
        return buf;
    }

    private static bool TryParse(byte[] data, out byte kind, out ushort sessionId, out uint sequence, out byte[] payload)
    {
        kind = 0;
        sessionId = 0;
        sequence = 0;
        payload = Array.Empty<byte>();
        if (data.Length < 24) return false;
        if (BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(0, 4)) != VoiceProtocol.Magic) return false;
        if (data[4] != VoiceProtocol.Version) return false;
        kind = data[5];
        sessionId = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(6, 2));
        sequence = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(8, 4));
        var len = BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(16, 2));
        if (len > VoiceProtocol.MaxPayload) return false;
        if (data.Length < 24 + len) return false;
        payload = data.AsSpan(24, len).ToArray();
        return true;
    }
}
