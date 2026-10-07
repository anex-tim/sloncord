#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <inspectable.h>
#include <avrt.h>
#include <propvarutil.h>
#include <stdint.h>
#include <stdio.h>
#include <string>
#include <vector>
#include <set>

// SloncordWinAudioHelper.exe
// - window mode: capture ONLY target process tree audio (application loopback)
// - screen mode + excludeTargetPid: system loopback EXCLUDING Sloncord process tree
// - screen-dual + excludeTargetPid: full device loopback MINUS Sloncord process tree (synced fallback)
// - screen mode + excludePid list: full loopback minus per-process subtract (legacy fallback)
//
// Output: length-prefixed chunks (u32 byteLen + payload bytes) of s16le stereo PCM.

struct Args {
  std::wstring pipeName;
  std::string mode; // "screen" | "window"
  DWORD targetPid = 0;
  unsigned long long targetHwnd = 0;
  DWORD excludeTargetPid = 0;
  std::set<DWORD> excludePids;
};

static std::wstring to_wstr(const std::string& s) {
  if (s.empty()) return L"";
  int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring out;
  out.resize(len);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), out.data(), len);
  return out;
}

static void write_u32(HANDLE h, uint32_t v) {
  DWORD w = 0;
  WriteFile(h, &v, sizeof(v), &w, nullptr);
}

static void write_bytes(HANDLE h, const void* p, uint32_t len) {
  DWORD w = 0;
  WriteFile(h, p, len, &w, nullptr);
}

static Args parse_args(int argc, char** argv) {
  Args a;
  for (int i = 1; i < argc; i++) {
    std::string k = argv[i] ? argv[i] : "";
    auto next = [&]() -> std::string {
      if (i + 1 >= argc) return "";
      i += 1;
      return argv[i] ? argv[i] : "";
    };
    if (k == "--pipe") a.pipeName = to_wstr(next());
    else if (k == "--mode") a.mode = next();
    else if (k == "--targetPid") a.targetPid = (DWORD)strtoul(next().c_str(), nullptr, 10);
    else if (k == "--targetHwnd") a.targetHwnd = (unsigned long long)_strtoui64(next().c_str(), nullptr, 10);
    else if (k == "--excludeTargetPid") a.excludeTargetPid = (DWORD)strtoul(next().c_str(), nullptr, 10);
    else if (k == "--excludePid") a.excludePids.insert((DWORD)strtoul(next().c_str(), nullptr, 10));
  }
  return a;
}

struct Capture {
  IAudioClient* ac = nullptr;
  IAudioCaptureClient* cap = nullptr;
  WAVEFORMATEX* wf = nullptr;
  HANDLE evt = nullptr;
};

static void log_hr(const char* step, HRESULT hr);
static WAVEFORMATEX* alloc_pcm16_stereo_48k();

static bool finish_loopback_client(IAudioClient* ac, WAVEFORMATEX* mix, bool useEvent, Capture& result) {
  HANDLE evt = nullptr;
  if (useEvent) {
    evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!evt) return false;
    HRESULT hr = ac->SetEventHandle(evt);
    if (FAILED(hr)) {
      CloseHandle(evt);
      log_hr("loopback.SetEventHandle", hr);
      return false;
    }
  }
  IAudioCaptureClient* cap = nullptr;
  HRESULT hr = ac->GetService(__uuidof(IAudioCaptureClient), (void**)&cap);
  if (FAILED(hr) || !cap) {
    if (evt) CloseHandle(evt);
    log_hr("loopback.GetService", FAILED(hr) ? hr : E_FAIL);
    return false;
  }
  result.ac = ac;
  result.cap = cap;
  result.wf = mix;
  result.evt = evt;
  return true;
}

