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
    public const byte KindScreenAudio = 5;
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

        if (cmd == "setMicGain" && runtime is not null)
        {
            var gain = doc.RootElement.TryGetProperty("gain", out var gEl) ? gEl.GetDouble() : 100;
            runtime.SetMicGain(gain);
            continue;
        }

        if (cmd == "setSpeakerGain" && runtime is not null)
        {
            var gain = doc.RootElement.TryGetProperty("gain", out var gEl) ? gEl.GetDouble() : 100;
            runtime.SetSpeakerGain(gain);
            continue;
        }

        if (cmd == "setAudioProcessing" && runtime is not null)
        {
            runtime.SetAudioProcessing(doc.RootElement);
            continue;
        }

        if (cmd == "setWatchScreen" && runtime is not null)
        {
            var sid = doc.RootElement.TryGetProperty("sessionId", out var sEl) && sEl.ValueKind == JsonValueKind.Number
                ? sEl.GetInt32()
                : 0;
            runtime.SetWatchScreen(sid);
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
    private OpusEncoder? _screenEncoder;
    private OpusDecoder? _screenDecoder;
    private Timer? _screenAudioTimer;
    private ushort _watchScreenSession;
    private uint _screenSeq;
    private CancellationTokenSource? _cts;
    private uint _seq;
    private readonly object _sync = new();
    private readonly List<short> _pcmQueue = new(4096);
    private readonly List<short> _screenMono = new(8192);
    private readonly object _screenLock = new();
    private readonly Dictionary<string, (byte Total, Dictionary<byte, byte[]> Parts, DateTime At)> _videoFrags = new();

    public bool Muted { get; set; }
    public bool Deafened { get; set; }
    private bool _echoCancellation = true;
    private bool _noiseSuppression = true;
    private int _noiseLevel = 40;
    private bool _autoSensitivity = true;
    private int _sensitivity = 50;
    private float _micGain = 1f;
    private float _speakerGain = 1f;
    private float _hpX;
    private float _hpY;
    private float _noiseFloor = 0.012f;
    private long _lastMeterTick;
    private bool _lastMeterSpeaking;

    private void EmitMeter(double rms, double threshold, bool speaking)
    {
        var now = Environment.TickCount64;
        if (now - _lastMeterTick < 80 && speaking == _lastMeterSpeaking) return;
        _lastMeterTick = now;
        _lastMeterSpeaking = speaking;
        _emit(new { type = "speaking", speaking, level = rms, threshold });
    }
    private readonly short[] _echoRing = new short[48000];
    private int _echoWrite;
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
        _screenEncoder = new OpusEncoder(48000, 1, OpusApplication.OPUS_APPLICATION_AUDIO);
        _screenDecoder = new OpusDecoder(48000, 1);
        _screenAudioTimer = new Timer(_ =>
        {
            try { PumpScreenAudio(); } catch { /* ignore */ }
        }, null, 20, 20);

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
    public void SetWatchScreen(int sessionId)
    {
        _watchScreenSession = sessionId is > 0 and <= 65535 ? (ushort)sessionId : (ushort)0;
    }

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

    private void PumpScreenAudio()
    {
        if (_screenEncoder is null || _udp is null || _remote is null) return;
        short[] frame;
        lock (_screenLock)
        {
            if (_screenMono.Count < 960) return;
            frame = _screenMono.GetRange(0, 960).ToArray();
            _screenMono.RemoveRange(0, 960);
        }
        var energy = 0;
        for (var i = 0; i < frame.Length; i++) energy = Math.Max(energy, Math.Abs(frame[i]));
        if (energy == 0) return;
        var opus = new byte[4000];
        var len = _screenEncoder.Encode(frame, 0, 960, opus, 0, opus.Length);
        if (len <= 0) return;
        var packet = BuildPacket(VoiceProtocol.KindScreenAudio, _sessionId, _screenSeq++, (uint)Environment.TickCount, opus.AsSpan(0, len).ToArray());
        try { _udp.Send(packet, packet.Length, _remote); } catch { /* ignore */ }
    }

    public void SetMicGain(double percent)
    {
        _micGain = Math.Clamp((float)(percent / 100.0), 0f, 2f);
    }

    public void SetSpeakerGain(double percent)
    {
        _speakerGain = Math.Clamp((float)(percent / 100.0), 0f, 2f);
    }

    public void SetAudioProcessing(JsonElement root)
    {
        if (root.TryGetProperty("echoCancellation", out var ec)) _echoCancellation = ec.GetBoolean();
        if (root.TryGetProperty("noiseSuppression", out var ns)) _noiseSuppression = ns.GetBoolean();
        if (root.TryGetProperty("noiseSuppressionLevel", out var lvl) && lvl.ValueKind == JsonValueKind.Number)
            _noiseLevel = (int)Math.Clamp(lvl.GetDouble(), 0, 100);
        if (root.TryGetProperty("inputSensitivityAuto", out var auto)) _autoSensitivity = auto.GetBoolean();
        if (root.TryGetProperty("inputSensitivity", out var sens) && sens.ValueKind == JsonValueKind.Number)
            _sensitivity = (int)Math.Clamp(sens.GetDouble(), 0, 100);
        if (root.TryGetProperty("micGain", out var mg) && mg.ValueKind == JsonValueKind.Number)
            SetMicGain(mg.GetDouble());
    }

    private short ProcessMicSample(short raw)
    {
        var x = raw * _micGain;
        var y = 0.96f * (_hpY + x - _hpX);
        _hpX = x;
        _hpY = y;
        if (y > 32767f) y = 32767f;
        if (y < -32768f) y = -32768f;
        return (short)y;
    }

    private void RememberEcho(short[] pcm, int count)
    {
        for (var i = 0; i < count; i++)
        {
            _echoRing[_echoWrite] = pcm[i];
            _echoWrite++;
            if (_echoWrite >= _echoRing.Length) _echoWrite = 0;
        }
    }

    private void CancelEcho(short[] mic, int samples)
    {
        if (!_echoCancellation || samples < 160) return;
        var best = 0;
        var bestLag = 480; // ~10 ms
        for (var lagMs = 0; lagMs <= 80; lagMs += 10)
        {
            var lag = 48 * lagMs;
            if (lag <= 0) lag = 48;
            var dot = 0;
            var n = Math.Min(160, samples);
            for (var i = 0; i < n; i++)
            {
                var idx = _echoWrite - lag - (n - i);
                while (idx < 0) idx += _echoRing.Length;
                dot += mic[i] * _echoRing[idx % _echoRing.Length];
            }
            if (dot > best)
            {
                best = dot;
                bestLag = lag;
            }
        }
        if (best < 2_000_000) return;
        for (var i = 0; i < samples; i++)
        {
            var idx = _echoWrite - bestLag - (samples - i);
            while (idx < 0) idx += _echoRing.Length;
            var echo = _echoRing[idx % _echoRing.Length];
            var v = mic[i] - (int)(echo * 0.55f);
            if (v > 32767) v = 32767;
            if (v < -32768) v = -32768;
            mic[i] = (short)v;
        }
    }

    private void SuppressNoise(short[] mic, int samples)
    {
        if (!_noiseSuppression || _noiseLevel <= 0) return;
        double energy = 0;
        for (var i = 0; i < samples; i++) energy += mic[i] * (double)mic[i];
        var rms = Math.Sqrt(energy / Math.Max(1, samples)) / 32768.0;
        var strength = _noiseLevel / 100f;
        var gate = _noiseFloor * (1.2f + strength * 3.5f);
        if (rms < gate)
        {
            var keep = Math.Max(0.04f, 1f - strength);
            for (var i = 0; i < samples; i++) mic[i] = (short)(mic[i] * keep);
        }
    }

    private void OnCapture(byte[] buffer, int count)
    {
        if (_encoder is null || _udp is null || _remote is null) return;
        var samples = count / 2;
        if (samples <= 0) return;
        if (Muted)
        {
            EmitMeter(0, _noiseFloor, false);
            return;
        }

        var mic = new short[samples];
        double energy = 0;
        for (var i = 0; i < samples; i++)
        {
            var s = Muted ? (short)0 : ProcessMicSample(BitConverter.ToInt16(buffer, i * 2));
            mic[i] = s;
            energy += s * (double)s;
        }
        var rms = Math.Sqrt(energy / samples) / 32768.0;
        if (rms < _noiseFloor * 1.6) _noiseFloor = (float)(_noiseFloor * 0.96 + rms * 0.04);
        else _noiseFloor = (float)(_noiseFloor * 0.995 + rms * 0.005);
        if (_noiseFloor < 0.003f) _noiseFloor = 0.003f;
        if (_noiseFloor > 0.08f) _noiseFloor = 0.08f;

        if (!Muted)
        {
            CancelEcho(mic, samples);
            SuppressNoise(mic, samples);
            energy = 0;
            for (var i = 0; i < samples; i++) energy += mic[i] * (double)mic[i];
            rms = Math.Sqrt(energy / samples) / 32768.0;
        }

        var threshold = _autoSensitivity
            ? Math.Max(0.01, _noiseFloor * 2.4)
            : 0.006 + (_sensitivity / 100.0) * 0.09;
        var speakingNow = !Muted && rms > threshold;
        EmitMeter(rms, threshold, speakingNow);

        for (var i = 0; i < samples; i++) _pcmQueue.Add(mic[i]);

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
            if (kind == VoiceProtocol.KindScreenAudio)
            {
                if (Deafened || _watchScreenSession == 0 || _screenDecoder is null || _playBuffer is null)
                    continue;
                var screenPcm = new short[960 * 6];
                var screenDecoded = _screenDecoder.Decode(payload, 0, payload.Length, screenPcm, 0, screenPcm.Length, false);
                if (screenDecoded <= 0) continue;
                if (Math.Abs(_speakerGain - 1f) > 0.01f)
                {
                    for (var i = 0; i < screenDecoded; i++)
                    {
                        var v = (int)(screenPcm[i] * _speakerGain);
                        if (v > 32767) v = 32767;
                        if (v < -32768) v = -32768;
                        screenPcm[i] = (short)v;
                    }
                }
                RememberEcho(screenPcm, screenDecoded);
                var screenBytes = new byte[screenDecoded * 2];
                Buffer.BlockCopy(screenPcm, 0, screenBytes, 0, screenBytes.Length);
                lock (_sync)
                {
                    _playBuffer.AddSamples(screenBytes, 0, screenBytes.Length);
                }
                continue;
            }
            if (kind != VoiceProtocol.KindAudio || Deafened) continue;
            if (sessionId == _sessionId) continue;
            var pcm = new short[960 * 6];
            var decoded = _decoder.Decode(payload, 0, payload.Length, pcm, 0, pcm.Length, false);
            if (decoded <= 0) continue;
            if (Math.Abs(_speakerGain - 1f) > 0.01f)
            {
                for (var i = 0; i < decoded; i++)
                {
                    var v = (int)(pcm[i] * _speakerGain);
                    if (v > 32767) v = 32767;
                    if (v < -32768) v = -32768;
                    pcm[i] = (short)v;
                }
            }
            RememberEcho(pcm, decoded);
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
        try { _screenAudioTimer?.Dispose(); } catch { /* ignore */ }
        _screenAudioTimer = null;
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
