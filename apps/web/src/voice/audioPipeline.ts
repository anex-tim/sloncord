import { screenVolumePctToGain } from "./screenShare";

export type AudioPipelineHost = {
  remoteAudioHost: HTMLElement | null;
  remoteVideoHost: HTMLElement | null;
};

export function createAudioPipeline(host: AudioPipelineHost) {
  const audioElByUserId = new Map<string, HTMLAudioElement>();
  const audioPipeByKey = new Map<string, {
    gainNode?: GainNode;
    srcNode?: MediaStreamAudioSourceNode;
    destNode?: MediaStreamAudioDestinationNode;
    originalStream?: MediaStream;
  }>();
  const directStreamByUserId = new Map<string, MediaStream>();
  const userVolumePctByUserId = new Map<string, number>();
  const screenAudioPctByUserId = new Map<string, number>();

  function pipeKey(uid: string, src: string) {
    return `${String(uid)}:${String(src || "mic")}`;
  }

  function makeAudioEl(peerId: string, source: string) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const src = String(source || "mic").replace(/[^a-z0-9_-]/gi, "x");
    const id = `sfu-remote-audio-${pid}:${src}`;
    let el = document.getElementById(id) as HTMLAudioElement | null;
    if (el) return el;
    el = document.createElement("audio");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.setAttribute("playsinline", "true");
    host.remoteAudioHost?.appendChild(el);
    return el;
  }

  function makeVideoEl(peerId: string, source: string) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const src = String(source || "");
    const suf = src && src !== "screen" ? `-${src.replace(/[^a-z0-9_-]/gi, "x")}` : "";
    const id = `remote-video-${pid}${suf}`;
    let el = document.getElementById(id) as HTMLVideoElement | null;
    if (el) return el;
    el = document.createElement("video");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.muted = true;
    el.setAttribute("playsinline", "true");
    (host.remoteVideoHost || document.querySelector(".voice-video-stage"))?.appendChild(el);
    return el;
  }

  function getUserVolumePct(userId: string) {
    const cached = userVolumePctByUserId.get(String(userId));
    if (cached != null) return Math.max(0, Math.min(300, Number(cached) || 0));
    try {
      const raw = localStorage.getItem("sloncord_voice_user_volumes") || "{}";
      const m = JSON.parse(raw) || {};
      const v = Number(m[String(userId)] ?? 100);
      return Math.max(0, Math.min(300, Number.isFinite(v) ? v : 100));
    } catch {
      return 100;
    }
  }

  function volumePctToGain(pct: number) {
    const p = Math.max(0, Math.min(300, Number(pct) || 0));
    if (p <= 100) return p / 100;
    const t = (p - 100) / 200;
    return 1 + t * 8; // 1..9 at 100..300%
  }

  function applyUserVolume(userId: string, source: string, audioCtx: AudioContext | null, deafened: boolean) {
    const key = pipeKey(userId, source);
    const el = audioElByUserId.get(key);
    if (!el) return;
    const uid = String(userId);
    const src = String(source || "mic");
    const pct = src === "screenAudio"
      ? (screenAudioPctByUserId.get(uid) ?? getUserVolumePct(uid))
      : getUserVolumePct(uid);
    const pipe = audioPipeByKey.get(key);
    if (pipe?.gainNode) {
      const g = src === "screenAudio" ? screenVolumePctToGain(Number(pct)) : volumePctToGain(pct);
      try { pipe.gainNode.gain.value = deafened ? 0 : g; } catch { /* ignore */ }
    }
    try { el.muted = deafened; } catch { /* ignore */ }
    try { el.volume = Math.min(1, volumePctToGain(pct)); } catch { /* ignore */ }
    void audioCtx?.resume?.().catch(() => {});
  }

  function tryPlayAll() {
    audioElByUserId.forEach((el) => {
      try {
        const p = el.play?.();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch { /* ignore */ }
    });
    try {
      document.querySelectorAll<HTMLVideoElement>('[id^="remote-video-"]').forEach((el) => {
        try {
          const p = el.play?.();
          if (p && typeof p.catch === "function") p.catch(() => {});
        } catch { /* ignore */ }
      });
    } catch { /* ignore */ }
  }

  function removeMediaEls(peerId: string) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    try {
      document.querySelectorAll(`[id^="sfu-remote-audio-${pid}:"]`).forEach((x) => x.remove());
    } catch { /* ignore */ }
    try {
      document.querySelectorAll(`[id^="remote-video-${pid}"]`).forEach((x) => x.remove());
    } catch { /* ignore */ }
  }

  function clear() {
    audioElByUserId.clear();
    audioPipeByKey.forEach((p) => {
      try { p.srcNode?.disconnect?.(); } catch { /* ignore */ }
      try { p.gainNode?.disconnect?.(); } catch { /* ignore */ }
    });
    audioPipeByKey.clear();
    directStreamByUserId.clear();
    userVolumePctByUserId.clear();
    screenAudioPctByUserId.clear();
  }

  return {
    audioElByUserId,
    audioPipeByKey,
    directStreamByUserId,
    userVolumePctByUserId,
    screenAudioPctByUserId,
    pipeKey,
    makeAudioEl,
    makeVideoEl,
    getUserVolumePct,
    volumePctToGain,
    applyUserVolume,
    tryPlayAll,
    removeMediaEls,
    clear,
  };
}

export type AudioPipelineApi = ReturnType<typeof createAudioPipeline>;