static bool init_loopback_default(IMMDevice* device, Capture& result) {
  struct Attempt {
    const char* name;
    DWORD flags;
    REFERENCE_TIME dur;
    bool fixedPcm;
    bool useEvent;
  };
  const Attempt attempts[] = {
    { "mix-poll-0", AUDCLNT_STREAMFLAGS_LOOPBACK, 0, false, false },
    { "mix-evt-0", AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 0, false, true },
    { "mix-evt-20ms", AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 20 * 10000, false, true },
    { "mix-poll-20ms", AUDCLNT_STREAMFLAGS_LOOPBACK, 20 * 10000, false, false },
    { "pcm-evt-0", AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 0, true, true },
  };

  for (const Attempt& a : attempts) {
    IAudioClient* ac = nullptr;
    HRESULT hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&ac);
    if (FAILED(hr) || !ac) {
      log_hr("loopback.Activate", FAILED(hr) ? hr : E_FAIL);
      continue;
    }
    WAVEFORMATEX* mix = nullptr;
    if (a.fixedPcm) {
      mix = alloc_pcm16_stereo_48k();
    } else {
      hr = ac->GetMixFormat(&mix);
    }
    if (!mix) {
      ac->Release();
      continue;
    }
    GUID session = {};
    hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, a.flags, a.dur, 0, mix, &session);
    if (hr == 0x88890019 /* AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED */) {
      REFERENCE_TIME defPeriod = 0, minPeriod = 0;
      REFERENCE_TIME aligned = 0;
      if (SUCCEEDED(ac->GetDevicePeriod(&defPeriod, &minPeriod)) && defPeriod > 0) aligned = defPeriod;
      ac->Release();
      CoTaskMemFree(mix);
      if (aligned <= 0) continue;
      hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&ac);
      if (FAILED(hr) || !ac) continue;
      mix = a.fixedPcm ? alloc_pcm16_stereo_48k() : nullptr;
      if (!a.fixedPcm) {
        if (FAILED(ac->GetMixFormat(&mix)) || !mix) { ac->Release(); continue; }
      }
      hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, a.flags, aligned, 0, mix, &session);
    }
    if (FAILED(hr)) {
      log_hr(a.name, hr);
      CoTaskMemFree(mix);
      ac->Release();
      continue;
    }
    if (!finish_loopback_client(ac, mix, a.useEvent, result)) {
      CoTaskMemFree(mix);
      ac->Release();
      continue;
    }
    fprintf(stderr, "sloncord-audio system=%s\n", a.name);
    return true;
  }
  return false;
}

static void capture_close(Capture& c) {
  try { if (c.ac) c.ac->Stop(); } catch (...) {}
  if (c.cap) { c.cap->Release(); c.cap = nullptr; }
  if (c.ac) { c.ac->Release(); c.ac = nullptr; }
  if (c.wf) { CoTaskMemFree(c.wf); c.wf = nullptr; }
  if (c.evt) { CloseHandle(c.evt); c.evt = nullptr; }
}

struct ActivateResult : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
  HANDLE done = nullptr;
  HRESULT hr = E_FAIL;
  IAudioClient* client = nullptr;
  LONG ref = 1;
  ActivateResult() { done = CreateEventW(nullptr, FALSE, FALSE, nullptr); }
  virtual ~ActivateResult() { if (done) CloseHandle(done); if (client) client->Release(); }
  ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)InterlockedIncrement(&ref); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = (ULONG)InterlockedDecrement(&ref);
    return r;
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    // Windows 11 returns E_ILLEGAL_METHOD_CALL unless the handler is agile.
    if (riid == __uuidof(IAgileObject)) {
      *ppv = static_cast<IAgileObject*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    if (!operation) return E_POINTER;
    IUnknown* unk = nullptr;
    operation->GetActivateResult(&hr, &unk);
    if (SUCCEEDED(hr) && unk) {
      unk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
      unk->Release();
    }
    SetEvent(done);
    return S_OK;
  }
};

static void log_hr(const char* step, HRESULT hr) {
  fprintf(stderr, "sloncord-audio %s hr=0x%08lX\n", step, (unsigned long)hr);
}

static IAudioClient* activate_process_loopback(DWORD targetPid, PROCESS_LOOPBACK_MODE mode, HRESULT* outHr) {
  auto* act = (AUDIOCLIENT_ACTIVATION_PARAMS*)CoTaskMemAlloc(sizeof(AUDIOCLIENT_ACTIVATION_PARAMS));
  if (!act) {
    if (outHr) *outHr = E_OUTOFMEMORY;
    return nullptr;
  }
  ZeroMemory(act, sizeof(*act));
  act->ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  act->ProcessLoopbackParams.TargetProcessId = targetPid;
  act->ProcessLoopbackParams.ProcessLoopbackMode = mode;

  PROPVARIANT pv;
  PropVariantInit(&pv);
  pv.vt = VT_BLOB;
  pv.blob.cbSize = sizeof(*act);
  pv.blob.pBlobData = reinterpret_cast<BYTE*>(act);

  ActivateResult handler;
  IActivateAudioInterfaceAsyncOperation* op = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    __uuidof(IAudioClient),
    &pv,
    &handler,
    &op
  );
  if (FAILED(hr) || !op) {
    CoTaskMemFree(act);
    if (outHr) *outHr = FAILED(hr) ? hr : E_FAIL;
    log_hr("ActivateAudioInterfaceAsync", FAILED(hr) ? hr : E_FAIL);
    return nullptr;
  }
  // STA needs a message pump; MTA completes on the event. Pump both ways.
  const DWORD waitStart = GetTickCount();
  while (true) {
    DWORD elapsed = GetTickCount() - waitStart;
    if (elapsed >= 8000) break;
    DWORD wr = MsgWaitForMultipleObjects(1, &handler.done, FALSE, 8000 - elapsed, QS_ALLINPUT);
    if (wr == WAIT_OBJECT_0) break;
    if (wr == WAIT_OBJECT_0 + 1) {
      MSG msg;
      while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      }
      continue;
    }
    break;
  }
  op->Release();
  CoTaskMemFree(act);
  if (outHr) *outHr = handler.hr;
  if (FAILED(handler.hr) || !handler.client) return nullptr;
  IAudioClient* client = handler.client;
  handler.client = nullptr;
  return client;
}

static bool bind_capture_client(IAudioClient* client, WAVEFORMATEX* mix, Capture& result) {
  HANDLE evt = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!evt) return false;
  HRESULT hr = client->SetEventHandle(evt);
  if (FAILED(hr)) { CloseHandle(evt); return false; }
  IAudioCaptureClient* cap = nullptr;
  hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&cap);
  if (FAILED(hr) || !cap) { CloseHandle(evt); return false; }
  result.ac = client;
  result.cap = cap;
  result.wf = mix;
  result.evt = evt;
  return true;
}

// Windows 11 24H2/26H2 often rejects IAudioClient3 periods on the virtual process-loopback device.
// A fresh activation + IAudioClient::Initialize still captures the same exclude/include tree.
static bool init_with_audio_client3(IAudioClient* client, Capture& result) {
  IAudioClient3* ac3 = nullptr;
  HRESULT hr = client->QueryInterface(__uuidof(IAudioClient3), (void**)&ac3);
  if (FAILED(hr) || !ac3) return false;
  WAVEFORMATEX* mix = nullptr;
  UINT32 curPeriod = 0;
  hr = ac3->GetCurrentSharedModeEnginePeriod(&mix, &curPeriod);
  if (FAILED(hr) || !mix) { ac3->Release(); return false; }
  UINT32 defP = 0, fundP = 0, minP = 0, maxP = 0;
  hr = ac3->GetSharedModeEnginePeriod(mix, &defP, &fundP, &minP, &maxP);
  if (FAILED(hr)) { CoTaskMemFree(mix); ac3->Release(); return false; }
  UINT32 period = minP ? minP : (defP ? defP : 480);
  hr = ac3->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, mix, nullptr);
  ac3->Release();
  if (FAILED(hr)) {
    log_hr("IAudioClient3.InitializeSharedAudioStream", hr);
    CoTaskMemFree(mix);
    return false;
  }
  if (!bind_capture_client(client, mix, result)) { CoTaskMemFree(mix); return false; }
  return true;
}

static WAVEFORMATEX* alloc_pcm16_stereo_48k() {
  auto* mix = (WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
  if (!mix) return nullptr;
  ZeroMemory(mix, sizeof(*mix));
  mix->wFormatTag = WAVE_FORMAT_PCM;
  mix->nChannels = 2;
  mix->nSamplesPerSec = 48000;
  mix->wBitsPerSample = 16;
  mix->nBlockAlign = 4;
  mix->nAvgBytesPerSec = 48000 * 4;
  mix->cbSize = 0;
  return mix;
}

static bool init_with_fixed_format(IAudioClient* client, DWORD flags, REFERENCE_TIME dur, Capture& result) {
  WAVEFORMATEX* mix = alloc_pcm16_stereo_48k();
  if (!mix) return false;
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, dur, 0, mix, nullptr);
  if (FAILED(hr)) {
    log_hr("IAudioClient.Initialize", hr);
    CoTaskMemFree(mix);
    return false;
  }
  if (!bind_capture_client(client, mix, result)) { CoTaskMemFree(mix); return false; }
  return true;
}

static bool init_process_client(IAudioClient* client, DWORD flags, bool fixedPcm, REFERENCE_TIME dur, Capture& result) {
  WAVEFORMATEX* mix = nullptr;
  if (fixedPcm) {
    mix = alloc_pcm16_stereo_48k();
    if (!mix) return false;
  } else {
    HRESULT hr = client->GetMixFormat(&mix);
    if (FAILED(hr) || !mix) return false;
  }
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, dur, 0, mix, nullptr);
  if (FAILED(hr)) {
    log_hr("IAudioClient.Initialize", hr);
    CoTaskMemFree(mix);
    return false;
  }
  if (!bind_capture_client(client, mix, result)) {
    CoTaskMemFree(mix);
    return false;
  }
  return true;
}

static bool init_process_loopback_mode(DWORD targetPid, PROCESS_LOOPBACK_MODE mode, Capture& result) {
  struct Attempt {
    const char* name;
    DWORD flags;
    bool fixedPcm;
    REFERENCE_TIME dur;
  };
  const Attempt attempts[] = {
    // Этот набор на Win11 реально отдаёт звук других программ в режиме exclude.
    { "pcm-loopback", AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, true, 0 },
    { "mix-loopback", AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, false, 0 },
  };
  for (const Attempt& a : attempts) {
    HRESULT hr = E_FAIL;
    IAudioClient* client = activate_process_loopback(targetPid, mode, &hr);
    if (!client) {
      log_hr(a.name, hr);
      return false;
    }
    if (init_process_client(client, a.flags, a.fixedPcm, a.dur, result)) {
      fprintf(stderr, "sloncord-audio capture=%s\n", a.name);
      return true;
    }
    client->Release();
  }

  HRESULT hr = E_FAIL;
  IAudioClient* client = activate_process_loopback(targetPid, mode, &hr);
  if (!client) return false;
  if (init_with_audio_client3(client, result)) {
    fprintf(stderr, "sloncord-audio capture=ac3\n");
    return true;
  }
  client->Release();
  return false;
}

static bool init_process_loopback_include(DWORD targetPid, Capture& result) {
  return init_process_loopback_mode(targetPid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, result);
}

static bool init_process_loopback_exclude(DWORD targetPid, Capture& result) {
  return init_process_loopback_mode(targetPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, result);
}

static inline int16_t f32_to_s16(float v) {
  if (v > 1.0f) v = 1.0f;
  if (v < -1.0f) v = -1.0f;
  int x = (int)(v * 32767.0f);
  if (x > 32767) x = 32767;
  if (x < -32768) x = -32768;
  return (int16_t)x;
}

static void write_s16_stereo(HANDLE pipe, const WAVEFORMATEX* wf, const BYTE* data, UINT32 frames, bool silent) {
  const uint32_t bytesOut = frames * 4u; // s16le stereo
  write_u32(pipe, bytesOut);
  if (silent || !wf || !data || frames == 0) {
    std::vector<uint8_t> zeros(bytesOut, 0);
    write_bytes(pipe, zeros.data(), bytesOut);
    return;
  }

  const int inCh = (int)wf->nChannels;
  const bool isExtensible = (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22);
  const WAVEFORMATEXTENSIBLE* wfx = isExtensible ? (const WAVEFORMATEXTENSIBLE*)wf : nullptr;
  const bool isPcm16 =
    (wf->wFormatTag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 16) ||
    (isExtensible && wfx && wfx->SubFormat == KSDATAFORMAT_SUBTYPE_PCM && wf->wBitsPerSample == 16);
  const bool isPcm32 =
    (wf->wFormatTag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 32) ||
    (isExtensible && wfx && wfx->SubFormat == KSDATAFORMAT_SUBTYPE_PCM && wf->wBitsPerSample == 32);
  const bool isFloat32 =
    (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT && wf->wBitsPerSample == 32) ||
    (isExtensible && wfx && wfx->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);

  std::vector<int16_t> out;
  out.resize((size_t)frames * 2u);

  if (isPcm16) {
    const int16_t* s = (const int16_t*)data;
    for (UINT32 i = 0; i < frames; i++) {
      int16_t L = 0, R = 0;
      if (inCh <= 0) { L = R = 0; }
      else if (inCh == 1) { L = R = s[i]; }
      else {
        L = s[i * (UINT32)inCh + 0];
        R = s[i * (UINT32)inCh + 1];
      }
      out[(size_t)i * 2u + 0] = L;
      out[(size_t)i * 2u + 1] = R;
    }
    write_bytes(pipe, out.data(), bytesOut);
    return;
  }

  if (isPcm32) {
    const int32_t* s = (const int32_t*)data;
    for (UINT32 i = 0; i < frames; i++) {
      int32_t L = 0, R = 0;
      if (inCh <= 0) { L = R = 0; }
      else if (inCh == 1) { L = R = s[i]; }
      else {
        L = s[i * (UINT32)inCh + 0];
        R = s[i * (UINT32)inCh + 1];
      }
      // Convert signed 32-bit PCM (full scale) to s16.
      out[(size_t)i * 2u + 0] = (int16_t)(L >> 16);
      out[(size_t)i * 2u + 1] = (int16_t)(R >> 16);
    }
    write_bytes(pipe, out.data(), bytesOut);
    return;
  }

  if (isFloat32) {
    const float* f = (const float*)data;
    for (UINT32 i = 0; i < frames; i++) {
      float L = 0.f, R = 0.f;
      if (inCh <= 0) { L = R = 0.f; }
      else if (inCh == 1) { L = R = f[i]; }
      else {
        L = f[i * (UINT32)inCh + 0];
        R = f[i * (UINT32)inCh + 1];
      }
      out[(size_t)i * 2u + 0] = f32_to_s16(L);
      out[(size_t)i * 2u + 1] = f32_to_s16(R);
    }
    write_bytes(pipe, out.data(), bytesOut);
    return;
  }

  // Unknown format: send silence.
  std::vector<uint8_t> zeros(bytesOut, 0);
  write_bytes(pipe, zeros.data(), bytesOut);
}

static void clamp_to_s16(int16_t* dst, const std::vector<int32_t>& acc) {
  for (size_t i = 0; i < acc.size(); i++) {
    int32_t v = acc[i];
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    dst[i] = (int16_t)v;
  }
}

static void convert_to_s16_stereo_vec(std::vector<int16_t>& out, const WAVEFORMATEX* wf, const BYTE* data, UINT32 frames, bool silent) {
  out.assign((size_t)frames * 2u, 0);
  if (silent || !wf || !data || frames == 0) return;

  const int inCh = (int)wf->nChannels;
  const bool isExtensible = (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22);
  const WAVEFORMATEXTENSIBLE* wfx = isExtensible ? (const WAVEFORMATEXTENSIBLE*)wf : nullptr;
  const bool isPcm16 =
    (wf->wFormatTag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 16) ||
    (isExtensible && wfx && wfx->SubFormat == KSDATAFORMAT_SUBTYPE_PCM && wf->wBitsPerSample == 16);
  const bool isPcm32 =
    (wf->wFormatTag == WAVE_FORMAT_PCM && wf->wBitsPerSample == 32) ||
    (isExtensible && wfx && wfx->SubFormat == KSDATAFORMAT_SUBTYPE_PCM && wf->wBitsPerSample == 32);
  const bool isFloat32 =
    (wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT && wf->wBitsPerSample == 32) ||
    (isExtensible && wfx && wfx->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);

  if (isPcm16) {
    const int16_t* s = (const int16_t*)data;
    for (UINT32 i = 0; i < frames; i++) {
      int16_t L = 0, R = 0;
      if (inCh <= 0) { L = R = 0; }
      else if (inCh == 1) { L = R = s[i]; }
      else {
        L = s[i * (UINT32)inCh + 0];
        R = s[i * (UINT32)inCh + 1];
      }
      out[(size_t)i * 2u + 0] = L;
      out[(size_t)i * 2u + 1] = R;
    }
    return;
  }

  if (isPcm32) {
    const int32_t* s = (const int32_t*)data;
    for (UINT32 i = 0; i < frames; i++) {
      int32_t L = 0, R = 0;
      if (inCh <= 0) { L = R = 0; }
      else if (inCh == 1) { L = R = s[i]; }
      else {
        L = s[i * (UINT32)inCh + 0];
        R = s[i * (UINT32)inCh + 1];
      }
      out[(size_t)i * 2u + 0] = (int16_t)(L >> 16);
      out[(size_t)i * 2u + 1] = (int16_t)(R >> 16);
    }
    return;
  }

  if (isFloat32) {
    const float* f = (const float*)data;
    for (UINT32 i = 0; i < frames; i++) {
      float L = 0.f, R = 0.f;
      if (inCh <= 0) { L = R = 0.f; }
      else if (inCh == 1) { L = R = f[i]; }
      else {
        L = f[i * (UINT32)inCh + 0];
        R = f[i * (UINT32)inCh + 1];
      }
      out[(size_t)i * 2u + 0] = f32_to_s16(L);
      out[(size_t)i * 2u + 1] = f32_to_s16(R);
    }
  }
}

struct SubtractState {
  Capture cap;
  std::vector<int16_t> lastStereo;
  UINT32 lastFrames = 0;
};

static void subtract_state_drain(SubtractState& st) {
  if (!st.cap.cap) return;
  while (true) {
    UINT32 exPackets = 0;
    if (FAILED(st.cap.cap->GetNextPacketSize(&exPackets)) || exPackets == 0) break;
    BYTE* exData = nullptr;
    UINT32 exFrames = 0;
    DWORD exFlags = 0;
    if (FAILED(st.cap.cap->GetBuffer(&exData, &exFrames, &exFlags, nullptr, nullptr))) break;
    convert_to_s16_stereo_vec(st.lastStereo, st.cap.wf, exData, exFrames, (exFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
    st.lastFrames = exFrames;
    st.cap.cap->ReleaseBuffer(exFrames);
  }
}

static void subtract_from_acc(std::vector<int32_t>& acc, UINT32 frames, SubtractState& st) {
  if (st.lastFrames == 0 || st.lastStereo.empty()) return;
  const UINT32 useFrames = (st.lastFrames < frames) ? st.lastFrames : frames;
  const size_t samples = (size_t)useFrames * 2u;
  for (size_t i = 0; i < samples; i++) acc[i] -= (int32_t)st.lastStereo[i];
}

int main(int argc, char** argv) {
  Args a = parse_args(argc, argv);
  if (a.pipeName.empty() || a.mode.empty()) return 2;

  HANDLE pipe = CreateNamedPipeW(
    a.pipeName.c_str(),
    PIPE_ACCESS_OUTBOUND,
    PIPE_TYPE_BYTE | PIPE_WAIT,
    1,
    1 << 20,
    1 << 20,
    0,
    nullptr
  );
  if (pipe == INVALID_HANDLE_VALUE) return 3;
  if (!ConnectNamedPipe(pipe, nullptr)) {
    DWORD err = GetLastError();
    if (err != ERROR_PIPE_CONNECTED) { CloseHandle(pipe); return 4; }
  }

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) { CloseHandle(pipe); return 5; }

  DWORD taskIndex = 0;
  HANDLE avrt = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  Capture mainCap;
  std::vector<SubtractState> subtractStates;

  if (a.mode == "system") {
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 7;
    }
    bool opened = false;
    const ERole roles[] = { eConsole, eMultimedia, eCommunications };
    for (ERole role : roles) {
      IMMDevice* device = nullptr;
      if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, role, &device)) || !device) continue;
      if (init_loopback_default(device, mainCap)) {
        device->Release();
        opened = true;
        break;
      }
      device->Release();
    }
    if (!opened) {
      IMMDeviceCollection* col = nullptr;
      if (SUCCEEDED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col)) && col) {
        UINT count = 0;
        col->GetCount(&count);
        for (UINT i = 0; i < count && !opened; i++) {
          IMMDevice* device = nullptr;
          if (FAILED(col->Item(i, &device)) || !device) continue;
          if (init_loopback_default(device, mainCap)) opened = true;
          device->Release();
        }
        col->Release();
      }
    }
    enumerator->Release();
    if (!opened) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 9;
    }
  } else if (a.mode == "window") {
    if (!a.targetPid && a.targetHwnd) {
      DWORD pid = 0;
      GetWindowThreadProcessId((HWND)(uintptr_t)a.targetHwnd, &pid);
      a.targetPid = pid;
    }
    if (!a.targetPid) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 8;
    }
    if (!init_process_loopback_include(a.targetPid, mainCap)) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 8;
    }
  } else if (a.mode == "screen-dual") {
    if (!a.excludeTargetPid) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 9;
    }
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr) || !enumerator) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 7;
    }
    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    enumerator->Release();
    if (FAILED(hr) || !device) {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 7;
    }
    if (!init_loopback_default(device, mainCap)) {
      device->Release();
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 9;
    }
    SubtractState appState;
    if (!init_process_loopback_include(a.excludeTargetPid, appState.cap)) {
      device->Release();
      capture_close(mainCap);
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 9;
    }
    subtractStates.push_back(std::move(appState));
    device->Release();
  } else {
    if (a.excludeTargetPid) {
      if (!init_process_loopback_exclude(a.excludeTargetPid, mainCap)) {
        if (avrt) AvRevertMmThreadCharacteristics(avrt);
        CoUninitialize();
        CloseHandle(pipe);
        return 9;
      }
    } else if (!a.excludePids.empty()) {
      IMMDeviceEnumerator* enumerator = nullptr;
      hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
      if (FAILED(hr) || !enumerator) {
        if (avrt) AvRevertMmThreadCharacteristics(avrt);
        CoUninitialize();
        CloseHandle(pipe);
        return 7;
      }
      IMMDevice* device = nullptr;
      hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
      enumerator->Release();
      if (FAILED(hr) || !device) {
        if (avrt) AvRevertMmThreadCharacteristics(avrt);
        CoUninitialize();
        CloseHandle(pipe);
        return 7;
      }
      if (!init_loopback_default(device, mainCap)) {
        device->Release();
        if (avrt) AvRevertMmThreadCharacteristics(avrt);
        CoUninitialize();
        CloseHandle(pipe);
        return 9;
      }
      for (DWORD pid : a.excludePids) {
        if (!pid) continue;
        SubtractState st;
        if (init_process_loopback_include(pid, st.cap)) subtractStates.push_back(std::move(st));
      }
      device->Release();
    } else {
      if (avrt) AvRevertMmThreadCharacteristics(avrt);
      CoUninitialize();
      CloseHandle(pipe);
      return 9;
    }
  }

  hr = mainCap.ac->Start();
  if (FAILED(hr)) {
    for (auto& st : subtractStates) capture_close(st.cap);
    capture_close(mainCap);
    if (avrt) AvRevertMmThreadCharacteristics(avrt);
    CoUninitialize();
    CloseHandle(pipe);
    return 10;
  }
  for (auto& st : subtractStates) {
    if (st.cap.ac) st.cap.ac->Start();
  }

  while (true) {
    WaitForSingleObject(mainCap.evt ? mainCap.evt : GetCurrentThread(), 200);
    for (auto& st : subtractStates) subtract_state_drain(st);

    UINT32 packetFrames = 0;
    hr = mainCap.cap->GetNextPacketSize(&packetFrames);
    if (FAILED(hr)) break;
    if (packetFrames == 0) continue;

    BYTE* data = nullptr;
    UINT32 frames = 0;
    DWORD flags = 0;
    hr = mainCap.cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
    if (FAILED(hr)) break;

    if (subtractStates.empty()) {
      write_s16_stereo(pipe, mainCap.wf, data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
      mainCap.cap->ReleaseBuffer(frames);
      continue;
    }

    std::vector<int32_t> acc((size_t)frames * 2u, 0);
    std::vector<int16_t> tmpStereo;
    convert_to_s16_stereo_vec(tmpStereo, mainCap.wf, data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
    for (size_t i = 0; i < tmpStereo.size(); i++) acc[i] += (int32_t)tmpStereo[i];

    for (auto& st : subtractStates) subtract_from_acc(acc, frames, st);

    std::vector<int16_t> out((size_t)frames * 2u);
    clamp_to_s16(out.data(), acc);
    const uint32_t bytesOut = frames * 4u;
    write_u32(pipe, bytesOut);
    write_bytes(pipe, out.data(), bytesOut);
    mainCap.cap->ReleaseBuffer(frames);
  }

  for (auto& st : subtractStates) capture_close(st.cap);
  capture_close(mainCap);
  if (avrt) AvRevertMmThreadCharacteristics(avrt);
  CoUninitialize();
  CloseHandle(pipe);
  return 0;
}

