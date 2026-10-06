import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import * as signalR from "./realtime/sloncordRealtimeShim";
import { buildBackendWsUrl, getApiBase } from "./config/apiBase";
import { fetchDesktopReleaseFromGithub } from "./config/desktopGithubRelease";
import {
  buildServerInviteUrl,
  captureInviteFromCurrentUrl,
  clearInviteFromBrowserUrl,
  normalizeInviteUrl,
  parseInviteCodeFromUrl,
  stashPendingInviteCode,
  takePendingInviteCode
} from "./config/inviteLinks";
import { VoiceChannelSidebarItem } from "./voiceChannelSidebarItem";
import { SlonIcon } from "./icons/SlonIcon";
import { ElectronTitleBar, DESKTOP_RELEASE_CHECK_EVENT } from "./ElectronTitleBar";
import { ElectronUpdateOverlay } from "./ElectronUpdateOverlay";
import { createNativeVoiceSession } from "./voice/nativeVoiceSession";
import { createSfuVoiceSession } from "./voice/sfuSession";
import { clearAvatarCache, getCachedAvatarUrl, putCachedAvatarUrl } from "./avatarCache";
import { SlonTeamBadge, slonTeamNickClass, teamFlagsFromProfile, teamFlagsFromRealtimePayload } from "./userTeamUi";
const RT = {
  MessageCreated: "message.created",
  MessageUpdated: "message.updated",
  MessageDeleted: "message.deleted",
  Typing: "typing",
  UnreadChanged: "unread.changed",
  ChannelListUpdated: "channelList.updated",
  ServerListUpdated: "serverList.updated",
  DmCreated: "dm.created",
  VoicePresenceUpdated: "voice.presence",
  VoiceMoved: "voice.moved",
  UserPresenceUpdated: "user.presence",
  DmCallIncoming: "dm.call.incoming",
  DmCallResponse: "dm.call.response",
  DmCallCancelled: "dm.call.cancelled",
  PlatformBanned: "platform.banned",
  ChatMuteChanged: "chat.mute.changed",
  SessionsRevoked: "user.sessions.revoked",
  UserTeamChanged: "user.team.changed"
};

const MAX_MESSAGES_IN_MEMORY = 500;
const MAX_CACHED_USER_PROFILES = 350;

function capMessagesList(list, max = MAX_MESSAGES_IN_MEMORY) {
  const a = Array.isArray(list) ? list : [];
  if (a.length <= max) return a;
  return a.slice(a.length - max);
}

function trimProfileCache(prev, max = MAX_CACHED_USER_PROFILES) {
  if (!prev || typeof prev !== "object") return prev;
  const keys = Object.keys(prev);
  if (keys.length <= max) return prev;
  const next = { ...prev };
  for (let i = 0; i < keys.length - max; i += 1) {
    delete next[keys[i]];
  }
  return next;
}

function dispatchDesktopReleaseCheckIfDesktop(): void {
  try {
    if (typeof window === "undefined") return;
    if (typeof window.sloncord?.getAppVersion !== "function") return;
    window.dispatchEvent(new CustomEvent(DESKTOP_RELEASE_CHECK_EVENT));
  } catch {
    /* ignore */
  }
}

function fileKindByName(name) {
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "ogg", "mov", "m4v", "mkv", "avi", "wmv", "ogv"].includes(ext)) return "video";
  return "other";
}

function fileIconForName(name) {
  const ext = ((name || "").split(".").pop() || "").toLowerCase();
  if (ext === "pdf") return "/icons/file-pdf.svg";
  if (ext === "doc" || ext === "docx") return "/icons/file-docx.svg";
  if (ext === "xls" || ext === "xlsx" || ext === "csv") return "/icons/file-xlsx.svg";
  if (ext === "zip" || ext === "rar" || ext === "7z" || ext === "tar" || ext === "gz") return "/icons/file-zip.svg";
  if (ext === "txt" || ext === "md" || ext === "log" || ext === "json") return "/icons/file-txt.svg";
  return "/icons/file-generic.svg";
}

/** MIME для video-элемента / Blob, если сервер отдал octet-stream (Chromium иначе может не выбрать декодер). */
function guessVideoMimeFromName(name) {
  const ext = String(name || "").split(".").pop()?.toLowerCase() || "";
  const map = {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    ogv: "video/ogg",
    ogg: "video/ogg",
    avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv"
  };
  return map[ext] || "";
}

function MessageFilePreview({ file, token, onOpenLightbox, onDownload, onMediaLoaded }) {
  const k = useMemo(() => fileKindByName(file?.originalName), [file?.originalName]);
  const [dataUrl, setDataUrl] = useState(null);
  const [videoPosterUrl, setVideoPosterUrl] = useState("");
  const [showVideoPosterOverlay, setShowVideoPosterOverlay] = useState(true);
  const [videoStarted, setVideoStarted] = useState(false);
  const [videoPlayError, setVideoPlayError] = useState(false);
  /** Если прямой URL (?access_token=) даёт ошибку декодирования — один раз подгружаем с Bearer и blob (как для картинок). */
  const [fallbackBlobUrl, setFallbackBlobUrl] = useState(null);
  const recoveryAttemptedRef = useRef(false);
  const videoElRef = useRef(null);
  const placeholderVideoPoster = useMemo(() => (
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
        <defs>
          <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stop-color="#1f2024"/>
            <stop offset="1" stop-color="#0f1012"/>
          </linearGradient>
        </defs>
        <rect width="640" height="360" fill="url(#g)"/>
        <circle cx="320" cy="180" r="52" fill="rgba(255,255,255,0.10)"/>
        <path d="M310 155 L310 205 L355 180 Z" fill="rgba(255,255,255,0.75)"/>
      </svg>`
    )}`
  ), []);
  const accessTokenQS = useMemo(() => {
    const t = String(token || "").trim();
    return t ? `access_token=${encodeURIComponent(t)}` : "";
  }, [token]);
  const baseVideoUrl = useMemo(() => (
    file?.id && accessTokenQS ? `${getApiBase()}/files/${file.id}/content?${accessTokenQS}` : ""
  ), [file?.id, accessTokenQS]);
  const playbackVideoSrc = useMemo(() => {
    if (fallbackBlobUrl) return fallbackBlobUrl;
    const base = baseVideoUrl;
    if (!base) return "";
    const n = String(file?.originalName || "").toLowerCase();
    if ((n.endsWith(".mp4") || n.endsWith(".m4v")) && !base.includes("#")) {
      return `${base}#t=0.001`;
    }
    return base;
  }, [fallbackBlobUrl, baseVideoUrl, file?.originalName]);
  const directVideoPoster = useMemo(() => (
    file?.id && accessTokenQS ? `${getApiBase()}/files/${file.id}/thumb?${accessTokenQS}` : ""
  ), [file?.id, accessTokenQS]);

  useEffect(() => {
    if (k !== "video") return;
    setShowVideoPosterOverlay(true);
    setVideoStarted(false);
    setVideoPlayError(false);
    recoveryAttemptedRef.current = false;
    setFallbackBlobUrl((prev) => {
      if (prev) {
        try {
          URL.revokeObjectURL(prev);
        } catch {
          /* ignore */
        }
      }
      return null;
    });
  }, [k, file?.id]);

  useEffect(() => {
    if (k !== "video") return;
    if (!file?.id) return;
    if (!baseVideoUrl) return;

    let dead = false;
    let posterObjectUrl = "";

    async function tryFetchPosterBlob() {
      if (!directVideoPoster) return false;
      try {
        const ac = new AbortController();
        // First thumb generation can take longer (ffmpeg warmup); be more patient.
        const t = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, 6500);
        const r = await fetch(directVideoPoster, { method: "GET", signal: ac.signal });
        clearTimeout(t);
        if (!r.ok) return false;
        const ct = String(r.headers?.get?.("content-type") || "");
        if (ct && !ct.toLowerCase().startsWith("image/")) return false;
        const blob = await r.blob();
        if (!blob || (Number(blob.size) || 0) <= 0) return false;
        posterObjectUrl = URL.createObjectURL(blob);
        if (!dead) setVideoPosterUrl(posterObjectUrl);
        return true;
      } catch {
        return false;
      }
    }

    async function tryGeneratePosterFromVideo() {
      try {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "auto";
        v.src = baseVideoUrl;

        const ensureLoaded = () => new Promise((resolve, reject) => {
          const onErr = () => reject(new Error("video_load_error"));
          const onLoaded = () => resolve();
          v.addEventListener("error", onErr, { once: true });
          v.addEventListener("loadeddata", onLoaded, { once: true });
          try { v.load(); } catch { /* ignore */ }
        });

        await Promise.race([
          ensureLoaded(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("video_load_timeout")), 2200))
        ]);
        if (dead) return;

        // Try to seek a tiny bit to avoid black first frame.
        const seekTo = Math.min(0.25, Math.max(0.0, Number(v.duration || 0) ? Number(v.duration) * 0.02 : 0.25));
        const doSeek = () => new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          v.addEventListener("seeked", finish, { once: true });
          setTimeout(finish, 300);
          try { v.currentTime = seekTo; } catch { finish(); }
        });
        await doSeek();
        if (dead) return;

        const w = Math.max(1, Number(v.videoWidth) || 0);
        const h = Math.max(1, Number(v.videoHeight) || 0);
        if (w <= 1 || h <= 1) return;

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(v, 0, 0, w, h);
        const data = canvas.toDataURL("image/webp", 0.82);
        if (!dead) setVideoPosterUrl(data || "");
      } catch {
        // ignore
      }
    }

    (async () => {
      const ok = await tryFetchPosterBlob();
      if (ok) return;
      await tryGeneratePosterFromVideo();
      if (!dead) {
        // If everything failed, at least show a stable placeholder poster (prevents filename-flash UX).
        setVideoPosterUrl((cur) => (cur ? cur : placeholderVideoPoster));
      }
    })();

    return () => {
      dead = true;
      if (posterObjectUrl) {
        try { URL.revokeObjectURL(posterObjectUrl); } catch { /* ignore */ }
      }
    };
  }, [k, file?.id, baseVideoUrl, directVideoPoster, placeholderVideoPoster]);

  useEffect(() => {
    if (!file?.id) return;
    if (k === "other") return;
    if (k === "video") return; // video streams via direct src with query token
    // NOTE: <img>/<video> cannot send Authorization headers, so we must fetch a blob ourselves.
    // This fixes the regression where old images/videos became "broken".
    let dead = false;
    let objectUrl = "";
    const abort = new AbortController();
    (async () => {
      try {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        // First try the binary content endpoint (supports large files/range on server side).
        let r = await fetch(`${getApiBase()}/files/${file.id}/content`, { headers, signal: abort.signal });
        if (r.ok) {
          const blob = await r.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!dead) setDataUrl(objectUrl);
          return;
        }
        // Fallback to legacy JSON base64 endpoint.
        r = await fetch(`${getApiBase()}/files/${file.id}`, { headers: { "Content-Type": "application/json", ...headers }, signal: abort.signal });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return;
        const b64 = d?.fileBase64;
        if (!b64) return;
        const ct = d?.file?.contentType || "application/octet-stream";
        if (!dead) setDataUrl(`data:${ct};base64,${b64}`);
      } catch {
        // ignore
      }
    })();
    return () => {
      dead = true;
      try { abort.abort(); } catch { /* ignore */ }
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
      }
    };
  }, [file?.id, file?.originalName, k, token]);

  async function attemptAuthorizedBlobFallback() {
    if (recoveryAttemptedRef.current || !file?.id || !token) return false;
    recoveryAttemptedRef.current = true;
    try {
      const headers = { Authorization: `Bearer ${String(token)}` };
      const r = await fetch(`${getApiBase()}/files/${file.id}/content`, { headers });
      if (!r.ok) return false;
      const cl = r.headers.get("content-length");
      const maxBytes = 96 * 1024 * 1024;
      if (cl && Number(cl) > maxBytes) return false;
      const blob = await r.blob();
      if (!blob || (Number(blob.size) || 0) <= 0) return false;
      const mime =
        guessVideoMimeFromName(file.originalName)
        || (String(blob.type || "").startsWith("video/") ? blob.type : "")
        || "video/mp4";
      const typed = String(blob.type || "").startsWith("video/") ? blob : new Blob([blob], { type: mime });
      const url = URL.createObjectURL(typed);
      setFallbackBlobUrl((prev) => {
        if (prev) {
          try {
            URL.revokeObjectURL(prev);
          } catch {
            /* ignore */
          }
        }
        return url;
      });
      setVideoPlayError(false);
      setVideoStarted(false);
      setShowVideoPosterOverlay(true);
      return true;
    } catch {
      return false;
    }
  }

  if (k === "other") {
    const name = String(file?.originalName || "file.bin");
    const ext = (name.split(".").pop() || "").toUpperCase();
    return (
      <div className="msg-file">
        <span className="msg-file__icon" aria-hidden="true">
          <img alt="" src={fileIconForName(name)} />
        </span>
        <span className="msg-file__meta">
          <span className="msg-file__name" title={name}>{name}</span>
          {ext ? <span className="msg-file__ext">{ext}</span> : null}
        </span>
        <button type="button" className="msg-file__dl" onClick={onDownload} title="Скачать" aria-label="Скачать">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M11 3v10.17l-3.59-3.58L6 11l6 6 6-6-1.41-1.41L13 13.17V3h-2zM4 19h16v2H4v-2z" />
          </svg>
        </button>
      </div>
    );
  }

  if (k === "video") {
    const posterSrc = videoPosterUrl || placeholderVideoPoster;
    const mimeHint = guessVideoMimeFromName(file?.originalName) || "video/mp4";
    const isDesktopShell = typeof window !== "undefined" && !!window.sloncord?.getAppVersion;
    const videoWrapClass =
      `msg-attachment__video${videoStarted ? " msg-attachment__video--playing" : ""}${videoPlayError ? " msg-attachment__video--error" : ""}`;
    return (
      <div className="msg-attachment msg-attachment--video">
        <div className={videoWrapClass}>
          {showVideoPosterOverlay && !videoPlayError && (
            <img
              className="msg-attachment__video-poster"
              src={posterSrc}
              alt=""
              onError={() => {
                // If a data url somehow fails, hide the overlay so controls still work.
                setShowVideoPosterOverlay(false);
              }}
            />
          )}
          <video
            key={`${String(file?.id || "")}-${fallbackBlobUrl ? "blob" : "direct"}`}
            ref={videoElRef}
            poster={videoPlayError ? undefined : videoPosterUrl || directVideoPoster || undefined}
            preload="metadata"
            controls={!!videoStarted && !videoPlayError}
            playsInline
            controlsList={videoStarted && !videoPlayError ? "nofullscreen" : undefined}
            className="msg-attachment__video-el"
            onLoadedMetadata={() => {
              try { onMediaLoaded?.(); } catch { /* ignore */ }
            }}
            onError={() => {
              void (async () => {
                const recovered = await attemptAuthorizedBlobFallback();
                if (!recovered) {
                  setVideoPlayError(true);
                  setVideoStarted(false);
                  setShowVideoPosterOverlay(false);
                }
              })();
            }}
            onPlay={() => {
              setShowVideoPosterOverlay(false);
              setVideoStarted(true);
            }}
            onPlaying={() => {
              setShowVideoPosterOverlay(false);
              setVideoStarted(true);
            }}
            onPause={() => {
              // Keep controls hidden until first interaction; after started, pause shows native controls anyway.
              if (videoStarted) return;
              setShowVideoPosterOverlay(true);
            }}
          >
            {playbackVideoSrc ? <source src={playbackVideoSrc} type={mimeHint} /> : null}
          </video>
          {videoPlayError && (
            <div className="msg-attachment__video-error" role="status">
              <span>
                {isDesktopShell
                  ? "Не удалось воспроизвести видео (кодек, размер или сеть). Скачайте и откройте во внешнем плеере."
                  : "В браузере не удалось воспроизвести файл (кодек или формат). Скачайте и откройте локально."}
              </span>
              <button
                type="button"
                className="msg-attachment__video-error-dl"
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload();
                }}
              >
                Скачать
              </button>
            </div>
          )}
          {!videoStarted && !videoPlayError && (
            <button
              type="button"
              className="msg-attachment__playbtn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  setVideoStarted(true);
                  setShowVideoPosterOverlay(false);
                  videoElRef.current?.play?.().catch(() => {
                    void (async () => {
                      const recovered = await attemptAuthorizedBlobFallback();
                      if (recovered) {
                        requestAnimationFrame(() => {
                          videoElRef.current?.play?.().catch(() => {
                            setVideoPlayError(true);
                            setVideoStarted(false);
                          });
                        });
                      } else {
                        setVideoPlayError(true);
                        setVideoStarted(false);
                      }
                    })();
                  });
                } catch {
                  setVideoPlayError(true);
                  setVideoStarted(false);
                }
              }}
              aria-label="Воспроизвести"
              title="Воспроизвести"
            >
              <SlonIcon name="play" size={22} />
            </button>
          )}
          {!videoPlayError && (
            <button
              type="button"
              className="msg-attachment__fs"
              onClick={() =>
                onOpenLightbox({
                  dataUrl: fallbackBlobUrl || baseVideoUrl || "",
                  name: file.originalName,
                  fileId: file.id,
                  kind: "video"
                })
              }
              title="Открыть крупно"
            >
              <SlonIcon name="expand" size={16} />
            </button>
          )}
          <span
            className="msg-attachment__dlhover msg-attachment__dlhover--video"
            onClick={(e) => { e.stopPropagation(); onDownload(); }}
            title="Скачать"
            role="button"
            tabIndex={0}
          >
            <SlonIcon name="download" size={16} />
          </span>
        </div>
      </div>
    );
  }

  if (!dataUrl) {
    if (k === "image") {
      return (
        <div className="msg-attachment msg-attachment--loading" aria-busy="true">
          <div className="msg-attachment__thumb msg-attachment__thumb--loading" />
        </div>
      );
    }
    return null;
  }

  if (k === "image") {
    return (
      <div className="msg-attachment">
        <button
          type="button"
          className="msg-attachment__thumb"
          onClick={() => onOpenLightbox({ dataUrl, name: file.originalName, fileId: file.id, kind: "image" })}
        >
          <img
            src={dataUrl}
            alt=""
            onLoad={() => {
              try { onMediaLoaded?.(); } catch { /* ignore */ }
            }}
          />
          <span
            className="msg-attachment__dlhover"
            onClick={(e) => { e.stopPropagation(); onDownload(); }}
            title="Скачать"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                onDownload();
              }
            }}
          >
            <SlonIcon name="download" size={16} />
          </span>
        </button>
      </div>
    );
  }

  return null;
}

function getActiveChatMute(profile) {
  if (!profile) return null;
  const untilRaw = profile.chatMutedUntilUtc;
  if (!untilRaw) return profile.chatMuted ? { reason: String(profile.chatMuteReason || ""), until: null } : null;
  const untilMs = new Date(untilRaw).getTime();
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return null;
  return { reason: String(profile.chatMuteReason || ""), until: untilRaw };
}

function formatChatMuteUntil(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

function mergeScreenShareUserIds(localIds, presenceIds) {
  const out = new Set();
  for (const list of [localIds, presenceIds]) {
    if (!Array.isArray(list)) continue;
    for (const x of list) {
      const id = String(x || "").trim();
      if (id) out.add(id);
    }
  }
  return out;
}

function formatPlatformBanMessage(data) {
  if (!data?.platformBanned && !data?.permanent && !data?.reason && !data?.platformBanReason) return null;
  let msg = String(data?.error || "Аккаунт заблокирован модерацией платформы");
  const reason = String(data?.platformBanReason || data?.reason || "").trim();
  if (reason) msg += `. Причина: ${reason}`;
  if (data?.platformBanPermanent || data?.permanent) {
    msg += ". Срок: бессрочно";
  } else {
    const until = data?.platformBannedUntilUtc || data?.bannedUntilUtc;
    if (until) msg += `. Разблокировка: ${formatChatMuteUntil(until)}`;
  }
  return msg;
}

function App() {
  const MESSAGES_PAGE_SIZE = 30;
  const [mode, setMode] = useState("login");
  const [token, setToken] = useState(localStorage.getItem("sloncord_token") || "");
  const [profile, setProfile] = useState(null);
  const [chatMuteTick, setChatMuteTick] = useState(0);
  const activeChatMute = useMemo(() => {
    void chatMuteTick;
    return getActiveChatMute(profile);
  }, [profile, chatMuteTick]);

  useEffect(() => {
    if (!activeChatMute?.until) return undefined;
    const untilMs = new Date(activeChatMute.until).getTime();
    if (!Number.isFinite(untilMs)) return undefined;
    const delay = untilMs - Date.now();
    if (delay <= 0) {
      setChatMuteTick((n) => n + 1);
      return undefined;
    }
    const t = setTimeout(() => setChatMuteTick((n) => n + 1), Math.min(delay + 500, 2147483647));
    return () => clearTimeout(t);
  }, [activeChatMute?.until]);

  useEffect(() => {
    if (!token || !activeChatMute) return undefined;
    const t = setInterval(() => {
      void api("/profile", { method: "GET" })
        .then((me) => setProfile(me))
        .catch(() => {});
    }, 30000);
    return () => clearInterval(t);
  }, [token, activeChatMute?.until]);

  // iOS Safari/PWA: keep layout stable when the keyboard opens/closes.
  useEffect(() => {
    const root = document?.documentElement;
    if (!root) return undefined;

    const vv = window.visualViewport;
    let raf = 0;
    const apply = () => {
      try {
        const height = Math.max(0, Math.round((vv?.height ?? window.innerHeight) || 0));
        const offsetTop = Math.max(0, Math.round((vv?.offsetTop ?? 0) || 0));
        const kbd = Math.max(0, Math.round((window.innerHeight || 0) - height - offsetTop));
        root.style.setProperty("--vvh", `${height}px`);
        root.style.setProperty("--kbd", `${kbd}px`);
      } catch {
        // ignore
      }
    };
    const schedule = () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      raf = requestAnimationFrame(apply);
    };

    apply();
    if (vv?.addEventListener) {
      vv.addEventListener("resize", schedule, { passive: true });
      vv.addEventListener("scroll", schedule, { passive: true });
    }
    window.addEventListener("resize", schedule, { passive: true });

    return () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      try { window.removeEventListener("resize", schedule); } catch { /* ignore */ }
      try { vv?.removeEventListener?.("resize", schedule); } catch { /* ignore */ }
      try { vv?.removeEventListener?.("scroll", schedule); } catch { /* ignore */ }
    };
  }, []);

  const [uiMode, setUiMode] = useState("server"); // "server" | "dm"

  const [servers, setServers] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [dmChannels, setDmChannels] = useState([]);
  const [newServerName, setNewServerName] = useState("");
  const [newServerDescription, setNewServerDescription] = useState("");
  const [showCreateServer, setShowCreateServer] = useState(false);
  const channelActionLock = useRef(false);

  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const messagesRef = useRef([]);
  function normalizeAttachmentId(a) {
    if (!a) return "";
    const id = String(a?.id || a?.fileId || a?.attachmentFileId || a?.uploadedFileId || "");
    return id;
  }
  function normalizeAttachmentName(a) {
    if (!a) return "";
    return String(a?.name || a?.fileName || a?.originalName || "");
  }
  function reconcileOptimisticMessage(prev, serverMsg) {
    const list = Array.isArray(prev) ? prev : [];
    const msg = serverMsg;
    if (!msg) return list;
    const serverId = String(msg?.id || "");
    if (!serverId) return list;

    // If already present, keep the first occurrence and drop stale optimistic duplicates.
    const hasServerAlready = list.some((m) => String(m?.id || "") === serverId);

    const senderId = String(msg?.senderUserId || "");
    const serverText = String(msg?.text || "").trim();
    const serverCreatedAt = Date.parse(String(msg?.createdAtUtc || "")) || 0;

    const serverAttsRaw = Array.isArray(msg?.attachments) ? msg.attachments : [];
    const serverAttIds = serverAttsRaw.map(normalizeAttachmentId).filter(Boolean);
    const serverAttNames = serverAttsRaw.map(normalizeAttachmentName).filter(Boolean);
    if (msg?.file) {
      const fid = normalizeAttachmentId(msg.file);
      if (fid) serverAttIds.push(fid);
      const fn = normalizeAttachmentName(msg.file);
      if (fn) serverAttNames.push(fn);
    }

    const withinMs = (a, b, max) => (a && b ? Math.abs(a - b) <= max : false);

    const matchLocal = (m) => {
      const id = String(m?.id || "");
      if (!id || !id.startsWith("local-")) return false;
      if (String(m?.senderUserId || "") !== senderId) return false;
      if (!m?.clientStatus) return false;
      const localText = String(m?.text || "").trim();
      const localCreatedAt = Date.parse(String(m?.createdAtUtc || "")) || 0;
      // Most sends should reconcile within a short time window.
      if (!withinMs(localCreatedAt, serverCreatedAt, 25_000)) return false;

      const localAtts = Array.isArray(m?.clientAttachments) ? m.clientAttachments : [];
      const localUploadedIds = localAtts.map((x) => String(x?.uploadedFileId || "")).filter(Boolean);
      const localNames = localAtts.map((x) => String(x?.name || "")).filter(Boolean);

      // Prefer strong match: uploaded ids are a subset of server attachment ids.
      if (localUploadedIds.length && serverAttIds.length) {
        for (const fid of localUploadedIds) {
          if (!serverAttIds.includes(fid)) return false;
        }
        return true;
      }

      // Attachment-only messages: match by sender + time + attachment count.
      if (!serverText && !localText && serverAttIds.length > 0 && localAtts.length > 0) {
        if (serverAttIds.length === localAtts.length) return true;
      }

      // Otherwise, use a weaker heuristic: text match (when present) + attachment name/count match.
      const textOk = !serverText || !localText ? true : (serverText === localText);
      const countOk = (serverAttNames.length || 0) === (localNames.length || 0);
      if (!textOk) return false;
      if (!countOk && (serverAttNames.length || localNames.length)) return false;
      if (serverAttNames.length && localNames.length) {
        const a = serverAttNames.slice().sort().join("|");
        const b = localNames.slice().sort().join("|");
        if (a !== b) return false;
      }
      return true;
    };

    const localIdx = list.findIndex(matchLocal);
    if (localIdx < 0) return hasServerAlready ? list : [...list, msg];

    // Replace the optimistic message in-place to avoid layout shifts.
    const next = list.slice();
    next[localIdx] = msg;
    // If server message also exists elsewhere, drop duplicates (keep the replaced one).
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (i === localIdx) continue;
      if (String(next[i]?.id || "") === serverId) next.splice(i, 1);
    }
    return next;
  }
  function mergeMessagesKeepingLocal(prev, fresh) {
    const a = Array.isArray(prev) ? prev : [];
    const b = Array.isArray(fresh) ? fresh : [];
    const seen = new Set(b.map((m) => String(m?.id || "")));
    // If server snapshot contains messages that correspond to local optimistic ones,
    // drop those locals to avoid duplicate "blink" states.
    let base = a;
    try {
      for (const sm of b) base = reconcileOptimisticMessage(base, sm);
    } catch {
      // ignore; fallback to old merge behavior below
    }
    const locals = a.filter((m) => {
      const id = String(m?.id || "");
      if (!id) return false;
      if (seen.has(id)) return false;
      // Keep only optimistic/local messages (prevents flicker during background refresh).
      if (id.startsWith("local-")) return true;
      if (m?.clientStatus) return true;
      return false;
    });
    const merged = [...b, ...locals];
    merged.sort((x, y) => {
      const ax = Date.parse(String(x?.createdAtUtc || "")) || 0;
      const ay = Date.parse(String(y?.createdAtUtc || "")) || 0;
      return ax - ay;
    });
    return capMessagesList(merged);
  }
  const [userPresenceByUserId, setUserPresenceByUserId] = useState({});

  function sortDmChannels(list) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const key = (c) => {
      const s = String(c?.lastMessageAtUtc || c?.lastMessageAt || "");
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : 0;
    };
    return arr.sort((a, b) => key(b) - key(a));
  }

  function bumpDmChannelToTop(channelId, atUtc) {
    const cid = String(channelId || "");
    if (!cid) return;
    const at = String(atUtc || new Date().toISOString());
    setDmChannels((prev) => {
      const cur = Array.isArray(prev) ? prev : [];
      const hit = cur.find((c) => String(c?.id) === cid);
      if (!hit) return cur;
      const nextItem = { ...hit, lastMessageAtUtc: at };
      const rest = cur.filter((c) => String(c?.id) !== cid);
      return sortDmChannels([nextItem, ...rest]);
    });
  }

  const [newMessage, setNewMessage] = useState("");
  const [typingByChannelId, setTypingByChannelId] = useState(() => ({})); // channelId -> { userId: expiresAtMs }
  const typingSendRef = useRef({ lastSentAt: 0, t: null });
  const [newChannelName, setNewChannelName] = useState("");
  const [newVoiceChannelName, setNewVoiceChannelName] = useState("");
  const [showCreateTextChannel, setShowCreateTextChannel] = useState(false);
  const [showCreateVoiceChannel, setShowCreateVoiceChannel] = useState(false);
  const [activeVoiceChannelId, setActiveVoiceChannelId] = useState("");
  const [voicePeerNames, setVoicePeerNames] = useState({});
  const [inviteNickname, setInviteNickname] = useState("");
  const [showNewDmModal, setShowNewDmModal] = useState(false);
  const [userProfiles, setUserProfiles] = useState({}); // userId -> { nickname, avatarFileId }
  const [avatarUrlByFileId, setAvatarUrlByFileId] = useState({}); // fileId -> dataUrl
  const [userAvatarUrlByUserId, setUserAvatarUrlByUserId] = useState({}); // userId -> dataUrl
  const [serverAvatarUrlByServerId, setServerAvatarUrlByServerId] = useState({}); // serverId -> dataUrl
  const [serverMenuOpen, setServerMenuOpen] = useState(false);
  const [showRenameServer, setShowRenameServer] = useState(false);
  const [renameServerForm, setRenameServerForm] = useState({ name: "", description: "" });
  const [showRenameChannel, setShowRenameChannel] = useState(false);
  const [renameChannelForm, setRenameChannelForm] = useState({ id: "", name: "" });
  const [pendingByChatKey, setPendingByChatKey] = useState({}); // chatKey -> attachments[]
  const [showComposerAddMenu, setShowComposerAddMenu] = useState(false);
  const [mediaLightbox, setMediaLightbox] = useState({ open: false, dataUrl: "", name: "", fileId: "", kind: "image" });
  const [confirmModal, setConfirmModal] = useState({
    open: false,
    title: "",
    message: "",
    confirmText: "Удалить",
    checkbox: null
  });
  const [reportModal, setReportModal] = useState({ open: false, messageId: "", reason: "" });
  const confirmActionRef = useRef(null);
  const composerAddRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
  const sendChatInFlightRef = useRef(false);
  const fileUploadInFlightRef = useRef({ abort: null, attachmentId: "" });
  const unreadDividerRef = useRef(null);
  const didAutoScrollRef = useRef({}); // key: `${mode}:${channelId}` -> true

  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const chatKey = useMemo(() => {
    const cid = String(selectedChannelId || "");
    const mode = String(uiMode || "");
    return cid ? `${mode}:${cid}` : "";
  }, [uiMode, selectedChannelId]);

  const pendingAttachments = useMemo(() => {
    if (!chatKey) return [];
    const list = pendingByChatKey[chatKey];
    return Array.isArray(list) ? list : [];
  }, [pendingByChatKey, chatKey]);

  const setPendingAttachmentsForChat = useCallback((updater) => {
    const key = chatKey;
    if (!key) return;
    setPendingByChatKey((prev) => {
      const cur = Array.isArray(prev?.[key]) ? prev[key] : [];
      const next = typeof updater === "function" ? updater(cur) : updater;
      return { ...(prev || {}), [key]: next };
    });
  }, [chatKey]);
  const [authForm, setAuthForm] = useState({ login: "", password: "", nickname: "" });
  const [editForm, setEditForm] = useState({ nickname: "", bio: "" });
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [pwdForm, setPwdForm] = useState({ current: "", next: "", confirm: "" });
  const [pwdTouched, setPwdTouched] = useState(false);

  const [voiceState, setVoiceState] = useState({
    connected: false,
    joining: false,
    mediaLinkReady: false,
    sharingScreen: false,
    speakingUserIds: [],
    screenShareUserIds: [],
    mutedUserIds: [],
    deafenedUserIds: [],
    room: "",
    peers: 0,
    muted: false,
    deafened: false,
    remotePeerUserIds: [],
    rosterUserIds: []
  });
  const voicePresenceFetched = useRef(new Set());
  const [voicePresenceByChannelId, setVoicePresenceByChannelId] = useState({});
  const isUserSpeakingInVoice = useCallback((userId, channelId) => {
    if (voiceState.deafened) return false;
    const id = String(userId || "");
    const cid = String(channelId || "");
    const activeCid = String(activeVoiceChannelId || "");
    if (!id || !cid || !activeCid) return false;
    if (!voiceState.connected || activeCid !== cid) return false;
    if (id === String(profile?.id || "")) {
      if (voiceState.muted || voiceState.deafened) return false;
    } else if ((voiceState.mutedUserIds || []).some((x) => String(x) === id)) {
      return false;
    }
    return (voiceState.speakingUserIds || []).some((x) => String(x) === id);
  }, [
    activeVoiceChannelId,
    voiceState.connected,
    voiceState.muted,
    voiceState.deafened,
    voiceState.mutedUserIds,
    voiceState.speakingUserIds,
    profile?.id
  ]);
  const [screenView, setScreenView] = useState({ open: false, peerId: "", mode: "full" }); // mode: full | window
  const [screenWindowPos, setScreenWindowPos] = useState(() => ({ x: 0, y: 0, inited: false }));
  const screenDragRef = useRef({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, pointerId: 0 });
  const screenOverlayRef = useRef(null);
  const screenVideoRef = useRef(null);
  const mediaLightboxInnerRef = useRef(null);
  const mediaLightboxVideoRef = useRef(null);
  const mediaLightboxWindowFsFallbackRef = useRef(false);
  const [screenIsFullscreen, setScreenIsFullscreen] = useState(false);
  const screenWindowFsFallbackRef = useRef(false);
  const [screenControlsVisible, setScreenControlsVisible] = useState(true);
  const screenControlsHideTimerRef = useRef(null);
  const lastScreenTapRef = useRef({ at: 0, x: 0, y: 0 });
  const voiceRef = useRef(null);
  const connectVoiceInFlight = useRef(false);
  const pendingVoiceChannelId = useRef(null);
  const voiceJoinGeneration = useRef(0);
  const channelsRef = useRef([]);
  const serversRef = useRef([]);
  const voiceNamesFetched = useRef(new Set());
  const voiceNamesInFlight = useRef(new Set());
  const avatarPrefetchedRef = useRef(new Set());
  const profilePrefetchedRef = useRef(new Set());
  const [screenShareActionMenuOpen, setScreenShareActionMenuOpen] = useState(false);
  const screenShareMenuWrapRef = useRef(null);
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [audioDevices, setAudioDevices] = useState({ inputs: [], outputs: [] });
  const audioPermWarmRef = useRef({ tried: false, ok: false, at: 0 });
  const [audioSettings, setAudioSettings] = useState(() => {
    const read = (k, d) => {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : v;
      } catch {
        return d;
      }
    };
    return {
      inputDeviceId: read("sloncord_audio_input_device", ""),
      outputDeviceId: read("sloncord_audio_output_device", ""),
      micGain: Number(read("sloncord_audio_mic_gain", "100")) || 100,
      speakerGain: Number(read("sloncord_audio_speaker_gain", "100")) || 100,
      echoCancellation: String(read("sloncord_audio_ec", "1")) !== "0",
      noiseSuppression: String(read("sloncord_audio_ns", "1")) !== "0",
      autoGainControl: String(read("sloncord_audio_agc", "1")) !== "0",
      noiseReduction: Math.max(0, Math.min(100, Number(read("sloncord_audio_ns_level", "40")) || 40)),
      inputSensitivityAuto: String(read("sloncord_audio_sens_auto", "1")) !== "0",
      inputSensitivity: Number(read("sloncord_audio_sens", "50")) || 50
    };
  });

  const didInitialLoadRef = useRef(false);

  const [inputMeter, setInputMeter] = useState(() => ({ rms: 0, threshold: 0.03, open: false }));

  function buildVoiceProcessingOpts(s) {
    const reduction = Math.max(0, Math.min(100, Number(s?.noiseReduction ?? s?.noiseSuppressionLevel) || 0));
    return {
      echoCancellation: !!s?.echoCancellation,
      noiseSuppression: !!s?.noiseSuppression && reduction > 0,
      autoGainControl: !!s?.autoGainControl,
      noiseSuppressionLevel: reduction,
      inputSensitivityAuto: s?.inputSensitivityAuto !== false,
      inputSensitivity: Math.max(0, Math.min(100, Number(s?.inputSensitivity) || 50))
    };
  }

  function patchAudioSettings(patch) {
    setAudioSettings((p) => {
      const next = { ...p, ...patch };
      if (patch.echoCancellation != null) {
        try { localStorage.setItem("sloncord_audio_ec", next.echoCancellation ? "1" : "0"); } catch { /* ignore */ }
      }
      if (patch.noiseSuppression != null) {
        try { localStorage.setItem("sloncord_audio_ns", next.noiseSuppression ? "1" : "0"); } catch { /* ignore */ }
      }
      if (patch.autoGainControl != null) {
        try { localStorage.setItem("sloncord_audio_agc", next.autoGainControl ? "1" : "0"); } catch { /* ignore */ }
      }
      if (patch.noiseReduction != null) {
        try { localStorage.setItem("sloncord_audio_ns_level", String(next.noiseReduction)); } catch { /* ignore */ }
      }
      if (patch.inputSensitivityAuto != null) {
        try { localStorage.setItem("sloncord_audio_sens_auto", next.inputSensitivityAuto ? "1" : "0"); } catch { /* ignore */ }
      }
      if (patch.inputSensitivity != null) {
        try { localStorage.setItem("sloncord_audio_sens", String(next.inputSensitivity)); } catch { /* ignore */ }
      }
      try { voiceRef.current?.setAudioProcessing?.(buildVoiceProcessingOpts(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const isSloncordDesktop = useMemo(
    () => typeof window !== "undefined" && typeof window.sloncord?.getApiBase === "function",
    []
  );

  const [desktopPrefs, setDesktopPrefs] = useState({
    hotkeyToggleMic: "",
    hotkeyToggleDeafen: "",
    loginOpenAtLogin: false,
    loginStartHidden: false,
  });
  const [desktopHotkeyField, setDesktopHotkeyField] = useState(null);

  const [desktopDownloadInfo, setDesktopDownloadInfo] = useState(null);
  const apiBaseForDl = getApiBase();
  const isWindowsClient = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    try {
      const p = navigator.userAgentData?.platform;
      if (p) return /^Win/i.test(String(p));
    } catch {
      /* ignore */
    }
    return /Windows/i.test(navigator.userAgent || "");
  }, []);

  useEffect(() => {
    if (!isWindowsClient) {
      setDesktopDownloadInfo(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const j = await fetchDesktopReleaseFromGithub();
        if (!alive || !j) return;
        if (j.available === false) return;
        if (!j.version || !j.downloadUrl) return;
        setDesktopDownloadInfo(j);
      } catch {
        if (alive) setDesktopDownloadInfo(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [isWindowsClient]);

  useEffect(() => {
    if (!isSloncordDesktop || !audioSettingsOpen) return;
    let alive = true;
    window.sloncord
      ?.getDesktopPrefs?.()
      ?.then((p) => {
        if (!alive || !p) return;
        setDesktopPrefs({
          hotkeyToggleMic: String(p.hotkeyToggleMic || ""),
          hotkeyToggleDeafen: String(p.hotkeyToggleDeafen || ""),
          loginOpenAtLogin: !!p.loginOpenAtLogin,
          loginStartHidden: !!p.loginStartHidden,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isSloncordDesktop, audioSettingsOpen]);

  useEffect(() => {
    if (!isSloncordDesktop) return;
    const off1 = window.sloncord?.onHotkeyToggleMic?.(() => {
      try {
        voiceRef.current?.toggleMute?.();
      } catch {
        /* ignore */
      }
    });
    const off2 = window.sloncord?.onHotkeyToggleDeafen?.(() => {
      try {
        voiceRef.current?.toggleDeafen?.();
      } catch {
        /* ignore */
      }
    });
    return () => {
      try {
        off1?.();
      } catch {
        /* ignore */
      }
      try {
        off2?.();
      } catch {
        /* ignore */
      }
    };
  }, [isSloncordDesktop]);

  useEffect(() => {
    if (!desktopHotkeyField) return;
    const fn = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setDesktopHotkeyField(null);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const acc = keyboardEventToDesktopAccelerator(e);
      if (!acc) return;
      const patch =
        desktopHotkeyField === "mic" ? { hotkeyToggleMic: acc } : { hotkeyToggleDeafen: acc };
      setDesktopHotkeyField(null);
      void window.sloncord
        ?.setDesktopPrefs?.(patch)
        ?.then((r) => {
          if (r?.ok) setDesktopPrefs((p) => ({ ...p, ...patch }));
        })
        .catch(() => {});
    };
    window.addEventListener("keydown", fn, true);
    return () => window.removeEventListener("keydown", fn, true);
  }, [desktopHotkeyField]);

  useEffect(() => {
    if (!screenShareActionMenuOpen) return;
    const onDown = (e) => {
      try {
        if (screenShareMenuWrapRef.current?.contains(e.target)) return;
      } catch {
        /* ignore */
      }
      setScreenShareActionMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [screenShareActionMenuOpen]);

  useEffect(() => {
    if (!voiceState.sharingScreen) setScreenShareActionMenuOpen(false);
  }, [voiceState.sharingScreen]);

  useEffect(() => {
    if (!audioSettingsOpen) return;
    let alive = true;
    const t = setInterval(() => {
      if (!alive) return;
      try {
        const m = voiceRef.current?.getInputMeter?.();
        if (m) setInputMeter(m);
      } catch {
        // ignore
      }
    }, 80);
    return () => { alive = false; clearInterval(t); };
  }, [audioSettingsOpen]);
  const [userVolumePopup, setUserVolumePopup] = useState({
    open: false,
    userId: "",
    x: 0,
    y: 0,
    anchorX: 0,
    anchorY: 0,
    showVolume: false,
  });
  const userVolumePopupRef = useRef(null);

  function clampUserVolumeCardPosition(anchorX, anchorY, cardW, cardH) {
    const pad = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.max(200, Math.min(cardW, vw - pad * 2));
    const h = Math.max(120, Math.min(cardH, vh - pad * 2));
    let left = anchorX - w * 0.82;
    left = Math.max(pad, Math.min(vw - w - pad, left));
    let top = anchorY + 6;
    if (top + h > vh - pad) {
      top = anchorY - h - 6;
    }
    top = Math.max(pad, Math.min(vh - h - pad, top));
    return { x: left, y: top };
  }

  useLayoutEffect(() => {
    if (!userVolumePopup.open) return;
    const el = userVolumePopupRef.current;
    if (!el) return;
    const adjust = () => {
      const rect = el.getBoundingClientRect();
      const ax = Number(userVolumePopup.anchorX ?? userVolumePopup.x);
      const ay = Number(userVolumePopup.anchorY ?? userVolumePopup.y);
      const { x, y } = clampUserVolumeCardPosition(ax, ay, rect.width, rect.height);
      setUserVolumePopup((p) => {
        if (!p.open) return p;
        if (Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5) return p;
        return { ...p, x, y };
      });
    };
    adjust();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(adjust) : null;
    ro?.observe(el);
    window.addEventListener("resize", adjust);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", adjust);
    };
  }, [userVolumePopup.open, userVolumePopup.userId, userVolumePopup.anchorX, userVolumePopup.anchorY]);
  const [userCardDmDraft, setUserCardDmDraft] = useState("");
  const userVolumesRef = useRef({});
  useEffect(() => {
    try {
      userVolumesRef.current = JSON.parse(localStorage.getItem("sloncord_voice_user_volumes") || "{}") || {};
    } catch {
      userVolumesRef.current = {};
    }
  }, []);

  useEffect(() => {
    try {
      const dm = (dmChannels || []).reduce((acc, c) => acc + (Number(c?.unreadCount) || 0), 0);
      const srv = (servers || []).reduce((acc, s) => acc + (Number(s?.unreadCount) || 0), 0);
      const total = dm + srv;
      void window.sloncord?.setTaskbarBadge?.(total);
    } catch {
      /* ignore */
    }
  }, [dmChannels, servers]);

  useEffect(() => {
    if (!userVolumePopup.open) return undefined;
    const close = () => {
      setUserVolumePopup({ open: false, userId: "", x: 0, y: 0, anchorX: 0, anchorY: 0, showVolume: false });
      setUserCardDmDraft("");
    };
    const onPointerDown = (e) => {
      try {
        if (userVolumePopupRef.current?.contains(e.target)) return;
      } catch {
        /* ignore */
      }
      close();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userVolumePopup.open]);

  const remoteAudioHostRef = useRef(null);
  const remoteVideoHostRef = useRef(null);
  const hubRef = useRef(null);
  const messagesBoxRef = useRef(null);
  const messagesEndRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const scrollStickRef = useRef({ raf: 0 });
  const voiceStateRef = useRef(null);
  const activeVoiceChannelIdRef = useRef("");
  const pageStateRef = useRef({}); // key -> { loadingOlder: bool, hasMoreOlder: bool }
  const loadOlderInFlightRef = useRef(false);
  const loadOlderCooldownRef = useRef({ at: 0 });
  const dmActiveCallSessionRef = useRef({ callId: "", channelId: "", state: "" }); // state: ringing | active
  const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000001";

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);
  useEffect(() => {
    activeVoiceChannelIdRef.current = String(activeVoiceChannelId || "");
  }, [activeVoiceChannelId]);

  function pageKey() {
    return `${String(uiModeRef.current)}:${String(selectedChannelIdRef.current)}`;
  }

  function setHasMoreOlderForCurrent(v) {
    const k = pageKey();
    const cur = pageStateRef.current[k] || {};
    pageStateRef.current[k] = { ...cur, hasMoreOlder: !!v };
  }

  function setLoadingOlderForCurrent(v) {
    const k = pageKey();
    const cur = pageStateRef.current[k] || {};
    pageStateRef.current[k] = { ...cur, loadingOlder: !!v };
  }

  function getPageStateForCurrent() {
    const k = pageKey();
    const cur = pageStateRef.current[k] || {};
    return { loadingOlder: !!cur.loadingOlder, hasMoreOlder: cur.hasMoreOlder !== false };
  }

  function scrollToBottomIfPinned() {
    if (!shouldAutoScrollRef.current) return;
    const el = messagesBoxRef.current;
    if (!el) return;
    const stick = () => {
      try { el.scrollTop = el.scrollHeight; } catch { /* ignore */ }
    };
    try { cancelAnimationFrame(scrollStickRef.current.raf); } catch { /* ignore */ }
    scrollStickRef.current.raf = requestAnimationFrame(() => {
      stick();
      scrollStickRef.current.raf = requestAnimationFrame(stick);
    });
  }

  const [editing, setEditing] = useState({ id: "", text: "", originalText: "", removeAttachmentFileIds: [] });
  const [messageMenu, setMessageMenu] = useState({ openForId: "", x: 0, y: 0 });
  const messageMenuRef = useRef(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState("");
  const messageHighlightTimerRef = useRef(null);
  const [channelMenu, setChannelMenu] = useState({ openForId: "", x: 0, y: 0 });
  const channelMenuRef = useRef(null);
  const [channelDropLine, setChannelDropLine] = useState(null);
  const channelDragRef = useRef(null);
  const voiceUserDragRef = useRef(null);
  const [voiceUserDropTarget, setVoiceUserDropTarget] = useState(null);
  const [showCreateCategory, setShowCreateCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showRenameCategory, setShowRenameCategory] = useState(false);
  const [renameCategoryForm, setRenameCategoryForm] = useState({ id: "", name: "" });
  const [channelsContextMenu, setChannelsContextMenu] = useState({ open: false, x: 0, y: 0 });
  const channelsContextMenuRef = useRef(null);
  const [pendingChannelCategoryId, setPendingChannelCategoryId] = useState("");
  const [channelAccessModal, setChannelAccessModal] = useState({
    open: false,
    channelId: "",
    channelName: "",
    loading: false,
    saving: false,
    serverMembers: [],
    selectedUserIds: new Set(),
    initialMemberIds: new Set(),
  });
  const [categoryAccessModal, setCategoryAccessModal] = useState({
    open: false,
    categoryId: "",
    categoryName: "",
    loading: false,
    saving: false,
    serverMembers: [],
    selectedUserIds: new Set(),
    initialMemberIds: new Set(),
  });
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState(() => new Set());
  const [newCategoryPrivate, setNewCategoryPrivate] = useState(false);
  const [newChannelPrivate, setNewChannelPrivate] = useState(false);
  const [newVoiceChannelPrivate, setNewVoiceChannelPrivate] = useState(false);
  const [replyDraft, setReplyDraft] = useState(null); // { id, senderNickname, text, firstAttachment? }

  useEffect(() => {
    const onDragEnd = () => {
      voiceUserDragRef.current = null;
      setVoiceUserDropTarget(null);
    };
    document.addEventListener("dragend", onDragEnd);
    return () => document.removeEventListener("dragend", onDragEnd);
  }, []);

  const beginReplyDraft = useCallback((draft) => {
    setReplyDraft(draft);
    requestAnimationFrame(() => {
      try { composerInputRef.current?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    });
  }, []);
  const [forwardModal, setForwardModal] = useState({ open: false, query: "", selectedIds: {}, source: null });
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // Mobile swipe-to-reply (Discord-like)
  const swipeReplyRef = useRef({ active: false, msgId: "", startX: 0, startY: 0, lastDx: 0, locked: "" }); // locked: "" | "h" | "v"
  const [swipeReplyUi, setSwipeReplyUi] = useState({ msgId: "", progress: 0 }); // progress 0..1

  // DM call UI (ringing)
  const [dmCall, setDmCall] = useState({ incoming: null, outgoing: null }); // incoming/outgoing: { callId, channelId, fromUserId, fromNickname }
  const dmCallRef = useRef(dmCall);
  dmCallRef.current = dmCall;
  const dmRingtoneRef = useRef({ stopIncoming: null, stopOutgoing: null });

  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches);
  /** На телефонах: список чатов или открытое обсуждение */
  const [mobileView, setMobileView] = useState("list");
  const [membersSheet, setMembersSheet] = useState(false);

  const selectedChannelIdRef = useRef("");
  const uiModeRef = useRef("server");
  const profileRef = useRef(null);
  const dmChannelsRef = useRef([]);
  serversRef.current = servers;
  selectedChannelIdRef.current = selectedChannelId;
  uiModeRef.current = uiMode;
  profileRef.current = profile;
  dmChannelsRef.current = dmChannels;
  messagesRef.current = messages;

  /** For stale-response guards: only apply fetched data if this channel is still open. */
  function isStillOnChannel(channelId) {
    return String(selectedChannelIdRef.current) === String(channelId);
  }

  const channels = useMemo(() => {
    if (uiMode === "dm") return [];
    const s = servers.find((x) => String(x.id) === String(selectedServerId));
    return s?.channels || [];
  }, [servers, selectedServerId, uiMode]);

  const selectedServer = useMemo(
    () => servers.find((s) => String(s.id) === String(selectedServerId)) || null,
    [servers, selectedServerId]
  );

  const [serverBlacklistOpen, setServerBlacklistOpen] = useState(false);
  const [serverBans, setServerBans] = useState([]);
  const [serverBansLoading, setServerBansLoading] = useState(false);

  function serverAdminUserIds(server) {
    return (server?.adminUserIds || []).map((x) => String(x));
  }
  function isServerOwnerUser(server, userId) {
    return !!server && String(server.ownerUserId) === String(userId);
  }
  function isServerAdminUser(server, userId) {
    return !!server && serverAdminUserIds(server).includes(String(userId));
  }
  function isPlatformModeratorUser() {
    return !!(profile?.isPlatformModerator || profile?.isPlatformRoot);
  }
  function isEffectiveServerOwner(server, profileId) {
    if (!server || !profileId) return false;
    return isServerOwnerUser(server, profileId) || isPlatformModeratorUser();
  }
  function canModerateServerUser(server, profileId) {
    if (!server || !profileId) return false;
    if (isPlatformModeratorUser()) return true;
    return isServerOwnerUser(server, profileId) || isServerAdminUser(server, profileId);
  }
  function canManageServerChannel(channel, server, profileId) {
    if (!channel || !profileId) return false;
    if (isPlatformModeratorUser()) return true;
    if (String(channel.ownerUserId) === String(profileId)) return true;
    return isServerOwnerUser(server, profileId) || isServerAdminUser(server, profileId);
  }
  function canModerateMember(targetUserId) {
    if (!selectedServer || !profile?.id) return false;
    const tid = String(targetUserId);
    const me = String(profile.id);
    if (tid === me) return false;
    if (isServerOwnerUser(selectedServer, tid)) return false;
    if (!canModerateServerUser(selectedServer, me)) return false;
    if (isServerAdminUser(selectedServer, tid) && !isServerOwnerUser(selectedServer, me)) return false;
    return true;
  }
  function memberRoleBadge(userId) {
    if (!selectedServer) return null;
    if (isServerOwnerUser(selectedServer, userId)) {
      return <span className="role-badge role-badge--owner" title="Создатель сервера" aria-label="Создатель сервера"><SlonIcon name="star" size={12} /></span>;
    }
    if (isServerAdminUser(selectedServer, userId)) {
      return <span className="role-badge role-badge--admin" title="Администратор" aria-label="Администратор"><SlonIcon name="diamond" size={12} /></span>;
    }
    return null;
  }
  function memberRoleBadgeSlot(userId) {
    const badge = memberRoleBadge(userId);
    return <span className="member-role-badge-slot">{badge}</span>;
  }
  function memberKickSlot(userId) {
    return (
      <span className="member-kick-slot">
        {canModerateMember(userId) ? (
          <button
            type="button"
            className="icon-btn danger member-kick-btn"
            title="Исключить с сервера"
            aria-label="Исключить с сервера"
            onClick={(e) => {
              e.stopPropagation();
              const m = (members || []).find((x) => String(x.id) === String(userId));
              if (m) confirmKickMember(m);
            }}
          >
            <SlonIcon name="kick" size={16} />
          </button>
        ) : null}
      </span>
    );
  }
  const activeVoiceInfo = useMemo(() => {
    const vid = String(activeVoiceChannelId || "");
    if (!vid) return null;
    for (const s of servers || []) {
      const ch = (s.channels || []).find((c) => String(c.id) === vid);
      if (ch) return { kind: "server", server: s, channel: ch };
    }
    const dm = (dmChannels || []).find((c) => String(c.id) === vid);
    if (dm) return { kind: "dm", server: null, channel: dm };
    return null;
  }, [servers, dmChannels, activeVoiceChannelId]);

  const allVoiceChannels = useMemo(() => channels.filter((c) => c.kind === "voice"), [channels]);
  const uncategorizedChannels = useMemo(
    () => channels
      .filter((c) => !c.categoryId)
      .sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0)),
    [channels]
  );
  const serverCategories = useMemo(() => {
    const cats = Array.isArray(selectedServer?.categories) ? selectedServer.categories.slice() : [];
    return cats.sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
  }, [selectedServer]);
  const categoriesById = useMemo(() => {
    const map = new Map();
    for (const cat of serverCategories) map.set(String(cat.id), cat);
    return map;
  }, [serverCategories]);
  const channelsByCategoryId = useMemo(() => {
    const map = new Map();
    for (const ch of channels) {
      const cid = String(ch?.categoryId || "");
      if (!cid) continue;
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid).push(ch);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
    }
    return map;
  }, [channels]);
  const unreadDmSidebarAvatars = useMemo(() => {
    const meId = String(profile?.id || "");
    return (dmChannels || [])
      .filter((c) => Number(c?.unreadCount) > 0)
      .sort((a, b) => {
        const ta = Date.parse(String(a?.lastMessageAtUtc || ""));
        const tb = Date.parse(String(b?.lastMessageAtUtc || ""));
        return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
      })
      .slice(0, 6)
      .map((channel) => {
        const ids = Array.isArray(channel.memberUserIds) ? channel.memberUserIds : [];
        const otherId = String(ids.map(String).find((x) => x && x !== meId) || "");
        return {
          channelId: String(channel.id),
          otherId,
          nick: String(channel.name || ""),
          avatarUrl: otherId ? userAvatarUrlByUserId[otherId] : "",
          unreadCount: Number(channel.unreadCount) || 0,
        };
      });
  }, [dmChannels, profile?.id, userAvatarUrlByUserId]);

  function isUserInServerVoice(userId) {
    const uid = String(userId);
    for (const ch of allVoiceChannels) {
      const p = voicePresenceByChannelId[String(ch.id)];
      if (Array.isArray(p?.userIds) && p.userIds.map((x) => String(x)).includes(uid)) return true;
    }
    return false;
  }

  const selectedChannel = useMemo(() => {
    if (uiMode === "dm")
      return dmChannels.find((c) => c.id === selectedChannelId) || null;
    const c = channels.find((c) => c.id === selectedChannelId);
    if (!c) return null;
    if (c.kind === "voice") return null;
    return c;
  }, [channels, dmChannels, selectedChannelId, uiMode]);

  useEffect(() => {
    const sid = String(selectedServerId || "");
    if (!sid) {
      setCollapsedCategoryIds(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(`sloncord_collapsed_categories_${sid}`);
      const arr = JSON.parse(raw || "[]");
      setCollapsedCategoryIds(new Set((Array.isArray(arr) ? arr : []).map(String)));
    } catch {
      setCollapsedCategoryIds(new Set());
    }
  }, [selectedServerId]);

  function isCategoryCollapsed(catId) {
    return collapsedCategoryIds.has(String(catId || ""));
  }

  function toggleCategoryCollapsed(catId) {
    const id = String(catId || "");
    if (!id) return;
    const sid = String(selectedServerId || "");
    setCollapsedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(`sloncord_collapsed_categories_${sid}`, JSON.stringify([...next]));
      } catch { /* ignore */ }
      return next;
    });
  }

  function shouldShowChannelInCollapsedCategory(channel, catId) {
    if (!isCategoryCollapsed(catId)) return true;
    const cid = String(channel?.id || "");
    if (!cid) return false;
    if (String(activeVoiceChannelId) === cid && (voiceState.connected || voiceState.joining)) return true;
    if (uiMode === "server" && String(selectedChannelId) === cid && String(channel?.kind) !== "voice") return true;
    return false;
  }

  function categoryShowsPrivate(catId) {
    const cat = categoriesById.get(String(catId || ""));
    return !!cat?.isPrivate;
  }

  function channelShowsPrivate(channel, catId) {
    return !!channel?.isPrivate || categoryShowsPrivate(catId);
  }

  channelsRef.current = channels;

  function clearAlerts() {
    setStatus("");
    setError("");
  }

  function askConfirm({ title, message, confirmText, checkbox }, onConfirm) {
    confirmActionRef.current = onConfirm;
    setConfirmModal({
      open: true,
      title,
      message,
      confirmText: confirmText || "Удалить",
      checkbox: checkbox || null
    });
  }

  async function openChannelAccessModal(channel) {
    if (!channel?.id || !selectedServer?.id) return;
    const channelId = String(channel.id);
    setChannelAccessModal({
      open: true,
      channelId,
      channelName: String(channel.name || ""),
      loading: true,
      saving: false,
      serverMembers: [],
      selectedUserIds: new Set(),
      initialMemberIds: new Set(),
    });
    try {
      const [serverMembers, channelMembers] = await Promise.all([
        api(`/servers/${selectedServer.id}/members`, { method: "GET" }),
        api(`/channels/${channelId}/members`, { method: "GET" }),
      ]);
      const selected = new Set(
        (Array.isArray(channelMembers) ? channelMembers : []).map((m) => String(m?.id || "")).filter(Boolean)
      );
      setChannelAccessModal((prev) => ({
        ...prev,
        loading: false,
        serverMembers: Array.isArray(serverMembers) ? serverMembers : [],
        selectedUserIds: new Set(selected),
        initialMemberIds: new Set(selected),
      }));
    } catch (e) {
      setChannelAccessModal((prev) => ({ ...prev, open: false, loading: false }));
      setError(e?.message || String(e));
    }
  }

  async function saveChannelAccessModal() {
    const channelId = String(channelAccessModal.channelId || "");
    if (!channelId || channelAccessModal.saving) return;
    setChannelAccessModal((prev) => ({ ...prev, saving: true }));
    try {
      const initial = channelAccessModal.initialMemberIds instanceof Set
        ? channelAccessModal.initialMemberIds
        : new Set(channelAccessModal.initialMemberIds || []);
      const next = channelAccessModal.selectedUserIds instanceof Set
        ? channelAccessModal.selectedUserIds
        : new Set(channelAccessModal.selectedUserIds || []);
      const toAdd = [...next].filter((id) => id && !initial.has(id));
      const toRemove = [...initial].filter((id) => id && !next.has(id));
      for (const userId of toAdd) {
        await api(`/channels/${channelId}/members`, {
          method: "POST",
          body: JSON.stringify({ userId }),
        });
      }
      for (const userId of toRemove) {
        await api(`/channels/${channelId}/members/${userId}`, { method: "DELETE" });
      }
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setChannelAccessModal({
        open: false,
        channelId: "",
        channelName: "",
        loading: false,
        saving: false,
        serverMembers: [],
        selectedUserIds: new Set(),
        initialMemberIds: new Set(),
      });
      setStatus("Доступ к каналу обновлён");
    } catch (e) {
      setChannelAccessModal((prev) => ({ ...prev, saving: false }));
      setError(e?.message || String(e));
    }
  }

  function toggleChannelAccessUser(userId) {
    const id = String(userId || "");
    if (!id) return;
    setChannelAccessModal((prev) => {
      const next = new Set(prev.selectedUserIds instanceof Set ? prev.selectedUserIds : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, selectedUserIds: next };
    });
  }

  async function openCategoryAccessModal(cat) {
    if (!cat?.id || !selectedServer?.id) return;
    const categoryId = String(cat.id);
    setCategoryAccessModal({
      open: true,
      categoryId,
      categoryName: String(cat.name || ""),
      loading: true,
      saving: false,
      serverMembers: [],
      selectedUserIds: new Set(),
      initialMemberIds: new Set(),
    });
    try {
      const [serverMembers, categoryMembers] = await Promise.all([
        api(`/servers/${selectedServer.id}/members`, { method: "GET" }),
        api(`/categories/${categoryId}/members`, { method: "GET" }),
      ]);
      const selected = new Set(
        (Array.isArray(categoryMembers) ? categoryMembers : []).map((m) => String(m?.id || "")).filter(Boolean)
      );
      setCategoryAccessModal((prev) => ({
        ...prev,
        loading: false,
        serverMembers: Array.isArray(serverMembers) ? serverMembers : [],
        selectedUserIds: new Set(selected),
        initialMemberIds: new Set(selected),
      }));
    } catch (e) {
      setCategoryAccessModal((prev) => ({ ...prev, open: false, loading: false }));
      setError(e?.message || String(e));
    }
  }

  async function saveCategoryAccessModal() {
    const categoryId = String(categoryAccessModal.categoryId || "");
    if (!categoryId || categoryAccessModal.saving) return;
    setCategoryAccessModal((prev) => ({ ...prev, saving: true }));
    try {
      const initial = categoryAccessModal.initialMemberIds instanceof Set
        ? categoryAccessModal.initialMemberIds
        : new Set(categoryAccessModal.initialMemberIds || []);
      const next = categoryAccessModal.selectedUserIds instanceof Set
        ? categoryAccessModal.selectedUserIds
        : new Set(categoryAccessModal.selectedUserIds || []);
      const toAdd = [...next].filter((id) => id && !initial.has(id));
      const toRemove = [...initial].filter((id) => id && !next.has(id));
      for (const userId of toAdd) {
        await api(`/categories/${categoryId}/members`, {
          method: "POST",
          body: JSON.stringify({ userId }),
        });
      }
      for (const userId of toRemove) {
        await api(`/categories/${categoryId}/members/${userId}`, { method: "DELETE" });
      }
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setCategoryAccessModal({
        open: false,
        categoryId: "",
        categoryName: "",
        loading: false,
        saving: false,
        serverMembers: [],
        selectedUserIds: new Set(),
        initialMemberIds: new Set(),
      });
      setStatus("Доступ к категории обновлён");
    } catch (e) {
      setCategoryAccessModal((prev) => ({ ...prev, saving: false }));
      setError(e?.message || String(e));
    }
  }

  function toggleCategoryAccessUser(userId) {
    const id = String(userId || "");
    if (!id) return;
    setCategoryAccessModal((prev) => {
      const next = new Set(prev.selectedUserIds instanceof Set ? prev.selectedUserIds : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { ...prev, selectedUserIds: next };
    });
  }

  async function setCategoryPrivate(categoryId, isPrivate) {
    clearAlerts();
    const id = String(categoryId || "");
    if (!id) return;
    try {
      await api(`/categories/${id}/privacy`, {
        method: "PUT",
        body: JSON.stringify({ isPrivate: !!isPrivate }),
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setStatus(isPrivate ? "Категория сделана приватной" : "Категория сделана публичной");
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function refreshMembersList() {
    if (!selectedChannelId) return;
    const users = await api(`/channels/${selectedChannelId}/members`, { method: "GET" });
    setMembers(users || []);
  }

  async function kickMemberFromServer(userId) {
    clearAlerts();
    try {
      if (!token) return;
      if (!selectedServer?.id) return;
      await api(`/servers/${selectedServer.id}/members/${userId}`, { method: "DELETE" });
      await refreshMembersList();
      setUserVolumePopup({ open: false, userId: "", x: 0, y: 0, anchorX: 0, anchorY: 0 });
      setStatus("Участник удалён");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function banMemberFromServer(userId) {
    clearAlerts();
    try {
      if (!token || !selectedServer?.id) return;
      await api(`/servers/${selectedServer.id}/members/${userId}/ban`, { method: "POST" });
      await refreshMembersList();
      setUserVolumePopup({ open: false, userId: "", x: 0, y: 0, anchorX: 0, anchorY: 0 });
      setStatus("Пользователь забанен");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function toggleMemberAdmin(userId, makeAdmin) {
    clearAlerts();
    try {
      if (!token || !selectedServer?.id) return;
      await api(`/servers/${selectedServer.id}/members/${userId}/admin`, {
        method: "PUT",
        body: JSON.stringify({ isAdmin: !!makeAdmin })
      });
      setStatus(makeAdmin ? "Права администратора выданы" : "Права администратора сняты");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function disconnectMemberVoice(userId) {
    clearAlerts();
    try {
      if (!token || !selectedServer?.id) return;
      await api(`/servers/${selectedServer.id}/members/${userId}/disconnect-voice`, { method: "POST" });
      setStatus("Пользователь отключён от голосового канала");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function openServerBlacklist() {
    if (!selectedServer?.id) return;
    setServerBlacklistOpen(true);
    setServerBansLoading(true);
    try {
      const list = await api(`/servers/${selectedServer.id}/bans`, { method: "GET" });
      setServerBans(Array.isArray(list) ? list : []);
    } catch (e) {
      setError(e.message || String(e));
      setServerBans([]);
    } finally {
      setServerBansLoading(false);
    }
  }

  async function unbanServerMember(userId) {
    clearAlerts();
    try {
      if (!token || !selectedServer?.id) return;
      await api(`/servers/${selectedServer.id}/bans/${userId}`, { method: "DELETE" });
      setServerBans((prev) => (Array.isArray(prev) ? prev.filter((b) => String(b.userId) !== String(userId)) : []));
      setStatus("Пользователь разбанен");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  function confirmBanMember(member) {
    if (!member?.id || !selectedServer?.id) return;
    askConfirm(
      {
        title: "Забанить участника",
        message: `Забанить «${member.nickname || ""}» на сервере «${selectedServer?.name || ""}»? Пользователь не сможет снова присоединиться по приглашению.`,
        confirmText: "Забанить"
      },
      async () => banMemberFromServer(member.id)
    );
  }

  function confirmDeleteServer(server) {
    if (!server?.id) return;
    askConfirm(
      {
        title: "Удалить сервер",
        message: `Вы точно хотите удалить сервер "${server.name || ""}"?`,
        confirmText: "Удалить"
      },
      async () => deleteServer(server.id)
    );
  }

  function confirmDeleteChannel(channel) {
    if (!channel?.id) return;
    askConfirm(
      {
        title: "Удалить канал",
        message: `Вы точно хотите удалить канал "${channel.name || ""}"?`,
        confirmText: "Удалить"
      },
      async () => deleteChannel(channel.id)
    );
  }

  function confirmDeleteMessage(msg) {
    if (!msg?.id) return;
    askConfirm(
      {
        title: "Удалить сообщение",
        message: "Вы точно хотите удалить это сообщение?",
        confirmText: "Удалить"
      },
      async () => deleteMessage(msg.id)
    );
  }

  function confirmDeleteDmChannel(channel) {
    if (!channel?.id) return;
    askConfirm(
      {
        title: "Удалить личный чат",
        message: `Удалить переписку с ${channel.name || ""}?`,
        confirmText: "Удалить",
        checkbox: { label: "Удалить у собеседника", checked: true }
      },
      async (opts) => deleteDirectConversation(String(channel.id), opts?.deleteForPeer ?? true)
    );
  }

  function confirmKickMember(member) {
    if (!member?.id || !selectedServer?.id) return;
    askConfirm(
      {
        title: "Удалить участника",
        message: `Вы точно хотите удалить участника "${member.nickname || ""}" с сервера "${selectedServer?.name || ""}"?`,
        confirmText: "Удалить"
      },
      async () => kickMemberFromServer(member.id)
    );
  }

  function confirmLeaveServer(server) {
    if (!server?.id) return;
    askConfirm(
      {
        title: "Покинуть сервер",
        message: `Вы точно хотите покинуть сервер "${server.name || ""}"?`,
        confirmText: "Покинуть"
      },
      async () => leaveServer(server.id)
    );
  }

  function confirmLeaveChannel(channel) {
    if (!channel?.id) return;
    askConfirm(
      {
        title: "Покинуть канал",
        message: `Вы точно хотите покинуть канал "${channel.name || ""}"?`,
        confirmText: "Покинуть"
      },
      async () => leaveChannel(channel.id)
    );
  }

  useEffect(() => {
    if (!status) return undefined;
    const t = setTimeout(() => setStatus(""), 8000);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(""), 22000);
    return () => clearTimeout(t);
  }, [error]);

  useEffect(() => {
    const onSilent = (ev: Event) => {
      try {
        const ce = ev as CustomEvent<{ message?: string }>;
        const m = String(ce?.detail?.message || "").trim();
        if (m) setError(m);
      } catch {
        /* ignore */
      }
    };
    const onCaptureMode = (ev: Event) => {
      try {
        const ce = ev as CustomEvent<{ message?: string }>;
        const m = String(ce?.detail?.message || "").trim();
        if (m) setStatus(m);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("sloncord:native-screen-audio-silence", onSilent as EventListener);
    window.addEventListener("sloncord:native-screen-audio-capture-mode", onCaptureMode as EventListener);
    return () => {
      window.removeEventListener("sloncord:native-screen-audio-silence", onSilent as EventListener);
      window.removeEventListener("sloncord:native-screen-audio-capture-mode", onCaptureMode as EventListener);
    };
  }, []);

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(`${getApiBase()}${path}`, { ...options, headers });
    } catch (err) {
      const raw = String(err?.message || err || "");
      if (/failed to fetch/i.test(raw)) {
        throw new Error(
          "Нет связи с сервером Sloncord. Проверьте интернет и адрес API (https://136.234.12.106)."
        );
      }
      throw err instanceof Error ? err : new Error(raw || "Сетевая ошибка");
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      let message = data?.error || data?.title || `Ошибка ${response.status}`;
      const banMsg = formatPlatformBanMessage(data);
      if (banMsg) message = banMsg;
      // If server returned non-JSON (often HTML on 500), surface a short snippet for debugging.
      if ((!data || typeof data === "string") && text) {
        const snippet = String(text)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        if (snippet && !banMsg) message = `${message}: ${snippet}`;
      }
      throw new Error(message);
    }
    return data;
  }

  const apiRef = useRef(api);
  apiRef.current = api;

  async function ensureAvatarUrl(fileId) {
    const fid = String(fileId || "");
    if (!fid) return "";
    let hit = getCachedAvatarUrl(fid) || avatarUrlByFileId[fid] || "";
    if (hit.startsWith("data:")) hit = "";
    if (hit.startsWith("blob:")) {
      putCachedAvatarUrl(fid, hit);
      return hit;
    }
    try {
      const data = await api(`/avatars/${fid}`, { method: "GET" });
      const ct = data?.contentType || "image/png";
      const b64 = data?.fileBase64 || "";
      if (!b64) return "";
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
      const blob = new Blob([arr], { type: ct });
      const url = putCachedAvatarUrl(fid, URL.createObjectURL(blob));
      setAvatarUrlByFileId((prev) => {
        const old = prev[fid];
        if (old && old !== url && old.startsWith("blob:")) {
          try { URL.revokeObjectURL(old); } catch { /* ignore */ }
        }
        return { ...prev, [fid]: url };
      });
      return url;
    } catch {
      return "";
    }
  }

  async function ensureUserProfile(userId) {
    const id = String(userId || "");
    if (!id) return null;
    if (userProfiles[id]) {
      const up = userProfiles[id];
      // Ensure voice roster name/avatar caches are populated even if the profile was cached earlier.
      if (up?.nickname && !voicePeerNames[String(id)]) {
        setVoicePeerNames((prev) => ({ ...prev, [id]: up.nickname }));
      }
      if (up?.avatarFileId && !userAvatarUrlByUserId[String(id)]) {
        try {
          const url = await ensureAvatarUrl(up.avatarFileId);
          if (url) setUserAvatarUrlByUserId((prev) => ({ ...prev, [id]: url }));
        } catch {
          // ignore
        }
      }
      return up;
    }
    try {
      const p = await api(`/profile/${id}`, { method: "GET" });
      const up = {
        nickname: p.nickname || id,
        avatarFileId: p.avatarFileId || "",
        bio: p.bio || "",
        ...teamFlagsFromProfile(p),
      };
      setUserProfiles((prev) => trimProfileCache({ ...prev, [id]: up }));
      setVoicePeerNames((prev) => ({ ...prev, [id]: up.nickname }));
      // keep live presence map warm on first fetch
      try {
        if (p?.online != null || p?.lastSeenAtUtc) {
          setUserPresenceByUserId((prev) => ({
            ...prev,
            [String(id)]: { online: !!p?.online, lastSeenAtUtc: p?.lastSeenAtUtc || "" }
          }));
        }
      } catch {
        // ignore
      }
      if (up.avatarFileId) {
        const url = await ensureAvatarUrl(up.avatarFileId);
        if (url) setUserAvatarUrlByUserId((prev) => ({ ...prev, [id]: url }));
      }
      return up;
    } catch {
      return null;
    }
  }

  const messageAvatarUrl = useCallback(
    (msg) => {
      const uid = String(msg?.senderUserId || "");
      if (uid && userAvatarUrlByUserId[uid]) return userAvatarUrlByUserId[uid];
      const fid = String(msg?.senderAvatarFileId || "");
      if (fid && avatarUrlByFileId[fid]) return avatarUrlByFileId[fid];
      return "";
    },
    [avatarUrlByFileId, userAvatarUrlByUserId]
  );

  function addFilesToPendingForCurrentChat(filesRaw) {
    try {
      if (!selectedChannelIdRef.current) return;
      const files = Array.isArray(filesRaw) ? filesRaw : Array.from(filesRaw || []);
      const clean = files.filter((f) => f && typeof f === "object");
      if (!clean.length) return;
      const next = clean.map((file) => {
        const id = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let previewUrl = "";
        try { previewUrl = URL.createObjectURL(file); } catch { previewUrl = ""; }
        return {
          id,
          file,
          previewUrl,
          status: "queued",
          progress: 0,
          errorMessage: "",
          abortController: null
        };
      });
      setPendingAttachmentsForChat((prev) => ([...(prev || []), ...next]));
    } catch {
      // ignore
    }
  }

  function handleComposerPaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const added = [];
    /** Один и тот же файл иногда приходит в двух clipboard items (Win/Chrome). */
    const seenBlobKeys = new Set();
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      // Accept ANY file kind (images, videos, documents, etc)
      if (it.kind === "file") {
        e.preventDefault();
        const blob = it.getAsFile();
        if (!blob) continue;
        const dedupeKey = `${blob.size}\0${blob.type || it.type || ""}`;
        if (seenBlobKeys.has(dedupeKey)) continue;
        seenBlobKeys.add(dedupeKey);
        const fallbackName =
          it.type?.startsWith("image/") ? `paste-${Date.now()}.png`
          : it.type?.startsWith("video/") ? `paste-${Date.now()}.mp4`
          : `paste-${Date.now()}.bin`;
        const name = blob.name && blob.name !== "image.png" ? blob.name : fallbackName;
        const f = blob.name ? blob : new File([blob], name, { type: blob.type || it.type || "application/octet-stream" });
        const id = `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        let previewUrl = "";
        try { previewUrl = URL.createObjectURL(f); } catch { previewUrl = ""; }
        added.push({
          id,
          file: f,
          previewUrl,
          status: "queued",
          progress: 0,
          errorMessage: "",
          abortController: null
        });
      }
    }
    if (added.length) {
      e.stopPropagation();
      setPendingAttachmentsForChat((prev) => [...(prev || []), ...added]);
      setShowComposerAddMenu(false);
    }
  }

  // use global RT constants (top of file)

  function patchUnreadState(channelId, unread) {
    const id = String(channelId);
    const n = Number(unread) || 0;
    setServers((prev) =>
      prev.map((s) => ({
        ...s,
        channels: (s.channels || []).map((c) => (String(c.id) === id ? { ...c, unreadCount: n } : c))
      }))
    );
    setDmChannels((prev) => prev.map((c) => (String(c.id) === id ? { ...c, unreadCount: n } : c)));
  }

  function showLocalNotification(title, body) {
    (async () => {
      try {
        if (typeof window !== "undefined" && window.sloncord?.showNativeMessageNotification) {
          const r = await window.sloncord.showNativeMessageNotification({
            title: String(title || ""),
            body: String(body || "")
          });
          if (r?.ok !== false) return;
        }
      } catch {
        /* fall through to web */
      }
      try {
        if (!("Notification" in window)) return;
        if (Notification.permission !== "granted") return;
        // First try the direct Notification constructor (fast path).
        // eslint-disable-next-line no-new
        new Notification(title, { body, silent: false });
        return;
      } catch {
        // Fallback: some browsers are picky about constructor usage; SW showNotification is more reliable.
      }
      try {
        if (!("serviceWorker" in navigator)) return;
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) return;
        await reg.showNotification(title, { body, silent: false });
      } catch {
        // ignore
      }
    })();
  }

  const notifAudioCtxRef = useRef(null);
  const notifSoundUnlockedRef = useRef(false);
  const lastNotifBeepAtRef = useRef(0);
  const lastVoiceSfxAtRef = useRef(0);
  const lastSelfVoiceConnectAtRef = useRef(0);
  const suppressNextVoiceJoinSfxRef = useRef(false);

  const NOTIF_SERVER_KEY_PREFIX = "sloncord_notif_server_"; // + serverId
  const NOTIF_DM_KEY_PREFIX = "sloncord_notif_dm_"; // + channelId
  function readNotifPrefs(key) {
    try {
      const raw = localStorage.getItem(key) || "";
      const j = raw ? JSON.parse(raw) : {};
      return {
        sound: j?.sound !== false, // default true
        banners: j?.banners !== false // default true
      };
    } catch {
      return { sound: true, banners: true };
    }
  }
  function writeNotifPrefs(key, prefs) {
    try { localStorage.setItem(key, JSON.stringify({ sound: !!prefs.sound, banners: !!prefs.banners })); } catch { /* ignore */ }
  }

  const [notifSettingsModal, setNotifSettingsModal] = useState({ open: false, scope: "", id: "", sound: true, banners: true, title: "" });
  function openNotifSettingsForServer(serverId, serverName) {
    const id = String(serverId || "");
    const prefs = readNotifPrefs(`${NOTIF_SERVER_KEY_PREFIX}${id}`);
    setNotifSettingsModal({ open: true, scope: "server", id, sound: !!prefs.sound, banners: !!prefs.banners, title: String(serverName || "Сервер") });
  }
  function openNotifSettingsForDm(channelId, dmName) {
    const id = String(channelId || "");
    const prefs = readNotifPrefs(`${NOTIF_DM_KEY_PREFIX}${id}`);
    setNotifSettingsModal({ open: true, scope: "dm", id, sound: !!prefs.sound, banners: !!prefs.banners, title: String(dmName || "ЛС") });
  }
  function saveNotifSettingsModal(next) {
    const scope = String(next?.scope || notifSettingsModal.scope || "");
    const id = String(next?.id || notifSettingsModal.id || "");
    if (!scope || !id) return;
    const key = scope === "server" ? `${NOTIF_SERVER_KEY_PREFIX}${id}` : `${NOTIF_DM_KEY_PREFIX}${id}`;
    writeNotifPrefs(key, { sound: !!next.sound, banners: !!next.banners });
    setNotifSettingsModal((p) => ({ ...(p || {}), sound: !!next.sound, banners: !!next.banners }));
  }

  function unlockNotificationSound() {
    if (notifSoundUnlockedRef.current) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = notifAudioCtxRef.current || new Ctx();
      notifAudioCtxRef.current = ctx;
      ctx.resume?.().catch(() => {});
      notifSoundUnlockedRef.current = true;
    } catch {
      // ignore
    }
  }

  function playVoiceSfx(kind) {
    try {
      // Reuse the same AudioContext unlocked by user gesture.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = notifAudioCtxRef.current || new Ctx();
      notifAudioCtxRef.current = ctx;
      if (ctx.state === "suspended") {
        ctx.resume?.().catch(() => {});
      }

      const nowMs = Date.now();
      if (nowMs - (lastVoiceSfxAtRef.current || 0) < 350) return; // anti-spam
      lastVoiceSfxAtRef.current = nowMs;

      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(ctx.destination);

      const t0 = ctx.currentTime;
      // ~+15% louder than the previous 0.06 peak (join), keep leave slightly gentler.
      // Screen-share on/off uses the same peak family so it matches Discord-like loudness.
      const peak = (kind === "leave" || kind === "screen_off") ? 0.055 : 0.069;
      const seq =
        kind === "screen_on"
          ? [
              { f: 660, dt: 0.00, dur: 0.07 },
              { f: 880, dt: 0.09, dur: 0.09 }
            ]
          : kind === "screen_off"
            ? [
                { f: 880, dt: 0.00, dur: 0.07 },
                { f: 660, dt: 0.09, dur: 0.09 }
              ]
            : kind === "moved"
              ? [
                  { f: 392, dt: 0.00, dur: 0.06 },
                  { f: 523, dt: 0.07, dur: 0.08 },
                  { f: 659, dt: 0.14, dur: 0.11 }
                ]
              : kind === "leave"
              ? [
                  { f: 520, dt: 0.00, dur: 0.07 },
                  { f: 420, dt: 0.09, dur: 0.08 }
                ]
              : [
                  { f: 440, dt: 0.00, dur: 0.07 },
                  { f: 560, dt: 0.09, dur: 0.08 }
                ];

      for (const s of seq) {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = s.f;
        o.connect(g);
        const t = t0 + s.dt;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
        o.start(t);
        o.stop(t + s.dur + 0.01);
      }
    } catch {
      // ignore
    }
  }

  function startDmRingtone(kind) {
    // kind: "incoming" | "outgoing"
    try {
      unlockNotificationSound();
    } catch { /* ignore */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return () => {};
      const ctx = notifAudioCtxRef.current || new Ctx();
      notifAudioCtxRef.current = ctx;
      if (ctx.state === "suspended") ctx.resume?.().catch(() => {});

      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(ctx.destination);

      let t = null;
      let stopped = false;
      const peak = 0.069; // match join loudness family

      const ping = () => {
        if (stopped) return;
        const t0 = ctx.currentTime;
        const seq = kind === "incoming"
          ? [
              { f: 660, dt: 0.00, dur: 0.10 },
              { f: 880, dt: 0.14, dur: 0.12 }
            ]
          : [
              { f: 440, dt: 0.00, dur: 0.08 },
              { f: 560, dt: 0.12, dur: 0.09 }
            ];
        for (const s of seq) {
          const o = ctx.createOscillator();
          o.type = "triangle";
          o.frequency.value = s.f;
          o.connect(g);
          const tt = t0 + s.dt;
          g.gain.setValueAtTime(0.0001, tt);
          g.gain.linearRampToValueAtTime(peak, tt + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, tt + s.dur);
          o.start(tt);
          o.stop(tt + s.dur + 0.02);
        }
      };

      ping();
      t = setInterval(ping, kind === "incoming" ? 1700 : 1400);
      return () => {
        stopped = true;
        try { if (t) clearInterval(t); } catch { /* ignore */ }
        try { g.disconnect(); } catch { /* ignore */ }
      };
    } catch {
      return () => {};
    }
  }

  function playNotificationSound() {
    try {
      const now = Date.now();
      if (now - (lastNotifBeepAtRef.current || 0) < 1200) return; // anti-spam
      lastNotifBeepAtRef.current = now;

      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = notifAudioCtxRef.current || new Ctx();
      notifAudioCtxRef.current = ctx;
      if (ctx.state === "suspended") {
        // Will work only after a user gesture; that's expected on mobile.
        ctx.resume?.().catch(() => {});
      }

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = 740;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);

      const t0 = ctx.currentTime;
      // Slightly louder than voice connect SFX (join peak ~0.069).
      // Use a short two-tone "message tick" similar to Discord.
      const peak = 0.088;
      const seq = [
        { f: 740, dt: 0.00, dur: 0.06 },
        { f: 980, dt: 0.08, dur: 0.07 }
      ];
      for (const s of seq) {
        const osc = ctx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = s.f;
        osc.connect(g);
        const t = t0 + s.dt;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + s.dur);
        osc.start(t);
        osc.stop(t + s.dur + 0.01);
      }
    } catch {
      // ignore
    }
  }

  function tryVibrate(pattern = [30, 60, 30]) {
    try {
      if (!navigator?.vibrate) return;
      navigator.vibrate(pattern);
    } catch {
      // ignore
    }
  }

  async function uploadLargeFileSequential(file, tokenValue, onProgress) {
    const headers0 = { "Content-Type": "application/json" };
    if (tokenValue) headers0.Authorization = `Bearer ${tokenValue}`;

    const init = await fetch(`${getApiBase()}/uploads/init`, {
      method: "POST",
      headers: headers0,
      body: JSON.stringify({
        fileName: file.name || "file.bin",
        totalBytes: file.size || 0,
        contentType: file.type || "application/octet-stream"
      })
    });
    const initText = await init.text().catch(() => "");
    const initJson = (() => { try { return initText ? JSON.parse(initText) : {}; } catch { return {}; } })();
    if (!init.ok) throw new Error(initJson?.error || initJson?.title || (initText || `Ошибка init ${init.status}`));
    const uploadId = String(initJson?.uploadId || "");
    const chunkSize = Math.max(1024 * 1024, Number(initJson?.chunkSize) || (8 * 1024 * 1024));
    if (!uploadId) throw new Error("uploadId пуст");

    let offset = 0;
    const total = Number(file.size) || 0;
    while (offset < total) {
      const next = Math.min(total, offset + chunkSize);
      const slice = file.slice(offset, next);
      const headers = {};
      if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`;
      headers["Content-Range"] = `bytes ${offset}-${next - 1}/${total}`;
      const r = await fetch(`${getApiBase()}/uploads/${uploadId}/chunk`, {
        method: "PUT",
        headers,
        body: slice
      });
      const t = await r.text().catch(() => "");
      const j = (() => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } })();
      if (!r.ok) throw new Error(j?.error || j?.title || (t || `Ошибка chunk ${r.status}`));
      offset = next;
      try { onProgress?.(total ? (offset / total) : 1); } catch { /* ignore */ }
    }

    const complete = await fetch(`${getApiBase()}/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: headers0
    });
    const completeText = await complete.text().catch(() => "");
    const completeJson = (() => { try { return completeText ? JSON.parse(completeText) : {}; } catch { return {}; } })();
    if (!complete.ok) throw new Error(completeJson?.error || completeJson?.title || (completeText || `Ошибка complete ${complete.status}`));
    const fileId = String(completeJson?.fileId || "");
    if (!fileId) throw new Error("fileId пуст");
    try { onProgress?.(1); } catch { /* ignore */ }
    return fileId;
  }

  function notificationContextForChannelId(chId) {
    const id = String(chId || "");
    if (!id) return { kind: "unknown" };
    const dm = (dmChannelsRef.current || []).find((c) => String(c.id) === id);
    if (dm) {
      return { kind: "dm", dmName: dm.name || "", channelId: id };
    }
    for (const srv of (serversRef.current || [])) {
      for (const c of (srv.channels || [])) {
        if (String(c.id) === id) {
          return {
            kind: "channel",
            serverName: srv.name || "",
            channelName: c.name || "",
            serverId: srv.id || "",
            channelId: id
          };
        }
      }
    }
    return { kind: "unknown", channelId: id };
  }

  function memberIsOnline(m) {
    const id = String(m?.id || "");
    const p = userPresenceByUserId[id] || {};
    if (p.online != null) return !!p.online;
    if (m?.online != null) return !!m.online;
    return false;
  }

  const groupedMembers = useMemo(() => {
    const list = Array.isArray(members) ? members.slice() : [];
    const online = [];
    const offline = [];
    for (const m of list) {
      (memberIsOnline(m) ? online : offline).push(m);
    }
    const byNick = (a, b) => String(a?.nickname || "").localeCompare(String(b?.nickname || ""), "ru");
    online.sort(byNick);
    offline.sort(byNick);
    return { online, offline };
  }, [members, userPresenceByUserId]);

  async function enablePushNotifications() {
    try {
      const hasNotification = typeof window !== "undefined" && ("Notification" in window);
      const hasServiceWorker = typeof navigator !== "undefined" && ("serviceWorker" in navigator);
      const hasPush = typeof window !== "undefined" && ("PushManager" in window);
      if (!hasNotification) {
        throw new Error("Уведомления не поддерживаются этим браузером (нет Notification API).");
      }

      if (!window.isSecureContext) {
        throw new Error("Уведомления требуют HTTPS (кроме localhost).");
      }

      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        throw new Error("Разрешение на уведомления не выдано.");
      }

      // If Push API is unavailable, we can still show notifications while the tab is open
      // (SignalR already triggers showLocalNotification when document.hidden).
      if (!hasServiceWorker || !hasPush) {
        throw new Error(
          `Разрешение выдано, но Web Push недоступен в этом браузере (serviceWorker=${hasServiceWorker ? "yes" : "no"}, PushManager=${hasPush ? "yes" : "no"}). ` +
          "Уведомления будут работать только пока вкладка открыта."
        );
      }

      // Ensure the SW is registered and updated so changes reach users reliably.
      const reg0 = await navigator.serviceWorker.register("/push-sw.js");
      try { await reg0.update?.(); } catch { /* ignore */ }

      const { publicKey } = await api("/push/vapid-public-key", { method: "GET" });
      if (!publicKey) {
        setError("Сервер не отдал VAPID public key");
        throw new Error("Сервер не отдал VAPID public key");
      }

      const reg = await navigator.serviceWorker.ready;
      try { await reg.update?.(); } catch { /* ignore */ }
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      const json = sub.toJSON();
      await api("/push/subscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: json.endpoint,
          p256dh: json.keys?.p256dh,
          auth: json.keys?.auth
        })
      });
      setStatus("Уведомления включены");
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function loadInitial() {
    if (!token) return;
    try {
      // Best-effort: keep service worker fresh; stale SW is a common reason push "works intermittently".
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          await reg?.update?.();
        }
      } catch { /* ignore */ }

      const me = await api("/profile", { method: "GET" });
      setProfile(me);
      setEditForm({ nickname: me.nickname || "", bio: me.bio || "" });

      let list = (await api("/servers", { method: "GET" })) || [];

      const dms = await api("/dm/channels", { method: "GET" });
      setDmChannels(sortDmChannels(dms || []));

      const params = new URLSearchParams(window.location.search);
      const inviteCode =
        parseInviteCodeFromUrl(window.location.href)
        || String(params.get("invite") || "").trim()
        || takePendingInviteCode();
      if (inviteCode) {
        try {
          const joinRes = await api("/servers/join", {
            method: "POST",
            body: JSON.stringify({ inviteCode })
          });
          clearInviteFromBrowserUrl();
          const joinedId = String(joinRes?.serverId || "").trim();
          list = (await api("/servers", { method: "GET" })) || [];
          if (joinedId) {
            const srv = list.find((s) => String(s?.id) === joinedId);
            if (srv) {
              setUiMode("server");
              setSelectedServerId(String(srv.id));
              try { localStorage.setItem("sloncord_last_server_id", String(srv.id)); } catch { /* ignore */ }
              const firstText = (srv.channels || []).find((c) => c.kind === "public" || c.kind === "text");
              if (firstText?.id) {
                setSelectedChannelId(String(firstText.id));
                try { localStorage.setItem("sloncord_last_channel_id", String(firstText.id)); } catch { /* ignore */ }
              }
              if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
            }
          }
          setStatus("Вы присоединились к серверу");
        } catch (err) {
          setError(err.message || String(err));
        }
      }

      setServers(list);

      // Open channel from push notification click: /?open=dm:<channelId> or /?open=channel:<channelId>
      try {
        const params2 = new URLSearchParams(window.location.search);
        const open = String(params2.get("open") || "");
        const callAction = String(params2.get("call") || "");
        const callId = String(params2.get("callId") || "");
        const fromUserId = String(params2.get("fromUserId") || "");
        const fromNickname = String(params2.get("fromNickname") || "");
        if (open && open.includes(":")) {
          const [kind, id] = open.split(":");
          if (kind === "dm") {
            setUiMode("dm");
            if (id) selectTextChannel(id);
            if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
            // If opened from call push, show incoming UI immediately (caller info may be best-effort).
            if (callAction === "incoming" && callId && id && fromUserId) {
              setDmCall((p) => ({ ...(p || {}), incoming: { callId, channelId: String(id), fromUserId, fromNickname: fromNickname || "Пользователь" } }));
            }
            if ((callAction === "accept" || callAction === "decline") && callId && id && fromUserId) {
              // Respond immediately; accept also joins the voice channel.
              api(`/dm/${String(id)}/call/respond`, { method: "POST", body: JSON.stringify({ callId, action: callAction, toUserId: fromUserId }) }).catch(() => {});
              if (callAction === "accept") {
                setTimeout(() => connectVoiceToChannel(String(id)).catch(() => {}), 0);
              }
            }
          } else if (kind === "channel") {
            const chId = String(id || "");
            if (chId) {
              const srv = (list || []).find((s) => (s.channels || []).some((c) => String(c.id) === chId));
              if (srv) {
                setUiMode("server");
                setSelectedServerId(srv.id);
                selectTextChannel(chId);
                if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
              }
            }
          }
          params2.delete("open");
          const url = `${window.location.pathname}${params2.toString() ? `?${params2}` : ""}`;
          window.history.replaceState({}, "", url);
        }
      } catch {
        // ignore
      }

      let lastServerId = "";
      let lastChannelId = "";
      let lastDmId = "";
      let lastUiMode = "";
      try {
        lastServerId = localStorage.getItem("sloncord_last_server_id") || "";
        lastChannelId = localStorage.getItem("sloncord_last_channel_id") || "";
        lastDmId = localStorage.getItem("sloncord_last_dm_id") || "";
        lastUiMode = localStorage.getItem("sloncord_last_ui_mode") || "";
      } catch {
        // ignore
      }

      const nextMode = (lastUiMode === "dm" || lastUiMode === "server") ? lastUiMode : uiMode;
      if (nextMode === "dm" && dms?.length) {
        setUiMode("dm");
        const pick = dms.find((c) => String(c.id) === String(lastDmId)) || dms[0];
        if (pick?.id) {
          setSelectedChannelId(pick.id);
          try { localStorage.setItem("sloncord_last_dm_id", String(pick.id)); } catch { /* ignore */ }
        }
      } else if (list.length) {
        setUiMode("server");
        const srv = list.find((s) => String(s.id) === String(lastServerId)) || list[0];
        setSelectedServerId(srv.id);
        try { localStorage.setItem("sloncord_last_server_id", String(srv.id)); } catch { /* ignore */ }

        const preferred = (srv.channels || []).find((c) => String(c.id) === String(lastChannelId));
        const firstText = (srv.channels || []).find((c) => c.kind === "public" || c.kind === "text");
        const pick = preferred || firstText;
        if (pick?.id) {
          setSelectedChannelId(pick.id);
          try { localStorage.setItem("sloncord_last_channel_id", String(pick.id)); } catch { /* ignore */ }
        }
      }
      didInitialLoadRef.current = true;
    } catch (e) {
      setError(e.message);
      logout();
    }
  }

  useEffect(() => {
    captureInviteFromCurrentUrl();
  }, []);

  useEffect(() => {
    loadInitial();
  }, [token]);

  useEffect(() => {
    // Persist last UI mode so reload in DMs doesn't jump back to a server channel.
    if (!didInitialLoadRef.current) return;
    try { localStorage.setItem("sloncord_last_ui_mode", String(uiMode || "server")); } catch { /* ignore */ }
  }, [uiMode]);

  useEffect(() => {
    if (!token) return;
    if (!profile?.id) return;
    // preload my own avatar after reload
    (async () => {
      const fid = String(profile?.avatarFileId || "");
      if (!fid) return;
      const url = await ensureAvatarUrl(fid);
      if (url) setUserAvatarUrlByUserId((prev) => ({ ...prev, [String(profile.id)]: url }));
    })();
  }, [token, profile?.id, profile?.avatarFileId]);

  useEffect(() => {
    // when opening a channel, jump to bottom after messages load
    shouldAutoScrollRef.current = true;
  }, [selectedChannelId]);

  useEffect(() => {
    if (!messagesBoxRef.current) return;
    if (!shouldAutoScrollRef.current) return;
    // Scroll to bottom (without stealing scroll if user is reading history).
    // Do it on 2 animation frames to account for async layout (images, fonts).
    const stick = () => {
      const el = messagesBoxRef.current;
      if (!el) return;
      try {
        el.scrollTop = el.scrollHeight;
      } catch {
        // ignore
      }
    };
    try {
      cancelAnimationFrame(scrollStickRef.current.raf);
    } catch { /* ignore */ }
    scrollStickRef.current.raf = requestAnimationFrame(() => {
      stick();
      scrollStickRef.current.raf = requestAnimationFrame(stick);
    });
  }, [messages.length, selectedChannelId]);

  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!shouldAutoScrollRef.current) return;
      try {
        el.scrollTop = el.scrollHeight;
      } catch {
        // ignore
      }
    });
    try { ro.observe(el); } catch { /* ignore */ }
    return () => {
      try { ro.disconnect(); } catch { /* ignore */ }
    };
  }, [selectedChannelId]);

  const pushInitTried = useRef(false);
  useEffect(() => {
    if (!token) return;
    if (pushInitTried.current) return;
    pushInitTried.current = true;

    // IMPORTANT (iOS Safari): do NOT auto-request notification permission on page load.
    // Push is optional; users can opt-in via an explicit action later.
    // Also, some mobile browsers partially implement these APIs; avoid showing blocking errors.
    if (!("serviceWorker" in navigator) || !("PushManager" in navigator)) return;
    if (!window.isSecureContext) return;
    // intentionally not calling enablePushNotifications() here
  }, [token]);

  // Unlock notification sound on first user gesture (required by mobile browsers).
  useEffect(() => {
    const onGesture = () => {
      unlockNotificationSound();
      try { voiceRef.current?.ensurePlayback?.(); } catch { /* ignore */ }
    };
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  const prevVoiceConnectedRef = useRef(false);
  useEffect(() => {
    const was = prevVoiceConnectedRef.current;
    const now = !!voiceState.connected && !voiceState.joining;
    prevVoiceConnectedRef.current = now;
    if (now && !was) {
      lastSelfVoiceConnectAtRef.current = Date.now();
      if (suppressNextVoiceJoinSfxRef.current) {
        suppressNextVoiceJoinSfxRef.current = false;
        return;
      }
      playVoiceSfx("join");
    }
  }, [voiceState.connected, voiceState.joining, voiceState.room]);

  // Voice join/leave sound (Discord-like). Compare roster diffs.
  const lastVoiceRosterRef = useRef({ room: "", initDone: false, ids: new Set() });
  useEffect(() => {
    const room = String(voiceState.room || "");
    const ids = (voiceState.rosterUserIds || []).map((x) => String(x)).filter(Boolean);
    const meId = String(profile?.id || "");
    const cur = new Set(ids.filter((x) => x && x !== meId));

    // Reset tracking when room changes or disconnected.
    if (!voiceState.connected || !room) {
      lastVoiceRosterRef.current = { room: "", initDone: false, ids: new Set() };
      return;
    }
    if (lastVoiceRosterRef.current.room !== room) {
      lastVoiceRosterRef.current = { room, initDone: false, ids: cur };
      // Don't play sounds for the initial roster snapshot.
      setTimeout(() => {
        if (lastVoiceRosterRef.current.room === room) lastVoiceRosterRef.current.initDone = true;
      }, 1200);
      return;
    }
    if (!lastVoiceRosterRef.current.initDone) {
      lastVoiceRosterRef.current.ids = cur;
      return;
    }

    const prev = lastVoiceRosterRef.current.ids;
    let joined = 0;
    let left = 0;
    cur.forEach((id) => { if (!prev.has(id)) joined += 1; });
    prev.forEach((id) => { if (!cur.has(id)) left += 1; });
    lastVoiceRosterRef.current.ids = cur;

    // Play once per change batch.
    if (joined > 0) {
      const dt = Date.now() - (lastSelfVoiceConnectAtRef.current || 0);
      if (dt < 900) {
        // We already played a join when the local client finished connecting; skip the "snapshot" join burst.
        return;
      }
      playVoiceSfx("join");
    } else if (left > 0) {
      playVoiceSfx("leave");
    }
  }, [voiceState.connected, voiceState.room, (voiceState.rosterUserIds || []).join(","), profile?.id]);

  // Screen-share on/off sound (Discord-like). Everyone in the call hears it, including the sharer.
  const lastScreenShareRef = useRef({ room: "", initDone: false, ids: new Set() });
  useEffect(() => {
    const room = String(voiceState.room || "");
    const ids = (voiceState.screenShareUserIds || []).map((x) => String(x)).filter(Boolean);
    const cur = new Set(ids);

    if (!voiceState.connected || !room) {
      lastScreenShareRef.current = { room: "", initDone: false, ids: new Set() };
      return;
    }
    if (lastScreenShareRef.current.room !== room) {
      lastScreenShareRef.current = { room, initDone: false, ids: cur };
      setTimeout(() => {
        if (lastScreenShareRef.current.room === room) lastScreenShareRef.current.initDone = true;
      }, 1200);
      return;
    }
    if (!lastScreenShareRef.current.initDone) {
      lastScreenShareRef.current.ids = cur;
      return;
    }

    const prev = lastScreenShareRef.current.ids;
    let turnedOn = 0;
    let turnedOff = 0;
    cur.forEach((id) => { if (!prev.has(id)) turnedOn += 1; });
    prev.forEach((id) => { if (!cur.has(id)) turnedOff += 1; });
    lastScreenShareRef.current.ids = cur;

    if (turnedOn > 0) playVoiceSfx("screen_on");
    else if (turnedOff > 0) playVoiceSfx("screen_off");
  }, [voiceState.connected, voiceState.room, (voiceState.screenShareUserIds || []).join(",")]);

  // Автовход в голос после перезапуска отключён: давал лишние join/replaced и «призрак» в канале.

  useEffect(() => {
    if (!token) return undefined;

    const url = `${getApiBase()}/ws/realtime?access_token=${encodeURIComponent(token)}`;
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(url, { withCredentials: false })
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    hubRef.current = connection;

    connection.on(RT.MessageCreated, (payload) => {
      const chId = payload?.channelId;
      const msg = payload?.message;
      if (!chId || !msg) return;
      const me = profileRef.current;
      const isFromOther = String(msg.senderUserId) !== String(me?.id);
      const isSystemMsg =
        String(msg?.senderUserId || "") === SYSTEM_USER_ID
        || String(msg?.senderNickname || "").trim().toLowerCase() === "sloncord";
      const ctx0 = notificationContextForChannelId(chId);
      const serverPrefs = (ctx0?.kind === "channel" && ctx0?.serverId)
        ? readNotifPrefs(`${NOTIF_SERVER_KEY_PREFIX}${String(ctx0.serverId)}`)
        : { sound: true, banners: true };
      const dmPrefs = (ctx0?.kind === "dm")
        ? readNotifPrefs(`${NOTIF_DM_KEY_PREFIX}${String(ctx0.channelId || chId)}`)
        : { sound: true, banners: true };
      const prefs = ctx0?.kind === "dm" ? dmPrefs : serverPrefs;
      // Always play sound for incoming messages (Discord-like), unless user disabled sound.
      if (isFromOther && !isSystemMsg && prefs.sound) {
        try { unlockNotificationSound(); } catch { /* ignore */ }
        playNotificationSound();
      }
      try {
        if (ctx0?.kind === "dm") bumpDmChannelToTop(String(chId), String(msg?.createdAtUtc || new Date().toISOString()));
      } catch { /* ignore */ }
      if (String(chId) === String(selectedChannelIdRef.current)) {
        setMessages((prev) => {
          try {
            return capMessagesList(reconcileOptimisticMessage(prev, msg));
          } catch {
            if (prev.some((m) => String(m.id) === String(msg.id))) return prev;
            return capMessagesList([...prev, msg]);
          }
        });
        setTimeout(() => scrollToBottomIfPinned(), 0);
        // If we're currently viewing this chat and a message from someone else arrives,
        // immediately mark as read (prevents unread badges from getting stuck).
        try {
          const canAutoRead =
            isFromOther
            && !document.hidden
            && (!window.sloncord || document.hasFocus())
            && !!shouldAutoScrollRef.current;
          if (canAutoRead) {
            const cid = String(chId);
            const mode = uiModeRef.current;
            (mode === "server"
              ? api(`/channels/${cid}/read`, { method: "POST" })
              : api(`/dm/${cid}/read`, { method: "POST" })
            ).catch(() => {});
            patchUnreadState(cid, 0);
          }
        } catch {
          // ignore
        }
        void (async () => {
          let showBanner = false;
          try {
            if (typeof window !== "undefined" && typeof window.sloncord?.isMainWindowFocused === "function") {
              showBanner = !(await window.sloncord.isMainWindowFocused());
            } else {
              showBanner = document.hidden;
            }
          } catch {
            showBanner = document.hidden;
          }
          if (isFromOther && prefs.banners && showBanner) {
            const ctx = ctx0;
            const preview = msg.text || "[файл]";
            const title = ctx.kind === "dm"
              ? `От ${msg.senderNickname}`
              : (ctx.kind === "channel" ? `${ctx.serverName || "Sloncord"} • #${ctx.channelName || "канал"}` : "Sloncord");
            const body = ctx.kind === "dm" ? `ЛС: ${preview}` : `${msg.senderNickname}: ${preview}`;
            showLocalNotification(title, body);
            tryVibrate();
          }
        })();
      } else {
        void (async () => {
          let showBanner = false;
          try {
            if (typeof window !== "undefined" && typeof window.sloncord?.isMainWindowFocused === "function") {
              showBanner = !(await window.sloncord.isMainWindowFocused());
            } else {
              showBanner = document.hidden;
            }
          } catch {
            showBanner = document.hidden;
          }
          if (isFromOther && prefs.banners && showBanner) {
            const ctx = ctx0;
            const preview = msg.text || "[файл]";
            const title = ctx.kind === "dm"
              ? `От ${msg.senderNickname}`
              : (ctx.kind === "channel" ? `${ctx.serverName || "Sloncord"} • #${ctx.channelName || "канал"}` : "Sloncord");
            const body = ctx.kind === "dm" ? `ЛС: ${preview}` : `${msg.senderNickname}: ${preview}`;
            showLocalNotification(title, body);
            tryVibrate();
          }
        })();
      }
    });

    connection.on(RT.MessageUpdated, (payload) => {
      const chId = payload?.channelId;
      const msg = payload?.message;
      if (!chId || !msg) return;
      if (String(chId) !== String(selectedChannelIdRef.current)) return;
      setMessages((prev) => prev.map((m) => (String(m.id) === String(msg.id) ? msg : m)));
    });

    connection.on(RT.MessageDeleted, (payload) => {
      const chId = payload?.channelId;
      const messageId = payload?.messageId;
      if (!chId || !messageId) return;
      if (String(chId) !== String(selectedChannelIdRef.current)) return;
      setMessages((prev) => prev.filter((m) => String(m.id) !== String(messageId)));
    });

    connection.on(RT.UnreadChanged, (payload) => {
      const chId = payload?.channelId;
      if (chId == null) return;
      patchUnreadState(chId, payload.unread);
    });

    connection.on(RT.DmCallIncoming, (payload) => {
      const channelId = String(payload?.channelId || "");
      const callId = String(payload?.callId || "");
      const fromUserId = String(payload?.fromUserId || "");
      const fromNickname = String(payload?.fromNickname || "Пользователь");
      if (!channelId || !callId || !fromUserId) return;
      // If already in this call (or already showing), ignore.
      setDmCall((prev) => {
        if (prev?.incoming && String(prev.incoming.callId) === callId) return prev;
        if (prev?.outgoing && String(prev.outgoing.callId) === callId) return prev;
        return { ...(prev || {}), incoming: { callId, channelId, fromUserId, fromNickname } };
      });
      try {
        // stop any outgoing ringback and start incoming ringtone
        dmRingtoneRef.current?.stopOutgoing?.();
      } catch { /* ignore */ }
      try {
        dmRingtoneRef.current.stopIncoming?.();
      } catch { /* ignore */ }
      dmRingtoneRef.current.stopIncoming = startDmRingtone("incoming");
      void (async () => {
        try {
          if (window.sloncord?.showNativeIncomingCall) {
            await window.sloncord.showNativeIncomingCall({
              callId,
              channelId,
              fromUserId,
              fromNickname
            });
          }
        } catch { /* ignore */ }
      })();
    });

    connection.on(RT.DmCallCancelled, (payload) => {
      const callId = String(payload?.callId || "");
      if (!callId) return;
      const channelId = String(payload?.channelId || "");
      setDmCall((prev) => {
        if (prev?.incoming && String(prev.incoming.callId) === callId) {
          try { dmRingtoneRef.current.stopIncoming?.(); } catch { /* ignore */ }
          dmRingtoneRef.current.stopIncoming = null;
          return { ...(prev || {}), incoming: null };
        }
        if (prev?.outgoing && String(prev.outgoing.callId) === callId) {
          try { dmRingtoneRef.current.stopOutgoing?.(); } catch { /* ignore */ }
          dmRingtoneRef.current.stopOutgoing = null;
          try {
            if (String(activeVoiceChannelId || "") === String(prev.outgoing.channelId || "")) {
              leaveVoice();
            }
          } catch { /* ignore */ }
          return { ...(prev || {}), outgoing: null };
        }
        return prev;
      });
      // If this call ended/timeouted/cancelled, ensure we leave the DM voice channel too (both sides).
      try {
        if (channelId && String(activeVoiceChannelIdRef.current || "") === channelId) {
          leaveVoice();
        }
      } catch { /* ignore */ }
      try {
        if (String(dmActiveCallSessionRef.current?.callId || "") === callId) {
          dmActiveCallSessionRef.current = { callId: "", channelId: "", state: "" };
        }
      } catch { /* ignore */ }
    });

    connection.on(RT.DmCallResponse, (payload) => {
      const callId = String(payload?.callId || "");
      const action = String(payload?.action || "");
      if (!callId || !action) return;
      if (action === "accept") {
        // Call was accepted by the callee; mark as active so we can emit /call/end on hangup.
        const channelId = String(payload?.channelId || "");
        dmActiveCallSessionRef.current = { callId, channelId, state: "active" };
      }
      setDmCall((prev) => {
        if (prev?.outgoing && String(prev.outgoing.callId) === callId) {
          try { dmRingtoneRef.current.stopOutgoing?.(); } catch { /* ignore */ }
          dmRingtoneRef.current.stopOutgoing = null;
          const next = { ...(prev || {}), outgoing: null };
          // If declined, hang up caller side (Discord-like).
              if (action === "decline") {
                try {
                  if (String(activeVoiceChannelId || "") === String(prev.outgoing.channelId || "")) {
                    leaveVoice();
                  }
                } catch { /* ignore */ }
              }
          return next;
        }
        return prev;
      });
    });

    connection.on(RT.ChannelListUpdated, (payload) => {
      const kind = payload?.kind;
      const list = payload?.channels;
      if (!kind || !Array.isArray(list)) return;
      if (kind === "dm") setDmChannels(sortDmChannels(list));
      (async () => {
        try {
          if (connection.state === signalR.HubConnectionState.Connected) {
            await connection.invoke("ResyncGroups");
          }
        } catch {
          // ignore
        }
      })();
    });

    connection.on(RT.ServerListUpdated, (payload) => {
      const list = payload?.servers;
      if (!Array.isArray(list)) return;
      setServers(list);
      // Membership changes (join/leave/kick) are delivered via updated server list.
      // Refresh the current members list so "Участники" stays live without a page reload.
      try {
        const mode = uiModeRef.current;
        const chId = String(selectedChannelIdRef.current || "");
        if (mode === "server" && chId) {
          setTimeout(() => {
            refreshConversationData(chId, "server").catch(() => {});
          }, 0);
        }
      } catch {
        // ignore
      }
      (async () => {
        try {
          if (connection.state === signalR.HubConnectionState.Connected) {
            await connection.invoke("ResyncGroups");
          }
        } catch {
          // ignore
        }
      })();
    });

    connection.on(RT.VoiceMoved, (payload) => {
      const chId = String(payload?.channelId || "");
      if (!chId) return;
      try {
        playVoiceSfx("moved");
        void connectVoiceToChannelRef.current(chId, { suppressJoinSfx: true });
      } catch {
        /* ignore */
      }
    });

    connection.on(RT.VoicePresenceUpdated, (payload) => {
      const chId = payload?.channelId;
      if (!chId) return;
      let userIds = (payload.userIds || []).map((x) => String(x)).filter(Boolean);
      const meId = String(profileRef.current?.id || "");
      const activeCid = String(activeVoiceChannelIdRef.current || "");
      if (
        meId &&
        String(chId) === activeCid &&
        (voiceStateRef.current?.connected || voiceStateRef.current?.joining)
      ) {
        if (!userIds.includes(meId)) userIds = [...userIds, meId];
      }
      setVoicePresenceByChannelId((prev) => {
        const key = String(chId);
        const prevEntry = prev[key] || {};
        const prevIds = (prevEntry.userIds || []).map((x) => String(x)).filter(Boolean);
        const wasEmpty = prevIds.length === 0;
        const incomingStarted = payload.startedAtUtc ? String(payload.startedAtUtc) : "";
        let startedAtUtc = "";
        if (userIds.length > 0) {
          if (wasEmpty) {
            startedAtUtc = incomingStarted || new Date().toISOString();
          } else {
            const prevStarted = prevEntry.startedAtUtc ? String(prevEntry.startedAtUtc) : "";
            if (prevStarted && incomingStarted) {
              const prevMs = Date.parse(prevStarted);
              const incomingMs = Date.parse(incomingStarted);
              startedAtUtc = (Number.isFinite(prevMs) && Number.isFinite(incomingMs) && prevMs <= incomingMs)
                ? prevStarted
                : (prevStarted || incomingStarted);
            } else {
              startedAtUtc = prevStarted || incomingStarted;
            }
          }
        }
        return {
          ...prev,
          [key]: {
            channelId: key,
            userIds,
            screenShareUserIds: (payload.screenShareUserIds || []).map((x) => String(x)),
            mutedUserIds: (payload.mutedUserIds || []).map((x) => String(x)),
            deafenedUserIds: (payload.deafenedUserIds || []).map((x) => String(x)),
            speakingUserIds: (payload.speakingUserIds || []).map((x) => String(x)),
            startedAtUtc,
          }
        };
      });
    });

    connection.on(RT.UserPresenceUpdated, (payload) => {
      const uid = payload?.userId;
      if (!uid) return;
      const nextPresence = {
        online: !!payload?.online,
        lastSeenAtUtc: payload?.lastSeenAtUtc || ""
      };
      setUserPresenceByUserId((prev) => ({
        ...prev,
        [String(uid)]: nextPresence
      }));
      // Keep any already-rendered member lists in sync (server members panel, DM participants, etc).
      setMembers((prev) => {
        if (!Array.isArray(prev) || prev.length === 0) return prev;
        const id = String(uid);
        let changed = false;
        const next = prev.map((m) => {
          if (String(m?.id) !== id) return m;
          changed = true;
          return { ...m, online: nextPresence.online, lastSeenAtUtc: nextPresence.lastSeenAtUtc };
        });
        return changed ? next : prev;
      });
    });

    connection.on(RT.Typing, (payload) => {
      const chId = String(payload?.channelId || "");
      const uid = String(payload?.userId || "");
      if (!chId || !uid) return;
      const me = profileRef.current;
      if (String(uid) === String(me?.id)) return;
      const now = Date.now();
      setTypingByChannelId((prev) => {
        const next = { ...(prev || {}) };
        const cur = { ...(next[chId] || {}) };
        cur[uid] = now + 3200; // TTL ~3s
        next[chId] = cur;
        return next;
      });
    });

    connection.on(RT.DmCreated, (payload) => {
      const ch = payload?.channel;
      if (!ch) return;
      setDmChannels((prev) => {
        const next = [ch, ...prev.filter((c) => String(c.id) !== String(ch.id))];
        return next;
      });
      setStatus("Новый личный чат");
    });

    connection.on(RT.PlatformBanned, (payload) => {
      const msg = formatPlatformBanMessage({
        platformBanned: true,
        error: "Аккаунт заблокирован модерацией платформы",
        reason: payload?.reason,
        bannedUntilUtc: payload?.bannedUntilUtc,
        permanent: payload?.permanent
      }) || "Аккаунт заблокирован модерацией платформы";
      setError(msg);
      setMode("login");
      logout();
    });

    connection.on(RT.SessionsRevoked, () => {
      setError("Модератор завершил все ваши сессии. Войдите снова.");
      setMode("login");
      logout();
    });

    connection.on(RT.UserTeamChanged, (payload) => {
      const parsed = teamFlagsFromRealtimePayload(payload);
      if (!parsed) return;
      const { userId: uid, flags } = parsed;
      setUserProfiles((prev) => {
        const cur = prev[uid];
        if (!cur) return prev;
        return { ...prev, [uid]: { ...cur, ...flags } };
      });
      setMembers((prev) => {
        if (!Array.isArray(prev) || prev.length === 0) return prev;
        let changed = false;
        const next = prev.map((m) => {
          if (String(m?.id) !== uid) return m;
          changed = true;
          return { ...m, ...flags };
        });
        return changed ? next : prev;
      });
      setProfile((prev) => {
        if (!prev || String(prev.id) !== uid) return prev;
        return { ...prev, ...flags };
      });
      setMessages((prev) => {
        if (!Array.isArray(prev) || prev.length === 0) return prev;
        let changed = false;
        const next = prev.map((m) => {
          if (String(m?.senderUserId || "") !== uid) return m;
          changed = true;
          return {
            ...m,
            senderIsPlatformRoot: flags.isPlatformRoot,
            senderIsPlatformModerator: flags.isPlatformModerator,
          };
        });
        return changed ? next : prev;
      });
    });

    connection.on(RT.ChatMuteChanged, (payload) => {
      const muted = !!payload?.muted;
      setProfile((prev) => {
        if (!prev) return prev;
        if (muted) {
          return {
            ...prev,
            chatMuted: true,
            chatMuteReason: String(payload?.reason || ""),
            chatMutedUntilUtc: payload?.mutedUntilUtc || null
          };
        }
        return {
          ...prev,
          chatMuted: false,
          chatMuteReason: "",
          chatMutedUntilUtc: null
        };
      });
      if (muted) {
        setNewMessage("");
        setReplyDraft(null);
        setPendingAttachmentsForChat([]);
      }
    });

    connection.onreconnecting(() => {
      // Presence service restarts on redeploy; clear cached presence to avoid stale "online".
      setUserPresenceByUserId({});
      setMembers((prev) => (Array.isArray(prev) ? prev.map((m) => ({ ...m, online: false })) : prev));
    });

    connection.onreconnected(async () => {
      try {
        // After reconnect, re-fetch current members so online/offline stabilizes.
        setUserPresenceByUserId({});
        const mode = uiModeRef.current;
        const chId = String(selectedChannelIdRef.current || "");
        if (chId) {
          setTimeout(() => refreshConversationData(chId, mode).catch(() => {}), 0);
        }
        await connection.invoke("ResyncGroups");
        dispatchDesktopReleaseCheckIfDesktop();
      } catch {
        // ignore
      }
    });

    connection.onclose(() => {
      // Treat as offline snapshot until reconnect succeeds.
      setUserPresenceByUserId({});
      setMembers((prev) => (Array.isArray(prev) ? prev.map((m) => ({ ...m, online: false })) : prev));
    });

    (async () => {
      try {
        await connection.start();
        await connection.invoke("ResyncGroups");
        dispatchDesktopReleaseCheckIfDesktop();
      } catch (e) {
        setError(e.message || String(e));
      }
    })();

    return () => {
      (async () => {
        try {
          await connection.stop();
        } catch {
          // ignore
        }
      })();
    };
  }, [token]);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setTypingByChannelId((prev) => {
        const out = {};
        for (const [chId, m] of Object.entries(prev || {})) {
          const cur = {};
          for (const [uid, exp] of Object.entries(m || {})) {
            if ((Number(exp) || 0) > now) cur[uid] = exp;
          }
          if (Object.keys(cur).length) out[chId] = cur;
        }
        return out;
      });
    }, 600);
    return () => clearInterval(t);
  }, []);

  function emitTypingSoon() {
    try {
      const hub = hubRef.current;
      if (!hub) return;
      if (hub.state !== signalR.HubConnectionState.Connected) return;
      const chId = String(selectedChannelIdRef.current || "");
      if (!chId) return;
      const now = Date.now();
      if (now - (typingSendRef.current.lastSentAt || 0) < 900) return;
      typingSendRef.current.lastSentAt = now;
      hub.invoke("Typing", chId).catch(() => {});
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!token) return undefined;
    return () => {
      voiceRef.current?.destroy();
      voiceRef.current = null;
    };
  }, [token]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const onChange = () => {
      setIsNarrow(mq.matches);
      if (!mq.matches) {
        setMobileView("list");
        setMembersSheet(false);
      }
    };
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!membersSheet) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setMembersSheet(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [membersSheet]);

  useEffect(() => {
    if (!selectedChannelId || !token) return undefined;
    if (uiMode === "server") {
      const ch = channelsRef.current.find((c) => String(c.id) === String(selectedChannelId));
      if (ch?.kind === "voice") {
        setMessages([]);
        setMembers([]);
        return undefined;
      }
    }

    const cid = selectedChannelId;
    const mode = uiMode;
    // Не показывать чужую переписку, пока грузится выбранный чат
    setMessages([]);
    setMembers([]);

    (async () => {
      try {
        // «Прочитано» и тело чата — параллельно, без ожидания read перед списком сообщений
        const readP =
          mode === "server"
            ? api(`/channels/${cid}/read`, { method: "POST" }).catch(() => {})
            : api(`/dm/${cid}/read`, { method: "POST" }).catch(() => {});
        const bodyP = refreshConversationData(cid, mode);
        await Promise.all([readP, bodyP]);
      } finally {
        if (isStillOnChannel(cid)) {
          patchUnreadState(cid, 0);
        }
      }
    })();
    return undefined;
  }, [selectedChannelId, token, uiMode]);

  useEffect(() => {
    if (!token) return;
    const raw = (voiceState.rosterUserIds && voiceState.rosterUserIds.length > 0)
      ? voiceState.rosterUserIds
      : voiceState.remotePeerUserIds;
    if (!raw?.length) return;
    (async () => {
      const ids = raw
        .map((x) => String(x))
        .filter((id) => {
          if (!id) return false;
          if (id === String(profileRef.current?.id)) return false;
          if (voiceNamesFetched.current.has(id)) return false;
          if (voiceNamesInFlight.current.has(id)) return false;
          return true;
        });
      if (!ids.length) return;
      ids.forEach((id) => voiceNamesInFlight.current.add(id));
      await Promise.all(ids.map(async (id) => {
        try {
          const up = await ensureUserProfile(id);
          if (up) voiceNamesFetched.current.add(id);
        } catch {
          // ignore (will retry later)
        } finally {
          voiceNamesInFlight.current.delete(id);
        }
      }));
    })();
  }, [token, voiceState.rosterUserIds, voiceState.remotePeerUserIds]);

  useEffect(() => {
    if (!token) return;
    const ids = new Set();
    Object.values(voicePresenceByChannelId || {}).forEach((p) => {
      (p?.userIds || []).forEach((id) => ids.add(String(id)));
      (p?.screenShareUserIds || []).forEach((id) => ids.add(String(id)));
    });
    if (ids.size === 0) return;
    (async () => {
      const list = Array.from(ids)
        .map((x) => String(x))
        .filter((id) => {
          if (!id) return false;
          if (id === String(profileRef.current?.id)) return false;
          if (voiceNamesFetched.current.has(id)) return false;
          if (voiceNamesInFlight.current.has(id)) return false;
          return true;
        });
      if (!list.length) return;
      list.forEach((id) => voiceNamesInFlight.current.add(id));
      await Promise.all(list.map(async (id) => {
        try {
          const up = await ensureUserProfile(id);
          if (up) voiceNamesFetched.current.add(id);
        } catch {
          // ignore (will retry later)
        } finally {
          voiceNamesInFlight.current.delete(id);
        }
      }));
    })();
  }, [token, voicePresenceByChannelId]);

  useEffect(() => {
    voicePresenceFetched.current.clear();
    setVoicePresenceByChannelId({});
  }, [selectedServerId]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      for (const ch of allVoiceChannels) {
        const id = String(ch.id);
        if (!id) continue;
        if (voicePresenceFetched.current.has(id)) continue;
        voicePresenceFetched.current.add(id);
        try {
          const p = await api(`/channels/${id}/voice/presence`, { method: "GET" });
          setVoicePresenceByChannelId((prev) => {
            const prevEntry = prev[id] || {};
            const userIds = Array.isArray(p?.userIds) ? p.userIds : [];
            const prevIds = (prevEntry.userIds || []).map((x) => String(x)).filter(Boolean);
            const wasEmpty = prevIds.length === 0;
            let startedAtUtc = "";
            if (userIds.length > 0) {
              const incomingStarted = p?.startedAtUtc ? String(p.startedAtUtc) : "";
              if (wasEmpty) {
                startedAtUtc = incomingStarted || new Date().toISOString();
              } else {
                const prevStarted = prevEntry.startedAtUtc ? String(prevEntry.startedAtUtc) : "";
                if (prevStarted && incomingStarted) {
                  const prevMs = Date.parse(prevStarted);
                  const incomingMs = Date.parse(incomingStarted);
                  startedAtUtc = (Number.isFinite(prevMs) && Number.isFinite(incomingMs) && prevMs <= incomingMs)
                    ? prevStarted
                    : (prevStarted || incomingStarted);
                } else {
                  startedAtUtc = prevStarted || incomingStarted;
                }
              }
            }
            return {
              ...prev,
              [id]: {
                ...p,
                startedAtUtc,
              },
            };
          });
        } catch {
          // ignore
        }
      }
    })();
  }, [token, allVoiceChannels]);

  useEffect(() => {
    if (!token) return;
    // Preload server avatars (параллельно, без очереди по одному)
    (async () => {
      const jobs = (servers || []).map(async (s) => {
        const sid = String(s.id);
        const fid = String(s.avatarFileId || "");
        if (!sid || !fid) return;
        if (serverAvatarUrlByServerId[sid]) return;
        const url = await ensureAvatarUrl(fid);
        if (url) setServerAvatarUrlByServerId((prev) => ({ ...prev, [sid]: url }));
      });
      await Promise.all(jobs);
    })();
  }, [token, servers]);

  useEffect(() => {
    if (!token) return;
    if (!messages?.length) return;
    (async () => {
      const seenF = new Set();
      const seenU = new Set();
      const fids = [];
      const uids = [];
      for (const msg of messages || []) {
        const f = String(msg?.senderAvatarFileId || "");
        if (f && !seenF.has(f)) {
          seenF.add(f);
          fids.push(f);
        }
        const u = String(msg?.senderUserId || "");
        if (u && !seenU.has(u)) {
          seenU.add(u);
          uids.push(u);
        }
      }
      const fidsToLoad = fids.filter((fid) => {
        if (getCachedAvatarUrl(fid) || avatarUrlByFileId[fid]) return false;
        if (avatarPrefetchedRef.current.has(fid)) return false;
        avatarPrefetchedRef.current.add(fid);
        return true;
      });
      const uidsToLoad = uids.filter((id) => {
        if (userProfiles[id]) return false;
        if (profilePrefetchedRef.current.has(id)) return false;
        profilePrefetchedRef.current.add(id);
        return true;
      });
      await Promise.all([
        ...fidsToLoad.map((fid) => ensureAvatarUrl(fid)),
        ...uidsToLoad.map((id) => ensureUserProfile(id))
      ]);
    })();
  }, [token, messages]);

  useEffect(() => {
    if (!token) return;
    if (!members?.length) return;
    (async () => {
      await Promise.all(
        (members || []).map((m) => {
          const id = String(m?.id || "");
          if (!id) return Promise.resolve();
          return ensureUserProfile(id);
        })
      );
    })();
  }, [token, members]);

  // Note: showComposerAddMenu is no longer used (the "+" button opens the file picker directly).

  useEffect(() => {
    if (!serverMenuOpen) return undefined;
    function onKey(e) {
      if (e.key === "Escape") setServerMenuOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [serverMenuOpen]);

  async function refreshConversationData(channelId, mode) {
    try {
      if (mode === "server") {
        const mch = channelsRef.current.find((c) => String(c.id) === String(channelId));
        if (mch?.kind === "voice") {
          if (!isStillOnChannel(channelId)) return;
          setMessages([]);
          setMembers([]);
          return;
        }
        const unreadCount =
          (channelsRef.current || []).find((c) => String(c.id) === String(channelId))?.unreadCount || 0;
        const initialLimit = Math.min(150, Math.max(MESSAGES_PAGE_SIZE, Number(unreadCount) || 0));
        const msgPath = `/channels/${channelId}/messages?limit=${encodeURIComponent(String(initialLimit))}`;
        const [msgs, users] = await Promise.all([
          api(msgPath, { method: "GET" }),
          api(`/channels/${channelId}/members`, { method: "GET" })
        ]);
        if (!isStillOnChannel(channelId)) return;
        setMessages((prev) => mergeMessagesKeepingLocal(prev, msgs || []));
        setMembers(users || []);
        setHasMoreOlderForCurrent(Array.isArray(msgs) ? msgs.length >= initialLimit : false);
      } else {
        const ch = dmChannelsRef.current.find((c) => String(c.id) === String(channelId));
        const meId = profileRef.current?.id;
        const otherId = ch?.memberUserIds?.find((id) => String(id) !== String(meId));
        const membersP = (async () => {
          if (!otherId) return [];
          try {
            const other = await api(`/profile/${otherId}`, { method: "GET" });
            return other ? [other] : [];
          } catch {
            return [];
          }
        })();
        const unreadCount =
          (dmChannelsRef.current || []).find((c) => String(c.id) === String(channelId))?.unreadCount || 0;
        const initialLimit = Math.min(150, Math.max(MESSAGES_PAGE_SIZE, Number(unreadCount) || 0));
        const msgPath = `/dm/${channelId}/messages?limit=${encodeURIComponent(String(initialLimit))}`;
        const [msgs, mem] = await Promise.all([
          api(msgPath, { method: "GET" }),
          membersP
        ]);
        if (!isStillOnChannel(channelId)) return;
        setMessages((prev) => mergeMessagesKeepingLocal(prev, msgs || []));
        setMembers(mem || []);
        setHasMoreOlderForCurrent(Array.isArray(msgs) ? msgs.length >= initialLimit : false);
      }
    } catch (e) {
      if (isStillOnChannel(channelId)) {
        setError(e.message);
      }
    }
  }

  function computeFirstUnreadIndex(msgs, unreadCountRaw, meId) {
    const n0 = Math.max(0, Number(unreadCountRaw) || 0);
    if (!Array.isArray(msgs) || msgs.length === 0 || n0 <= 0) return -1;
    let idx = Math.max(0, msgs.length - n0);
    // Skip self-authored messages at the unread boundary (they can't be "unread").
    while (idx < msgs.length && String(msgs[idx]?.senderUserId || "") === String(meId || "")) {
      idx += 1;
    }
    if (idx >= msgs.length) return -1;
    return idx;
  }

  useEffect(() => {
    // Auto-scroll when opening a chat: first unread (from others) else bottom.
    if (!selectedChannelId) return;
    const key = `${uiMode}:${selectedChannelId}`;
    if (didAutoScrollRef.current[key]) return;
    if (!messagesBoxRef.current) return;
    if (!Array.isArray(messages)) return;

    const unreadCount =
      uiMode === "dm"
        ? (dmChannels || []).find((c) => String(c.id) === String(selectedChannelId))?.unreadCount
        : (channels || []).find((c) => String(c.id) === String(selectedChannelId))?.unreadCount;
    const meId = profileRef.current?.id;
    const firstUnreadIndex = computeFirstUnreadIndex(messages, unreadCount, meId);

    // Mark as done for this open; subsequent incoming messages should not yank scroll.
    didAutoScrollRef.current[key] = true;

    setTimeout(() => {
      if (!messagesBoxRef.current) return;
      if (firstUnreadIndex >= 0 && unreadDividerRef.current) {
        try { unreadDividerRef.current.scrollIntoView({ block: "start" }); } catch { /* ignore */ }
        shouldAutoScrollRef.current = false;
      } else {
        try { messagesBoxRef.current.scrollTop = messagesBoxRef.current.scrollHeight; } catch { /* ignore */ }
        shouldAutoScrollRef.current = true;
      }
    }, 0);
  }, [selectedChannelId, uiMode, messages, dmChannels, channels]);

  /** Scroll restore after prepending older messages (Safari / iOS / PWA friendly). */
  function scheduleRestoreScrollAfterPrepend({
    prevScrollHeight,
    prevScrollTop,
    anchorMsgId,
    anchorDistanceFromScrollTop,
    expectedCid,
    onDone
  }) {
    let resizeObs = null;
    const applyAnchor = () => {
      const box = messagesBoxRef.current;
      if (!box || !isStillOnChannel(expectedCid)) return;
      if (!anchorMsgId || anchorDistanceFromScrollTop == null) return;
      const n = document.getElementById(anchorMsgId);
      if (!n || !box.contains(n)) return;
      // Keep anchor at the same distance from scrollTop as before prepend.
      const nextTop = Number(n.offsetTop || 0) - Number(anchorDistanceFromScrollTop || 0);
      try { box.scrollTop = nextTop; } catch { /* ignore */ }
    };

    const applyFallbackDelta = () => {
      const box = messagesBoxRef.current;
      if (!box || !isStillOnChannel(expectedCid)) return;
      const delta = box.scrollHeight - prevScrollHeight;
      try { box.scrollTop = prevScrollTop + delta; } catch { /* ignore */ }
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (anchorMsgId && anchorDistanceFromScrollTop != null) applyAnchor();
        else applyFallbackDelta();
        requestAnimationFrame(() => {
          if (anchorMsgId && anchorDistanceFromScrollTop != null) applyAnchor();
          const box = messagesBoxRef.current;
          if (box && isStillOnChannel(expectedCid)) {
            try {
              resizeObs = new ResizeObserver(() => {
                if (anchorMsgId && anchorDistanceFromScrollTop != null) applyAnchor();
              });
              resizeObs.observe(box);
              setTimeout(() => {
                try {
                  resizeObs?.disconnect?.();
                } catch {
                  /* ignore */
                }
                resizeObs = null;
              }, 900);
            } catch {
              /* ResizeObserver unsupported */
            }
          }
          try {
            onDone?.();
          } catch {
            /* ignore */
          }
        });
      });
    });
  }

  function messageIsLoaded(messageId) {
    const rid = String(messageId || "");
    if (!rid) return false;
    return (messagesRef.current || []).some((m) => String(m?.id || "") === rid);
  }

  function scrollMessageNodeIntoView(box, node) {
    if (!box || !node) return;
    const boxRect = box.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const delta = (nodeRect.top - boxRect.top) - (box.clientHeight - nodeRect.height) / 2;
    const next = box.scrollTop + delta;
    try {
      box.scrollTo({ top: Math.max(0, next), behavior: "smooth" });
    } catch {
      try { box.scrollTop = Math.max(0, next); } catch { /* ignore */ }
    }
  }

  function flashMessageHighlight(messageId) {
    const rid = String(messageId || "");
    if (!rid) return;
    setHighlightedMessageId(rid);
    try {
      if (messageHighlightTimerRef.current) clearTimeout(messageHighlightTimerRef.current);
    } catch { /* ignore */ }
    messageHighlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId((cur) => (String(cur) === rid ? "" : cur));
      messageHighlightTimerRef.current = null;
    }, 1400);
  }

  function tryScrollToMessage(messageId) {
    const rid = String(messageId || "");
    if (!rid) return false;
    const box = messagesBoxRef.current;
    const node = document.getElementById(`msg-${rid}`);
    if (!box || !node || !box.contains(node)) return false;
    scrollMessageNodeIntoView(box, node);
    flashMessageHighlight(rid);
    return true;
  }

  async function fetchOlderMessagesPage({ restoreScroll = true } = {}) {
    if (loadOlderInFlightRef.current) return { ok: false, added: 0, busy: true };
    loadOlderInFlightRef.current = true;
    try {
    const cid = String(selectedChannelIdRef.current || "");
    const mode = String(uiModeRef.current || "server");
    if (!cid) return { ok: false, added: 0 };

    const el = messagesBoxRef.current;
    const current = Array.isArray(messagesRef.current) ? messagesRef.current : [];
    const list = Array.isArray(current) ? current : [];
    const oldest = list[0];
    const before = oldest?.createdAtUtc;
    if (!before) {
      setHasMoreOlderForCurrent(false);
      return { ok: false, added: 0 };
    }

    let anchorMsgId = "";
    let anchorDistanceFromScrollTop = null;
    if (restoreScroll && el) {
      try {
        const boxRect = el.getBoundingClientRect?.();
        const boxTop = boxRect?.top ?? 0;
        const nodes = el.querySelectorAll?.(".message[id^='msg-']") || [];
        for (const n of nodes) {
          const r = n.getBoundingClientRect?.();
          if (!r) continue;
          if (r.bottom > boxTop + 8) {
            anchorMsgId = String(n.id || "");
            anchorDistanceFromScrollTop = Number(n.offsetTop || 0) - Number(el.scrollTop || 0);
            break;
          }
        }
      } catch {
        /* ignore */
      }
    }

    const startedPageKey = pageKey();
    const prevScrollHeight = el?.scrollHeight || 0;
    const prevScrollTop = el?.scrollTop || 0;

    const pathBase = mode === "dm" ? `/dm/${cid}/messages` : `/channels/${cid}/messages`;
    const url = `${pathBase}?limit=${encodeURIComponent(String(MESSAGES_PAGE_SIZE))}&before=${encodeURIComponent(String(before))}`;
    const older = await api(url, { method: "GET" });
    if (!isStillOnChannel(cid)) return { ok: false, added: 0 };

    const olderList = Array.isArray(older) ? older : [];
    if (olderList.length === 0) {
      setHasMoreOlderForCurrent(false);
      return { ok: false, added: 0 };
    }

    setMessages((prev) => {
      const prevList = Array.isArray(prev) ? prev : [];
      const seen = new Set(prevList.map((m) => String(m?.id || "")));
      const merged = [];
      for (const m of olderList) {
        const id = String(m?.id || "");
        if (id && !seen.has(id)) merged.push(m);
      }
      return capMessagesList([...merged, ...prevList]);
    });

    if (restoreScroll && el) {
      await new Promise((resolve) => {
        scheduleRestoreScrollAfterPrepend({
          prevScrollHeight,
          prevScrollTop,
          anchorMsgId,
          anchorDistanceFromScrollTop,
          expectedCid: cid,
          onDone: resolve
        });
      });
    } else {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }

    if (olderList.length < MESSAGES_PAGE_SIZE) {
      setHasMoreOlderForCurrent(false);
    }

    return { ok: true, added: olderList.length };
    } finally {
      loadOlderInFlightRef.current = false;
    }
  }

  async function loadOlderUntilMessageId(messageId) {
    const rid = String(messageId || "");
    if (!rid) return false;
    if (messageIsLoaded(rid)) return true;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (messageIsLoaded(rid)) return true;
      const { hasMoreOlder, loadingOlder } = getPageStateForCurrent();
      if (!hasMoreOlder) break;
      if (loadingOlder || loadOlderInFlightRef.current) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      const res = await fetchOlderMessagesPage({ restoreScroll: false });
      if (res.busy) {
        await new Promise((r) => setTimeout(r, 60));
        continue;
      }
      if (!res.ok) break;
    }
    return messageIsLoaded(rid);
  }

  async function jumpToReferencedMessage(messageId) {
    const rid = String(messageId || "");
    if (!rid) return;
    if (tryScrollToMessage(rid)) return;

    if (messageIsLoaded(rid)) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (tryScrollToMessage(rid)) return;
    }

    setStatus("Загрузка сообщения…");
    const found = await loadOlderUntilMessageId(rid);
    if (!found) {
      setStatus("");
      setError("Исходное сообщение не найдено в этой переписке");
      return;
    }

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    setStatus("");
    if (!tryScrollToMessage(rid)) {
      setError("Не удалось прокрутить к сообщению");
    }
  }

  async function loadOlderMessagesIfNeeded(reason) {
    let finishLoad = () => {};
    try {
      const cid = String(selectedChannelIdRef.current || "");
      if (!cid) return;
      const el = messagesBoxRef.current;
      if (!el) return;

      const { loadingOlder, hasMoreOlder } = getPageStateForCurrent();
      if (loadingOlder || loadOlderInFlightRef.current || !hasMoreOlder) return;

      const startedPageKey = pageKey();
      setLoadingOlderForCurrent(true);
      finishLoad = () => {
        const cur = pageStateRef.current[startedPageKey] || {};
        pageStateRef.current[startedPageKey] = { ...cur, loadingOlder: false };
      };

      const res = await fetchOlderMessagesPage({ restoreScroll: true });
      if (!res.ok) {
        finishLoad();
        return;
      }
      finishLoad();
    } catch {
      finishLoad();
    }
  }

  // Infinite scroll upwards: when user scrolls near the top, fetch older messages.
  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      raf = requestAnimationFrame(() => {
        if (!messagesBoxRef.current) return;
        if (messagesBoxRef.current.scrollTop <= 120) {
          const now = Date.now();
          const last = Number(loadOlderCooldownRef.current?.at || 0);
          // Safari/iOS momentum scroll can spam events at the top edge.
          if (now - last < 150) return;
          loadOlderCooldownRef.current = { at: now };
          loadOlderMessagesIfNeeded("scroll-top").catch(() => {});
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      try { el.removeEventListener("scroll", onScroll); } catch { /* ignore */ }
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
    };
  }, [selectedChannelId, uiMode]);

  // Show "jump to bottom" button when scrolled away from the bottom.
  useEffect(() => {
    const el = messagesBoxRef.current;
    if (!el) return;
    let raf = 0;
    const THRESH_PX = 520;
    const update = () => {
      const box = messagesBoxRef.current;
      if (!box) return;
      const dist = (box.scrollHeight - (box.scrollTop + box.clientHeight));
      const shouldShow = dist > THRESH_PX && !shouldAutoScrollRef.current;
      setShowJumpToBottom(shouldShow);
    };
    const onScroll = () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // initial
    setTimeout(update, 0);
    return () => {
      try { el.removeEventListener("scroll", onScroll); } catch { /* ignore */ }
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
    };
  }, [selectedChannelId, uiMode]);

  async function register() {
    clearAlerts();
    try {
      await api("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          login: authForm.login,
          password: authForm.password,
          nickname: authForm.nickname
        })
      });
      setStatus("Аккаунт создан. Теперь войдите.");
      setMode("login");
    } catch (e) {
      setError(e.message);
    }
  }

  async function login() {
    clearAlerts();
    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: authForm.login, password: authForm.password })
      });
      setToken(data.token);
      localStorage.setItem("sloncord_token", data.token);
      setStatus("Вход выполнен");
    } catch (e) {
      setError(e.message);
    }
  }

  function logout() {
    voiceRef.current?.destroy();
    voiceRef.current = null;
    try {
      hubRef.current?.stop();
    } catch {
      // ignore
    }
    hubRef.current = null;

    clearAvatarCache();
    avatarPrefetchedRef.current.clear();
    profilePrefetchedRef.current.clear();
    voicePresenceFetched.current.clear();

    setToken("");
    setProfile(null);
    setServers([]);
    setSelectedServerId("");
    setDmChannels([]);
    setSelectedChannelId("");
    setActiveVoiceChannelId("");
    setVoicePeerNames({});
    voiceNamesFetched.current.clear();
    setMessages([]);
    setMembers([]);
    setUserProfiles({});
    setAvatarUrlByFileId({});
    setUserAvatarUrlByUserId({});
    setServerAvatarUrlByServerId({});
    setVoicePresenceByChannelId({});
    setUiMode("server");
    setVoiceState({
      connected: false,
      joining: false,
      mediaLinkReady: false,
      room: "",
      peers: 0,
      muted: false,
      deafened: false,
      remotePeerUserIds: [],
      rosterUserIds: []
    });
    localStorage.removeItem("sloncord_token");
  }

  async function createNewServer() {
    clearAlerts();
    if (!newServerName.trim() || channelActionLock.current) return;
    channelActionLock.current = true;
    try {
      const created = await api("/servers", {
        method: "POST",
        body: JSON.stringify({ name: newServerName.trim(), description: (newServerDescription || "").trim() })
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setNewServerName("");
      setNewServerDescription("");
      setShowCreateServer(false);
      if (created?.id) {
        setSelectedServerId(created.id);
        const t = (created.channels || []).find((c) => c.kind === "public" || c.kind === "text");
        if (t) setSelectedChannelId(t.id);
      }
      setUiMode("server");
      if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
      setStatus("Сервер создан");
    } catch (e) {
      setError(e.message);
    } finally {
      channelActionLock.current = false;
    }
  }

  async function deleteServer(serverId) {
    clearAlerts();
    try {
      if (!token) return;
      await api(`/servers/${serverId}`, { method: "DELETE" });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      if (String(selectedServerId) === String(serverId)) {
        setSelectedServerId(list[0]?.id || "");
        const ft = (list[0]?.channels || []).find((c) => c.kind === "public" || c.kind === "text");
        setSelectedChannelId(ft?.id || "");
      }
      setStatus("Сервер удален");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function leaveServer(serverId) {
    clearAlerts();
    try {
      if (!token) return;
      await api(`/servers/${serverId}/leave`, { method: "POST" });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      if (String(selectedServerId) === String(serverId)) {
        setSelectedServerId(list[0]?.id || "");
        const ft = (list[0]?.channels || []).find((c) => c.kind === "public" || c.kind === "text");
        setSelectedChannelId(ft?.id || "");
      }
      setStatus("Вы покинули сервер");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function createChannel(nameOverride) {
    clearAlerts();
    const name = (nameOverride ?? newChannelName).trim();
    if (!name || !selectedServerId || channelActionLock.current) return;
    channelActionLock.current = true;
    try {
      const pendingCat = (selectedServer?.categories || []).find(
        (c) => String(c?.id) === String(pendingChannelCategoryId)
      );
      const isPrivate = pendingCat?.isPrivate ? true : !!newChannelPrivate;
      await api(`/servers/${selectedServerId}/channels`, {
        method: "POST",
        body: JSON.stringify({
          name,
          type: "text",
          isPrivate,
          categoryId: pendingChannelCategoryId || null,
        })
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setNewChannelName("");
      setNewChannelPrivate(false);
      setPendingChannelCategoryId("");
      setShowCreateTextChannel(false);
      setUiMode("server");
      if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
      setStatus("Канал создан");
    } catch (e) {
      setError(e.message);
    } finally {
      channelActionLock.current = false;
    }
  }

  async function createVoiceChannel(nameOverride) {
    clearAlerts();
    const name = (nameOverride ?? newVoiceChannelName).trim();
    if (!name || !selectedServerId || channelActionLock.current) return;
    channelActionLock.current = true;
    try {
      const pendingCat = (selectedServer?.categories || []).find(
        (c) => String(c?.id) === String(pendingChannelCategoryId)
      );
      const isPrivate = pendingCat?.isPrivate ? true : !!newVoiceChannelPrivate;
      await api(`/servers/${selectedServerId}/channels`, {
        method: "POST",
        body: JSON.stringify({
          name,
          type: "voice",
          isPrivate,
          categoryId: pendingChannelCategoryId || null,
        })
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setNewVoiceChannelName("");
      setNewVoiceChannelPrivate(false);
      setPendingChannelCategoryId("");
      setShowCreateVoiceChannel(false);
      setUiMode("server");
      setStatus("Голосовой канал создан");
    } catch (e) {
      setError(e.message);
    } finally {
      channelActionLock.current = false;
    }
  }

  async function copyServerInvite() {
    clearAlerts();
    if (!selectedServer?.inviteCode) {
      setError("Нет кода приглашения");
      return;
    }
    const u = buildServerInviteUrl(String(selectedServer.inviteCode));
    try {
      if (window.sloncord?.writeClipboardText) {
        const r = await window.sloncord.writeClipboardText(u);
        if (r?.ok) {
          setStatus("Ссылка приглашения скопирована");
          return;
        }
      }
      await navigator.clipboard.writeText(u);
      setStatus("Ссылка приглашения скопирована");
    } catch {
      setError("Не удалось скопировать ссылку");
    }
  }

  async function uploadServerAvatar(serverId, file) {
    clearAlerts();
    try {
      if (!token) return;
      if (!file) return;
      const base64 = await fileToBase64(file);
      // show immediately (no reload)
      setServerAvatarUrlByServerId((prev) => ({ ...prev, [String(serverId)]: `data:${file.type || "image/png"};base64,${base64}` }));
      const res = await api(`/servers/${serverId}/avatar`, {
        method: "PUT",
        body: JSON.stringify({
          fileBase64: base64,
          fileName: file.name || "server.png",
          contentType: file.type || "image/png"
        })
      });
      const fid = res?.avatarFileId || "";
      if (fid) {
        const url = await ensureAvatarUrl(fid);
        if (url) setServerAvatarUrlByServerId((prev) => ({ ...prev, [String(serverId)]: url }));
      }
      setStatus("Аватар сервера обновлен");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function saveRenameServer() {
    clearAlerts();
    try {
      if (!selectedServer) return;
      await api(`/servers/${selectedServer.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: renameServerForm.name,
          description: renameServerForm.description
        })
      });
      setShowRenameServer(false);
      setServerMenuOpen(false);
      setStatus("Сервер обновлен");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function saveRenameChannel() {
    clearAlerts();
    try {
      const id = String(renameChannelForm.id || "");
      const name = (renameChannelForm.name || "").trim();
      if (!id || !name) return;
      await api(`/channels/${id}/meta`, { method: "PUT", body: JSON.stringify({ name }) });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setShowRenameChannel(false);
      setStatus("Канал обновлён");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function startDmByNickname() {
    clearAlerts();
    if (!inviteNickname.trim()) return;
    try {
      const dm = await api("/dm/start-by-nickname", {
        method: "POST",
        body: JSON.stringify({ nickname: inviteNickname })
      });
      setInviteNickname("");
      setShowNewDmModal(false);

      const next = sortDmChannels([dm, ...dmChannels.filter((c) => c.id !== dm.id)]);
      setDmChannels(next);
      setUiMode("dm");
      setSelectedChannelId(dm.id);
      if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
      setStatus("DM открыт");
    } catch (e) {
      setError(e.message);
    }
  }

  function isMobileComposerLayout() {
    try {
      return window.matchMedia("(max-width: 900px)").matches;
    } catch {
      return false;
    }
  }

  function syncComposerHeight() {
    const el = composerInputRef.current;
    if (!el) return;
    try {
      el.style.height = "auto";
      const next = Math.min(160, Math.max(36, el.scrollHeight));
      el.style.height = `${next}px`;
    } catch {
      /* ignore */
    }
  }

  function handleComposerKeyDown(e) {
    if (e.key === "ArrowUp") {
      startEditLastOwnMessage();
      return;
    }
    if (e.key !== "Enter") {
      emitTypingSoon();
      return;
    }
    if (e.isComposing || e.nativeEvent?.isComposing) return;
    if (isMobileComposerLayout()) {
      emitTypingSoon();
      return;
    }
    if (e.shiftKey) {
      emitTypingSoon();
      return;
    }
    e.preventDefault();
    sendChatMessage();
  }

  async function sendChatMessage() {
    if (sendChatInFlightRef.current) return;
    clearAlerts();
    if (activeChatMute) return;
    if (!selectedChannel) return;
    const pending = Array.isArray(pendingAttachments) ? pendingAttachments.filter((a) => a?.file) : [];
    const hasPending = pending.length > 0;
    const rawText = String(newMessage || "");
    const text = rawText.trim();
    if (!hasPending && !text) return;
    const replyToId = replyDraft?.id ? String(replyDraft.id) : "";
    // Clear reply immediately for snappier UX (Discord-like).
    if (replyToId) setReplyDraft(null);
    // Clear input immediately for UX; restore on failure.
    const restoreDraft = rawText;
    setNewMessage("");
    syncComposerHeight();
    try {
      if (hasPending) {
        const path = uiMode === "server" ? `/channels/${selectedChannelId}/messages` : `/dm/${selectedChannelId}/messages`;
        // Auto-split: max 10 files per message.
        const chunks = [];
        for (let i = 0; i < pending.length; i += 10) chunks.push(pending.slice(i, i + 10));

        const meId = String(profile?.id || "");
        const meNick = String(profile?.nickname || "Я");
        const meAvatarFid = String(profile?.avatarFileId || "");

        // Create optimistic local messages (appear immediately with "отправка..." + per-file progress).
        const localIds = chunks.map((_, ci) => `local-${Date.now()}-${Math.random().toString(16).slice(2)}-${ci}`);
        const createdAt = new Date().toISOString();
        const localMsgs = chunks.map((chunk, ci) => ({
          id: localIds[ci],
          channelId: String(selectedChannelId),
          text: ci === 0 ? (text || "") : "",
          createdAtUtc: createdAt,
          editedAtUtc: null,
          senderUserId: meId,
          senderNickname: meNick,
          senderAvatarFileId: meAvatarFid,
          isDeleted: false,
          attachments: [],
          clientStatus: "sending",
          clientReplyToMessageId: ci === 0 ? replyToId : "",
          clientAttachments: chunk.map((a) => ({
            id: String(a.id || ""),
            name: String(a.file?.name || "file.bin"),
            type: String(a.file?.type || "application/octet-stream"),
            previewUrl: String(a.previewUrl || ""),
            progress: Number(a.progress) || 0,
            status: String(a.status || "queued"),
            errorMessage: String(a.errorMessage || ""),
            file: a.file || null,
            uploadedFileId: ""
          }))
        }));

        if (String(selectedChannelId) === String(selectedChannelIdRef.current)) {
          setMessages((prev) => ([...prev, ...localMsgs]));
          setTimeout(() => scrollToBottomIfPinned(), 0);
        }

        // Clear composer attachments immediately; uploads continue in the background.
        setPendingAttachmentsForChat([]);
        sendChatInFlightRef.current = true;

        // Background: upload + POST, while updating the local message progress.
        (async () => {
          try {
            for (let ci = 0; ci < chunks.length; ci += 1) {
              const localMsgId = localIds[ci];
              const chunk = chunks[ci];
              const files = [];
              const attachmentFileIds = [];
              const THRESHOLD_BYTES = 512 * 1024; // 512KB per file
              let base64BudgetBytes = 1024 * 1024; // 1MB total per message chunk

              for (const a of chunk) {
                const attId = String(a.id || "");
                const f = a.file;
                if (!f) continue;

                // Mark uploading on the optimistic message
                setMessages((prev) => prev.map((m) => {
                  if (String(m.id) !== String(localMsgId)) return m;
                  const ca = Array.isArray(m.clientAttachments) ? m.clientAttachments : [];
                  return {
                    ...m,
                    clientAttachments: ca.map((x) => (String(x.id) === attId ? { ...x, status: "uploading", progress: 0, errorMessage: "" } : x))
                  };
                }));

                const sizeBytes = Number(f.size);
                const normalizedSizeBytes = Number.isFinite(sizeBytes) ? sizeBytes : 0;
                const canBase64 = sizeBytes > 0 && sizeBytes <= THRESHOLD_BYTES && base64BudgetBytes - sizeBytes > 0;
                try {
                  if (canBase64 || normalizedSizeBytes <= 0) {
                    const base64 = await fileToBase64WithProgress(f, (p) => {
                      setMessages((prev) => prev.map((m) => {
                        if (String(m.id) !== String(localMsgId)) return m;
                        const ca = Array.isArray(m.clientAttachments) ? m.clientAttachments : [];
                        return {
                          ...m,
                          clientAttachments: ca.map((x) => (
                            String(x.id) === attId ? { ...x, progress: Math.max(0, Math.min(1, p || 0)) } : x
                          ))
                        };
                      }));
                    });
                    files.push({
                      fileBase64: base64,
                      fileName: f.name || "file.bin",
                      contentType: f.type || "application/octet-stream"
                    });
                    if (Number.isFinite(sizeBytes) && sizeBytes > 0) base64BudgetBytes -= sizeBytes;
                    setMessages((prev) => prev.map((m) => {
                      if (String(m.id) !== String(localMsgId)) return m;
                      const ca = Array.isArray(m.clientAttachments) ? m.clientAttachments : [];
                      return {
                        ...m,
                        clientAttachments: ca.map((x) => (String(x.id) === attId ? { ...x, status: "done", progress: 1 } : x))
                      };
                    }));
                  } else {
                    const fileId = await uploadLargeFileSequential(f, token, (p) => {
                      setMessages((prev) => prev.map((m) => {
                        if (String(m.id) !== String(localMsgId)) return m;
                        const ca = Array.isArray(m.clientAttachments) ? m.clientAttachments : [];
                        return {
                          ...m,
                          clientAttachments: ca.map((x) => (
                            String(x.id) === attId ? { ...x, progress: Math.max(0, Math.min(1, p || 0)) } : x
                          ))
                        };
                      }));
                    });
                    attachmentFileIds.push(fileId);
                    setMessages((prev) => prev.map((m) => {
                      if (String(m.id) !== String(localMsgId)) return m;
                      const ca = Array.isArray(m.clientAttachments) ? m.clientAttachments : [];
                      return {
                        ...m,
                        clientAttachments: ca.map((x) => (String(x.id) === attId ? { ...x, status: "done", progress: 1, uploadedFileId: fileId } : x))
                      };
                    }));
                  }
                } catch (err) {
                  const emsg = err?.message || String(err);
                  setMessages((prev) => prev.map((m) => {
                    if (String(m.id) !== String(localMsgId)) return m;
                    const ca = Array.isArray(m.clientAttachments) ? m.clientAttachments : [];
                    return {
                      ...m,
                      clientStatus: "error",
                      clientAttachments: ca.map((x) => (String(x.id) === attId ? { ...x, status: "error", errorMessage: emsg, progress: 0 } : x))
                    };
                  }));
                  throw err;
                }
              }

              const created = await api(path, {
                method: "POST",
                body: JSON.stringify({
                  text: ci === 0 ? (text || "") : "",
                  replyToMessageId: ci === 0 && replyToId ? replyToId : undefined,
                  files: files.length ? files : undefined,
                  attachmentFileIds: attachmentFileIds.length ? attachmentFileIds : undefined
                })
              });

              if (String(selectedChannelIdRef.current) === String(selectedChannelId)) {
                setMessages((prev) => reconcileOptimisticMessage(prev, created));
              }
            }

            // Fallback only: if realtime was delayed/missed, refresh after a short delay.
            const cid = String(selectedChannelIdRef.current || "");
            const m0 = String(uiModeRef.current || "server");
            setTimeout(() => {
              if (!cid) return;
              refreshConversationData(cid, m0).catch(() => {});
            }, 1500);
          } catch (err) {
            const emsg = err?.message || String(err);
            // Restore draft on failure so user doesn't lose text.
            setNewMessage((cur) => (cur ? cur : restoreDraft));
            setError(emsg);
          } finally {
            sendChatInFlightRef.current = false;
          }
        })();
        return;
      } else if (uiMode === "server") {
        await api(`/channels/${selectedChannelId}/messages`, {
          method: "POST",
          body: JSON.stringify({ text, replyToMessageId: replyToId ? replyToId : undefined })
        });
      } else {
        await api(`/dm/${selectedChannelId}/messages`, {
          method: "POST",
          body: JSON.stringify({ text, replyToMessageId: replyToId ? replyToId : undefined })
        });
      }
      // Do not block UI; realtime delivers message. Use refresh only as delayed fallback.
      const cid = String(selectedChannelIdRef.current || "");
      const m0 = String(uiModeRef.current || "server");
      setTimeout(() => {
        if (!cid) return;
        refreshConversationData(cid, m0).catch(() => {});
      }, 1500);
    } catch (e) {
      // Restore draft on failure so user doesn't lose text.
      setNewMessage((cur) => (cur ? cur : restoreDraft));
      setError(e?.message || String(e));
    }
  }

  useEffect(() => {
    // Changing chat should drop any pending reply draft (Discord-like)
    setReplyDraft(null);
    // Also close message menu/editing
    setMessageMenu({ openForId: "" });
    // Also close channel menu (if any)
    try { setChannelMenu({ openForId: "", x: 0, y: 0 }); } catch { /* ignore */ }
    setEditing({ id: "", text: "", originalText: "", removeAttachmentFileIds: [] });
  }, [selectedChannelId, uiMode]);

  useEffect(() => {
    // Desktop/web-desktop: focus composer when opening a chat.
    // Mobile/narrow: avoid auto-focus to not pop the keyboard unexpectedly.
    if (!selectedChannelId) return;
    if (isNarrow) return;
    if (!selectedChannel) return;
    if (editing?.id) return;
    if (Array.isArray(pendingAttachments) && pendingAttachments.length > 0) return;
    const el = composerInputRef.current;
    if (!el) return;
    // If user is typing in another input (e.g. rename modal), don't steal focus.
    try {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body) {
        const tag = String((ae as any)?.tagName || "").toLowerCase();
        const isTextField = tag === "input" || tag === "textarea" || (ae as any)?.isContentEditable;
        if (isTextField && ae !== el) return;
      }
    } catch { /* ignore */ }
    const t = setTimeout(() => {
      try { composerInputRef.current?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    }, 0);
    return () => {
      try { clearTimeout(t); } catch { /* ignore */ }
    };
  }, [selectedChannelId, uiMode, isNarrow, selectedChannel, editing?.id, pendingAttachments?.length]);

  useEffect(() => {
    if (!replyDraft?.id) return;
    const t = setTimeout(() => {
      try { composerInputRef.current?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
    }, 0);
    return () => {
      try { clearTimeout(t); } catch { /* ignore */ }
    };
  }, [replyDraft?.id]);

  useLayoutEffect(() => {
    syncComposerHeight();
  }, [newMessage]);

  // Prefetch DM avatars as soon as DM list updates (so they appear without clicking a chat).
  useEffect(() => {
    const meId = String(profile?.id || "");
    const list = Array.isArray(dmChannels) ? dmChannels : [];
    if (!list.length) return;
    const otherIds = new Set();
    for (const ch of list) {
      const ids = Array.isArray(ch?.memberUserIds) ? ch.memberUserIds.map(String) : [];
      const otherId = String(ids.find((x) => x && x !== meId) || "");
      if (otherId) otherIds.add(otherId);
    }
    if (otherIds.size === 0) return;
    otherIds.forEach((uid) => {
      // best-effort: profile fetch also warms avatar cache
      ensureUserProfile(uid).catch(() => {});
    });
  }, [dmChannels, profile?.id]);

  const forwardTargets = useMemo(() => {
    const out = [];
    for (const dm of (dmChannels || [])) {
      out.push({
        key: `dm:${String(dm.id)}`,
        kind: "dm",
        id: String(dm.id),
        label: String(dm.name || dm.title || dm.nickname || "ЛС"),
        sublabel: "Личные сообщения"
      });
    }
    for (const s of (servers || [])) {
      for (const ch of (s.channels || [])) {
        const k = String(ch.kind || ch.type || "").toLowerCase();
        if (k === "voice") continue;
        out.push({
          key: `ch:${String(ch.id)}`,
          kind: "channel",
          id: String(ch.id),
          label: `#${String(ch.name || "канал")}`,
          sublabel: String(s.name || "сервер")
        });
      }
    }
    return out;
  }, [dmChannels, servers]);

  async function submitForward() {
    const src = forwardModal?.source;
    if (!src) return;
    const sel = forwardModal?.selectedIds || {};
    const selected = Object.keys(sel).filter((k) => !!sel[k]);
    if (!selected.length) return;

    const sender = String(src.senderNickname || "пользователь");
    const originalText = String(src.text || "").trim();
    const prefix = `↪ переслано от ${sender}\n`;
    const composedText = `${prefix}${originalText}`.trimEnd();

    const atts = Array.isArray(src.attachments) && src.attachments.length > 0
      ? src.attachments
      : (src.file ? [src.file] : []);
    const attachmentFileIds = (atts || []).map((a) => String(a.id)).filter(Boolean);

    const chunks = [];
    for (let i = 0; i < attachmentFileIds.length; i += 10) chunks.push(attachmentFileIds.slice(i, i + 10));
    if (chunks.length === 0) chunks.push([]);

    try {
      for (const key of selected) {
        const [kind, id] = String(key).split(":");
        const basePath = kind === "dm" ? `/dm/${id}/messages` : `/channels/${id}/messages`;
        for (let ci = 0; ci < chunks.length; ci += 1) {
          await api(basePath, {
            method: "POST",
            body: JSON.stringify({
              text: ci === 0 ? composedText : "",
              attachmentFileIds: chunks[ci].length ? chunks[ci] : undefined
            })
          });
        }
      }
      const onlyOne = selected.length === 1 ? String(selected[0] || "") : "";
      setForwardModal({ open: false, query: "", selectedIds: {}, source: null });
      // If forwarded to exactly one chat, open it (Discord-like).
      if (onlyOne) {
        const [kind, id] = String(onlyOne).split(":");
        if (kind === "dm") {
          selectTextChannel(String(id), "dm");
        } else if (kind === "ch") {
          // Switch to server mode and open the channel; also pick its server if possible.
          let serverId = "";
          try {
            for (const s of (servers || [])) {
              const hit = (s.channels || []).some((c) => String(c.id) === String(id));
              if (hit) { serverId = String(s.id); break; }
            }
          } catch { /* ignore */ }
          if (serverId) setSelectedServerId(serverId);
          setUiMode("server");
          selectTextChannel(String(id), "server");
        }
      }
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  function splitForwardedText(raw) {
    const t = String(raw || "");
    const lines = t.split("\n");
    const first = String(lines[0] || "");
    if (first.startsWith("↪ переслано от ")) {
      return { header: first, body: lines.slice(1).join("\n").replace(/^\n+/, "") };
    }
    return { header: "", body: t };
  }

  async function downloadFile(fileId, originalName) {
    clearAlerts();
    try {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const url = `${getApiBase()}/files/${fileId}/content`;

      // Opens the system save dialog immediately, then streams (avoids loading the whole file before the dialog).
      const sp = typeof window !== "undefined" ? window.showSaveFilePicker : undefined;
      if (typeof sp === "function") {
        try {
          const handle = await sp({
            suggestedName: originalName || "file.bin"
          });
          const writable = await handle.createWritable();
          const r = await fetch(url, { headers });
          if (!r.ok) {
            try {
              await writable.abort();
            } catch {
              /* ignore */
            }
            throw new Error(`Не удалось скачать файл (${r.status})`);
          }
          if (r.body && typeof r.body.pipeTo === "function") {
            await r.body.pipeTo(writable);
          } else {
            const blob = await r.blob();
            await writable.write(blob);
            await writable.close();
          }
          return;
        } catch (e) {
          const name = e && typeof e === "object" ? e.name : "";
          if (name === "AbortError") return;
          // Unsupported or failed — fall through to blob download.
        }
      }

      let r = await fetch(url, { headers });
      if (r.ok) {
        const blob = await r.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = originalName || "file.bin";
        link.click();
        URL.revokeObjectURL(blobUrl);
        return;
      }
      // Fallback to legacy base64 API
      const data = await api(`/files/${fileId}`, { method: "GET" });
      const bytes = atob(data.fileBase64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1) {
        arr[i] = bytes.charCodeAt(i);
      }
      const blob = new Blob([arr], { type: data.file.contentType || "application/octet-stream" });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = originalName || "file.bin";
      link.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      setError(e.message);
    }
  }

  function startEditMessage(msg) {
    const t = String(msg?.text || "");
    setEditing({ id: msg.id, text: t, originalText: t, removeAttachmentFileIds: [] });
    // When editing is triggered via ArrowUp, move focus into the inline editor.
    setTimeout(() => {
      try {
        const id = String(msg?.id || "");
        if (!id) return;
        const el = document.getElementById(`edit-${id}`);
        if (!el) return;
        // Focus without jumping, then ensure it isn't covered by the composer.
        el.focus?.({ preventScroll: true });
        const v = String(el.value || "");
        try { el.setSelectionRange?.(v.length, v.length); } catch { /* ignore */ }

        const scroller = messagesBoxRef.current;
        if (!scroller) return;

        // If the editor is under the composer, scroll up just enough.
        const r = el.getBoundingClientRect?.();
        if (!r) return;
        const composerEl = document.querySelector?.(".composer");
        const compR = composerEl?.getBoundingClientRect?.();
        const reserveBottom = (compR?.height || 0) + 12;
        const limitBottom = (window.innerHeight || 0) - reserveBottom;
        const overlap = (r.bottom || 0) - limitBottom;
        if (overlap > 4) {
          try { scroller.scrollTop = (scroller.scrollTop || 0) + overlap + 8; } catch { /* ignore */ }
        } else if ((r.top || 0) < 80) {
          // If it ended up too close to the top, nudge down slightly.
          try { scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) - (80 - (r.top || 0))); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }, 0);
  }

  function startEditLastOwnMessage() {
    if (!selectedChannel) return;
    if (editing?.id) return;
    if (String(newMessage || "").trim()) return; // only when composer is empty
    if (replyDraft?.id) return; // avoid surprising UX when replying
    if (Array.isArray(pendingAttachments) && pendingAttachments.length > 0) return; // don't steal focus when attachments pending

    const meId = String(profile?.id || "");
    if (!meId) return;
    const list = Array.isArray(messages) ? messages : [];
    // find last non-deleted message from me
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m) continue;
      if (m.isDeleted) continue;
      if (String(m.senderUserId) !== meId) continue;
      startEditMessage(m);
      // scroll it into view for clarity
      try {
        const el = document.getElementById(`msg-${String(m.id)}`);
        el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      } catch { /* ignore */ }
      return;
    }
  }

  async function saveEditMessage() {
    if (!editing.id || !selectedChannel) return;
    clearAlerts();
    try {
      const nextText = String(editing.text || "").trim();
      const prevText = String(editing.originalText || "").trim();
      const removeIds = Array.isArray(editing.removeAttachmentFileIds) ? editing.removeAttachmentFileIds.filter(Boolean) : [];
      // If nothing changed, don't call API (prevents false "изм.")
      if (!removeIds.length && nextText === prevText) {
        setEditing({ id: "", text: "", originalText: "", removeAttachmentFileIds: [] });
        return;
      }
      const path =
        uiMode === "server"
          ? `/channels/${selectedChannelId}/messages/${editing.id}`
          : `/dm/${selectedChannelId}/messages/${editing.id}`;
      const payload = {};
      if (nextText) payload.text = nextText;
      if (removeIds.length) payload.removeAttachmentFileIds = removeIds;
      await api(path, { method: "PUT", body: JSON.stringify(payload) });
      setEditing({ id: "", text: "", originalText: "", removeAttachmentFileIds: [] });
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteMessage(msgId) {
    if (!selectedChannel) return;
    clearAlerts();
    try {
      const path =
        uiMode === "server"
          ? `/channels/${selectedChannelId}/messages/${msgId}`
          : `/dm/${selectedChannelId}/messages/${msgId}`;
      await api(path, { method: "DELETE" });
    } catch (e) {
      setError(e.message);
    }
  }

  function closeReportModal() {
    setReportModal({ open: false, messageId: "", reason: "" });
  }

  async function submitReportMessage() {
    const msgId = String(reportModal.messageId || "").trim();
    if (!msgId) return;
    const channelId = String(selectedChannelId || "").trim();
    if (!channelId) {
      setError("Не выбран канал");
      return;
    }
    clearAlerts();
    const reason = String(reportModal.reason || "").trim();
    try {
      const path =
        uiMode === "server"
          ? `/channels/${channelId}/messages/${msgId}/report`
          : `/dm/${channelId}/messages/${msgId}/report`;
      const res = await api(path, {
        method: "POST",
        body: JSON.stringify({ reason: reason || undefined }),
      });
      closeReportModal();
      setStatus(res?.reportId ? "Жалоба отправлена модераторам" : "Жалоба отправлена");
    } catch (e) {
      setError(e.message);
    }
  }

  async function saveProfile() {
    clearAlerts();
    try {
      const next = String(pwdForm.next || "");
      const conf = String(pwdForm.confirm || "");
      const wantsPwd = next.length > 0 || conf.length > 0 || String(pwdForm.current || "").length > 0;
      if (wantsPwd && next !== conf) {
        setPwdTouched(true);
        setError("пароли должны совпадать");
        return;
      }
      const updated = await api("/profile", {
        method: "PUT",
        body: JSON.stringify({ nickname: editForm.nickname, bio: editForm.bio })
      });
      if (wantsPwd && next && String(pwdForm.current || "")) {
        await api("/profile/password", {
          method: "PUT",
          body: JSON.stringify({ currentPassword: pwdForm.current, newPassword: next })
        });
      }
      setProfile(updated);
      setShowEditProfile(false);
      setStatus("Профиль обновлен");
      setPwdForm({ current: "", next: "", confirm: "" });
      setPwdTouched(false);
    } catch (e) {
      setError(e.message);
    }
  }

  async function uploadMyAvatar(file) {
    clearAlerts();
    try {
      if (!token) return;
      if (!file) return;
      const base64 = await fileToBase64(file);
      // show immediately (no reload)
      if (profile?.id) {
        setUserAvatarUrlByUserId((prev) => ({ ...prev, [String(profile.id)]: `data:${file.type || "image/png"};base64,${base64}` }));
      }
      const updated = await api("/profile/avatar", {
        method: "PUT",
        body: JSON.stringify({
          fileBase64: base64,
          fileName: file.name || "avatar.png",
          contentType: file.type || "image/png"
        })
      });
      setProfile(updated);
      setStatus("Аватар обновлен");
      try {
        if (updated?.id) {
          setUserProfiles((prev) => trimProfileCache({
            ...(prev || {}),
            [String(updated.id)]: { ...(prev?.[String(updated.id)] || {}), avatarFileId: String(updated.avatarFileId || "") }
          }));
        }
      } catch { /* ignore */ }
      if (updated?.avatarFileId) {
        const url = await ensureAvatarUrl(updated.avatarFileId);
        if (url) setUserAvatarUrlByUserId((prev) => ({ ...prev, [String(updated.id)]: url }));
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  useEffect(() => {
    function onDocDown(e) {
      const openForId = String(messageMenu?.openForId || "");
      if (!openForId) return;
      const el = messageMenuRef.current;
      if (el && el.contains(e.target)) return;
      setMessageMenu({ openForId: "" });
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("touchstart", onDocDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("touchstart", onDocDown);
    };
  }, [messageMenu?.openForId]);

  useEffect(() => {
    function onDocDown(e) {
      if (!channelsContextMenu.open) return;
      const el = channelsContextMenuRef.current;
      if (el && el.contains(e.target)) return;
      closeChannelsContextMenu();
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("touchstart", onDocDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("touchstart", onDocDown);
    };
  }, [channelsContextMenu.open]);

  useEffect(() => {
    function onDocDown(e) {
      const openForId = String(channelMenu?.openForId || "");
      if (!openForId) return;
      const el = channelMenuRef.current;
      if (el && el.contains(e.target)) return;
      setChannelMenu({ openForId: "", x: 0, y: 0 });
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("touchstart", onDocDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("touchstart", onDocDown);
    };
  }, [channelMenu?.openForId]);

  // Clamp message menu to viewport (so it never goes off-screen).
  useEffect(() => {
    const openForId = String(messageMenu?.openForId || "");
    if (!openForId) return;
    const clamp = () => {
      const el = messageMenuRef.current;
      if (!el) return;
      const pad = 8;
      const r = el.getBoundingClientRect?.();
      if (!r) return;
      const vv = window.visualViewport;
      const vw = Number(vv?.width || window.innerWidth || 0);
      const vh = Number(vv?.height || window.innerHeight || 0);
      let left = Number(messageMenu?.x || 0);
      let top = Number(messageMenu?.y || 0) + 6;
      // If overflow right, shift left.
      if (left + r.width > vw - pad) left = Math.max(pad, vw - pad - r.width);
      // If overflow bottom, open upwards.
      if (top + r.height > vh - pad) top = Math.max(pad, (Number(messageMenu?.y || 0) - r.height - 6));
      // Ensure not above top.
      if (top < pad) top = pad;
      // Ensure not left of viewport.
      if (left < pad) left = pad;
      if (Math.round(left) !== Math.round(Number(messageMenu?.x || 0)) || Math.round(top) !== Math.round(Number(messageMenu?.y || 0) + 6)) {
        setMessageMenu((prev) => ({ ...(prev || {}), x: Math.round(left), y: Math.round(top - 6) }));
      }
    };
    const raf = requestAnimationFrame(clamp);
    const onResize = () => clamp();
    try { window.addEventListener("resize", onResize); } catch { /* ignore */ }
    return () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      try { window.removeEventListener("resize", onResize); } catch { /* ignore */ }
    };
  }, [messageMenu?.openForId, messageMenu?.x, messageMenu?.y]);

  // Clamp channel menu to viewport (so it never goes off-screen).
  useEffect(() => {
    const openForId = String(channelMenu?.openForId || "");
    if (!openForId) return;
    const clamp = () => {
      const el = channelMenuRef.current;
      if (!el) return;
      const pad = 8;
      const r = el.getBoundingClientRect?.();
      if (!r) return;
      const vv = window.visualViewport;
      const vw = Number(vv?.width || window.innerWidth || 0);
      const vh = Number(vv?.height || window.innerHeight || 0);
      let left = Number(channelMenu?.x || 0);
      let top = Number(channelMenu?.y || 0) + 6;
      // If overflow right, shift left.
      if (left + r.width > vw - pad) left = Math.max(pad, vw - pad - r.width);
      // If overflow bottom, open upwards.
      if (top + r.height > vh - pad) top = Math.max(pad, (Number(channelMenu?.y || 0) - r.height - 6));
      // Ensure not above top.
      if (top < pad) top = pad;
      // Ensure not left of viewport.
      if (left < pad) left = pad;
      if (Math.round(left) !== Math.round(Number(channelMenu?.x || 0)) || Math.round(top) !== Math.round(Number(channelMenu?.y || 0) + 6)) {
        setChannelMenu((prev) => ({ ...(prev || {}), x: Math.round(left), y: Math.round(top - 6) }));
      }
    };
    const raf = requestAnimationFrame(clamp);
    const onResize = () => clamp();
    try { window.addEventListener("resize", onResize); } catch { /* ignore */ }
    return () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      try { window.removeEventListener("resize", onResize); } catch { /* ignore */ }
    };
  }, [channelMenu?.openForId, channelMenu?.x, channelMenu?.y]);

  const messageMenuMsg = useMemo(() => {
    const id = String(messageMenu?.openForId || "");
    if (!id) return null;
    const list = Array.isArray(messages) ? messages : [];
    return list.find((m) => String(m?.id || "") === id) || null;
  }, [messageMenu?.openForId, messages]);

  function destroyVoiceInstance() {
    try {
      voiceRef.current?.destroy();
    } catch {
      // ignore
    }
    voiceRef.current = null;
  }

  async function destroyVoiceInstanceAsync() {
    const inst = voiceRef.current;
    voiceRef.current = null;
    if (!inst) return;
    try {
      inst.destroy();
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 220));
  }

  async function connectVoiceToChannel(voiceChannelId, opts) {
    if (connectVoiceInFlight.current) {
      pendingVoiceChannelId.current = String(voiceChannelId || "");
      return;
    }
    clearAlerts();
    connectVoiceInFlight.current = true;
    try {
      if (!token) return;
      if (!voiceChannelId) return;
      if (opts?.suppressJoinSfx) {
        suppressNextVoiceJoinSfxRef.current = true;
      }

      let voiceCfgEarly = null;
      try {
        voiceCfgEarly = await api("/voice/config", { method: "GET" });
      } catch {
        voiceCfgEarly = null;
      }
      const useNativeVoiceEarly = String(voiceCfgEarly?.mode || "") === "native";

      if (!useNativeVoiceEarly) {
        if (!window.isSecureContext) {
          setError("Голосовой чат в браузере требует HTTPS (или localhost). Откройте сайт по https://…");
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError("Этот браузер/контекст не даёт доступ к микрофону (нужен HTTPS/localhost и поддержка WebRTC).");
          return;
        }
      }

      const me = profile?.id ? profile : await api("/profile", { method: "GET" });
      setProfile(me);

      const prevVoiceChannelId = String(activeVoiceChannelId || "");
      setActiveVoiceChannelId(String(voiceChannelId));
      voiceNamesFetched.current.clear();
      setVoicePeerNames({});

      if (prevVoiceChannelId && prevVoiceChannelId !== String(voiceChannelId)) {
        if (uiMode === "server") {
          void api(`/channels/${prevVoiceChannelId}/voice/left`, { method: "POST" }).catch(() => {});
        }
        const meId = String(me?.id || profile?.id || "");
          setVoicePresenceByChannelId((prev) => {
            const p = prev[prevVoiceChannelId];
            if (!p) return prev;
            const nextIds = (p.userIds || []).map((x) => String(x)).filter((id) => id && id !== meId);
            return {
              ...prev,
              [prevVoiceChannelId]: {
                ...p,
                userIds: nextIds,
                startedAtUtc: nextIds.length > 0 ? (p.startedAtUtc || "") : "",
                speakingUserIds: (p.speakingUserIds || []).filter((x) => String(x) !== meId),
              }
            };
          });
      }

      const joinGen = (voiceJoinGeneration.current += 1);
      await destroyVoiceInstanceAsync();
      const pres = voicePresenceByChannelId[String(voiceChannelId)] || null;
      const presIds = (pres?.userIds || []).map((x) => String(x)).filter(Boolean);
      const presSharers = (pres?.screenShareUserIds || []).map((x) => String(x)).filter(Boolean);
      const presMuted = (pres?.mutedUserIds || []).map((x) => String(x)).filter(Boolean);
      const presDeaf = (pres?.deafenedUserIds || []).map((x) => String(x)).filter(Boolean);
      setVoiceState({
        connected: false,
        joining: true,
        mediaLinkReady: false,
        speakingUserIds: [],
        screenShareUserIds: presSharers,
        mutedUserIds: presMuted,
        deafenedUserIds: presDeaf,
        room: "",
        peers: 0,
        muted: (() => {
          try { return (localStorage.getItem("sloncord_voice_deafened") === "1") || (localStorage.getItem("sloncord_voice_mic_enabled") === "0"); } catch { return false; }
        })(),
        deafened: (() => {
          try { return localStorage.getItem("sloncord_voice_deafened") === "1"; } catch { return false; }
        })(),
        remotePeerUserIds: [],
        rosterUserIds: presIds
      });

      const host = remoteAudioHostRef.current;
      const videoHost = remoteVideoHostRef.current;
      const roomId = `channel:${voiceChannelId}`;
      const useNativeVoice = useNativeVoiceEarly;

      if (useNativeVoice) {
        const session = createNativeVoiceSession({
          token,
          roomId,
          selfUserId: me.id,
          remoteVideoHost: videoHost,
          onState: setVoiceState,
          onScreenAudioError: (msg) => {
            try {
              setError(String(msg || ""));
            } catch {
              /* ignore */
            }
          },
          onNativeVoiceError: (msg) => {
            setError(`Голос: ${String(msg || "ошибка native UDP")}`);
            try {
              leaveVoice();
            } catch {
              /* ignore */
            }
          },
          fetchNativeJoin: async () => {
            const j = await api("/voice/native/join", { method: "POST", body: JSON.stringify({ roomId }) });
            return {
              udpHost: String(j?.udpHost || ""),
              udpPort: Number(j?.udpPort || 0),
              sessionToken: String(j?.sessionToken || ""),
              sessionId: Number(j?.sessionId || 0),
            };
          },
          onForceLeave: () => {
            if (joinGen !== voiceJoinGeneration.current) return;
            if (!voiceRef.current) return;
            setError(
              "Голос отключён: с этим аккаунтом открыт другой Sloncord. Закройте лишние окна/версии и зайдите в канал снова."
            );
            try {
              leaveVoice();
            } catch {
              /* ignore */
            }
          },
          onVoiceMove: (channelId) => {
            if (String(channelId) === String(voiceChannelId)) return;
            try {
              playVoiceSfx("moved");
              void connectVoiceToChannel(String(channelId), { suppressJoinSfx: true });
            } catch {
              /* ignore */
            }
          },
        });
        voiceRef.current = session;
        await session.join();
        try {
          localStorage.setItem("sloncord_last_voice_channel_id", String(voiceChannelId));
        } catch {
          // ignore
        }
        setStatus("В голосовом канале (native UDP).");
        return;
      }

      let iceServers = null;
      try {
        const cfg = await api("/voice/ice", { method: "GET" });
        iceServers = cfg?.iceServers || null;
      } catch {
        iceServers = null;
      }
      const sfu = await api("/voice/sfuToken", { method: "POST", body: JSON.stringify({ roomId }) });
      const useVoiceGateway = sfu?.gateway === true;
      const session = createSfuVoiceSession({
        token,
        roomId,
        selfUserId: me.id,
        remoteAudioHost: host,
        remoteVideoHost: videoHost,
        onState: setVoiceState,
        iceServers,
        tokenTtlSeconds: sfu?.tokenTtlSeconds,
        useVoiceGateway,
        sfuUrl: useVoiceGateway ? "" : sfu?.sfuUrl,
        sfuToken: useVoiceGateway ? "" : sfu?.token,
        refreshSfuCredentials: async () => {
          if (useVoiceGateway) return { gateway: true };
          const next = await api("/voice/sfuToken", { method: "POST", body: JSON.stringify({ roomId }) });
          return {
            sfuUrl: next?.sfuUrl,
            sfuToken: next?.token,
            tokenTtlSeconds: next?.tokenTtlSeconds
          };
        },
        onCloseScreenViewForPeer: (uid) => {
          try {
            closeScreenViewForPeer(String(uid));
          } catch {
            /* ignore */
          }
        },
        onRefreshScreenViewForPeer: (uid) => {
          try {
            refreshScreenViewStreamForPeer(String(uid));
          } catch {
            /* ignore */
          }
        },
        onDetachScreenViewForPeer: (uid) => {
          try {
            detachScreenViewForPeer(String(uid));
          } catch {
            /* ignore */
          }
        },
        onScreenAudioError: (msg) => {
          try {
            setError(String(msg || ""));
          } catch {
            /* ignore */
          }
        },
        onForceLeave: () => {
          try { leaveVoice(); } catch { /* ignore */ }
        },
        onVoiceMove: (channelId) => {
          try {
            playVoiceSfx("moved");
            void connectVoiceToChannel(String(channelId), { suppressJoinSfx: true });
          } catch {
            /* ignore */
          }
        }
      });
      voiceRef.current = session;
      await session.join();
      try {
        voiceRef.current?.setInputDevice?.(String(audioSettings.inputDeviceId || ""));
        voiceRef.current?.setMicGain?.(audioSettings.micGain);
        voiceRef.current?.setAudioProcessing?.(buildVoiceProcessingOpts(audioSettings));
        voiceRef.current?.setOutputDevice?.(String(audioSettings.outputDeviceId || ""));
        voiceRef.current?.setSpeakerGain?.(audioSettings.speakerGain);
      } catch {
        /* ignore */
      }
      try {
        localStorage.setItem("sloncord_last_voice_channel_id", String(voiceChannelId));
      } catch {
        // ignore
      }
      setStatus("В голосовом канале. Сигнальные обмены идут в фоне.");
    } catch (e) {
      setActiveVoiceChannelId("");
      setError(e.message || String(e));
      setVoiceState((prev) => ({
        ...prev,
        connected: false,
        joining: false,
        mediaLinkReady: false
      }));
    } finally {
      connectVoiceInFlight.current = false;
      const pending = pendingVoiceChannelId.current;
      if (pending) {
        pendingVoiceChannelId.current = null;
        void connectVoiceToChannel(pending, { suppressJoinSfx: true }).catch(() => {});
      }
    }
  }

  function leaveVoice() {
    voiceJoinGeneration.current += 1;
    clearAlerts();
    try {
      const leavingChannelId = String(activeVoiceChannelId || "");
      if (leavingChannelId && uiMode === "server") {
        void api(`/channels/${leavingChannelId}/voice/left`, { method: "POST" }).catch(() => {});
      }
      playVoiceSfx("leave");
      try {
        const sess = dmActiveCallSessionRef.current || {};
        const callId = String(sess.callId || "");
        const channelId = String(sess.channelId || "");
        if (sess.state === "active" && callId && channelId && String(activeVoiceChannelId || "") === channelId) {
          api(`/dm/${channelId}/call/end`, { method: "POST", body: JSON.stringify({ callId }) }).catch(() => {});
        }
        dmActiveCallSessionRef.current = { callId: "", channelId: "", state: "" };
      } catch { /* ignore */ }
      destroyVoiceInstance();
      try {
        localStorage.removeItem("sloncord_last_voice_channel_id");
      } catch {
        // ignore
      }
      setActiveVoiceChannelId("");
      voiceNamesFetched.current.clear();
      setVoicePeerNames({});
      setVoiceState({
        connected: false,
        joining: false,
        mediaLinkReady: false,
        room: "",
        peers: 0,
        muted: false,
        deafened: false,
        remotePeerUserIds: [],
        rosterUserIds: []
      });
      setStatus("Голосовой чат отключен");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function deleteDirectConversation(channelId, deleteForPeer) {
    if (!token) return;
    clearAlerts();
    try {
      const id = String(channelId || "");
      if (!id) return;

      await api(`/dm/${id}/delete`, {
        method: "POST",
        body: JSON.stringify({ deleteForPeer: !!deleteForPeer })
      });

      if (String(activeVoiceChannelId) === id) {
        leaveVoice();
      }

      const list = (await api("/dm/channels", { method: "GET" })) || [];
      setDmChannels(list);

      const stillThere = list.some((c) => String(c.id) === String(selectedChannelId));
      if (!stillThere) {
        if (list[0]?.id) {
          selectTextChannel(list[0].id);
        } else {
          setSelectedChannelId("");
          setMessages([]);
          setMembers([]);
        }
      }

      setStatus("Переписка удалена");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function onVoiceChannelRowClick(voiceId) {
    if (voiceState.joining) {
      return;
    }
    if (String(activeVoiceChannelId) === String(voiceId) && voiceState.connected) {
      leaveVoice();
      return;
    }
    await connectVoiceToChannel(voiceId);
  }

  function toggleMic() {
    const s = voiceRef.current;
    if (!s) return;
    s.toggleMute();
  }

  function toggleDeafen() {
    const s = voiceRef.current;
    if (!s) return;
    s.toggleDeafen();
  }

  async function toggleScreenShare() {
    const s = voiceRef.current;
    if (!s) return;
    try {
      await s.toggleScreenShare();
    } catch (e) {
      const name = e && typeof e === "object" && "name" in e ? String((e).name) : "";
      if (name === "AbortError" || name === "NotAllowedError") return;
      const msg = (e && typeof e === "object" && "message" in e && (e).message) || String(e);
      if (/abort|cancel|denied|dismiss|closed|отмен/i.test(msg)) return;
      setError(msg);
    }
  }

  async function reconfigureScreenShare() {
    setScreenShareActionMenuOpen(false);
    const s = voiceRef.current;
    if (!s?.reconfigureScreenShare) return;
    try {
      await s.reconfigureScreenShare();
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function deleteChannel(channelId) {
    clearAlerts();
    try {
      if (!token) return;
      await api(`/channels/${channelId}`, { method: "DELETE" });
      if (String(selectedChannelId) === String(channelId)) {
        setSelectedChannelId("");
        setMessages([]);
        setMembers([]);
      }
      setStatus("Канал удален");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  async function leaveChannel(channelId) {
    clearAlerts();
    try {
      if (!token) return;
      await api(`/channels/${channelId}/leave`, { method: "POST" });
      if (String(selectedChannelId) === String(channelId)) {
        setSelectedChannelId("");
        setMessages([]);
        setMembers([]);
      }
      if (String(activeVoiceChannelId) === String(channelId)) {
        leaveVoice();
      }
      setStatus("Вы покинули канал");
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  function renderTextWithLinks(text) {
    if (!text) return null;
    const s = String(text);
    const re =
      /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|sloncord-app:\/\/[^\s<>()]+)/gi;
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) parts.push(s.slice(last, start));
      const raw = m[0];
      const inviteCode = parseInviteCodeFromUrl(raw);
      const href = inviteCode ? normalizeInviteUrl(raw) : (
        raw.startsWith("http")
          ? raw
          : /^sloncord-app:\/\//i.test(raw)
            ? normalizeInviteUrl(raw)
            : `https://${raw}`
      );
      let sameOrigin = false;
      if (!/^sloncord-app:\/\//i.test(href)) {
        try {
          const u = new URL(href, window.location.origin);
          sameOrigin = u.origin === window.location.origin;
        } catch {
          sameOrigin = false;
        }
      } else {
        sameOrigin = true;
      }
      const linkTarget = inviteCode || sameOrigin ? "_self" : "_blank";
      const linkRel = inviteCode || sameOrigin ? undefined : "noreferrer";
      parts.push(
        <a
          key={`lnk-${start}-${end}`}
          href={href}
          target={linkTarget}
          rel={linkRel}
          onClick={(e) => {
            if (!inviteCode || !token) return;
            try {
              e.preventDefault();
            } catch {
              /* ignore */
            }
            try {
              e.stopPropagation();
            } catch {
              /* ignore */
            }
            try {
              joinServerByInviteCodeRef.current?.(inviteCode);
            } catch {
              /* ignore */
            }
          }}
        >
          {inviteCode ? href : raw}
        </a>
      );
      last = end;
    }
    if (last < s.length) parts.push(s.slice(last));
    return <span className="msg-text">{parts}</span>;
  }

  function openScreenView(peerId) {
    const pid = String(peerId);
    const safe = pid.replace(/[^a-f0-9-]/gi, "x");
    setScreenView({ open: true, peerId: pid, mode: "full" });
    try { voiceRef.current?.setScreenAudioVolume?.(pid, 100); } catch { /* ignore */ }
    try {
      voiceRef.current?.ensurePeerFor?.(pid);
      voiceRef.current?.renegotiateAll?.();
    } catch {
      // ignore
    }

    const startedAt = Date.now();
    const timeoutMs = 8000;
    const tick = () => {
      const nativeUrl =
        typeof voiceRef.current?.getNativeScreenUrl === "function"
          ? String(voiceRef.current.getNativeScreenUrl(pid) || "")
          : "";
      if (nativeUrl) {
        const img = document.getElementById(`remote-video-${safe}`) as HTMLImageElement | null;
        const v = screenVideoRef.current;
        if (v) {
          try { v.srcObject = null; } catch { /* ignore */ }
          try { v.pause?.(); } catch { /* ignore */ }
          v.style.display = "none";
        }
        let overlayImg = document.getElementById("screen-native-img") as HTMLImageElement | null;
        if (!overlayImg && screenOverlayRef.current) {
          overlayImg = document.createElement("img");
          overlayImg.id = "screen-native-img";
          overlayImg.className = "screen-video";
          overlayImg.alt = "";
          screenOverlayRef.current.querySelector(".screen-surface")?.prepend(overlayImg);
        }
        if (overlayImg) {
          overlayImg.src = nativeUrl;
          overlayImg.style.display = "block";
        }
        if (img) img.src = nativeUrl;
        return;
      }
      const el = document.getElementById(`remote-video-${safe}`);
      const stream = el?.srcObject;
      const v = screenVideoRef.current;
      if (stream && v) {
        v.style.display = "block";
        v.srcObject = stream;
        v.play?.().catch(() => {});
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        setError("Демонстрация пока не доступна (нет видеопотока).");
        return;
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 0);
  }

  function refreshScreenViewStreamForPeer(peerId) {
    const pid = String(peerId || "");
    if (!pid) return;
    const safe = pid.replace(/[^a-f0-9-]/gi, "x");
    // If viewer is open for this peer, re-attach the current remote video stream.
    setScreenView((sv) => {
      if (!sv.open || String(sv.peerId) !== pid) return sv;
      try {
        const v = screenVideoRef.current;
        if (v) v.srcObject = null;
      } catch { /* ignore */ }
      return sv;
    });
    const startedAt = Date.now();
    const timeoutMs = 8000;
    const tick = () => {
      const el = document.getElementById(`remote-video-${safe}`);
      const stream = el?.srcObject;
      const v = screenVideoRef.current;
      if (stream && v) {
        v.srcObject = stream;
        v.play?.().catch(() => {});
        return;
      }
      if (Date.now() - startedAt > timeoutMs) return;
      setTimeout(tick, 250);
    };
    setTimeout(tick, 0);
  }

  function detachScreenViewForPeer(peerId) {
    const pid = String(peerId || "");
    if (!pid) return;
    setScreenView((sv) => {
      if (!sv.open || String(sv.peerId) !== pid) return sv;
      const v = screenVideoRef.current;
      if (v) {
        try { v.pause?.(); } catch { /* ignore */ }
        try { v.srcObject = null; } catch { /* ignore */ }
      }
      return sv; // keep overlay open; stream will be reattached on new producer
    });
  }

  function closeScreenView() {
    // Stop hearing screen audio when closing the viewer (Discord-like).
    try { voiceRef.current?.setScreenAudioVolume?.(String(screenView.peerId || ""), 0); } catch { /* ignore */ }
    // Always exit fullscreen on close (DOM fullscreen OR desktop window fullscreen fallback).
    try { void exitScreenFullscreen(); } catch { /* ignore */ }
    try {
      const fsEl = document.fullscreenElement;
      if (fsEl) {
        const x =
          document.exitFullscreen?.bind(document) ||
          document.webkitExitFullscreen?.bind(document) ||
          document.mozCancelFullScreen?.bind(document) ||
          document.msExitFullscreen?.bind(document);
        if (x) void Promise.resolve(x()).catch(() => {});
      }
    } catch { /* ignore */ }
    setScreenView({ open: false, peerId: "", mode: "full" });
    const v = screenVideoRef.current;
    if (v) {
      try {
        v.pause?.();
      } catch {
        // ignore
      }
      try {
        v.srcObject = null;
      } catch {
        // ignore
      }
    }
  }

  /** Remote screen share ended or producer closed — close overlay for viewers watching this peer (web + Electron). */
  function closeScreenViewForPeer(targetPeerId) {
    const tid = String(targetPeerId || "");
    if (!tid) return;
    setScreenView((sv) => {
      if (!sv.open || String(sv.peerId) !== tid) return sv;
      try {
        voiceRef.current?.setScreenAudioVolume?.(tid, 0);
      } catch {
        /* ignore */
      }
      // Ensure fullscreen is cleared even if the sharer stopped unexpectedly.
      try { void exitScreenFullscreen(); } catch { /* ignore */ }
      try {
        const fsEl = document.fullscreenElement;
        if (fsEl) {
          const x =
            document.exitFullscreen?.bind(document) ||
            document.webkitExitFullscreen?.bind(document) ||
            document.mozCancelFullScreen?.bind(document) ||
            document.msExitFullscreen?.bind(document);
          if (x) void Promise.resolve(x()).catch(() => {});
        }
      } catch {
        /* ignore */
      }
      const v = screenVideoRef.current;
      if (v) {
        try {
          v.pause?.();
        } catch {
          /* ignore */
        }
        try {
          v.srcObject = null;
        } catch {
          /* ignore */
        }
      }
      return { open: false, peerId: "", mode: "full" };
    });
  }

  function toggleScreenViewMode() {
    // If currently in native fullscreen, exit before switching to window mode.
    setScreenView((prev) => {
      const nextMode = prev.mode === "full" ? "window" : "full";
      if (nextMode === "window") {
        try {
          if (screenWindowFsFallbackRef.current) {
            void window.sloncord?.setWindowFullscreen?.(false).then((r) => {
              if (r?.ok) screenWindowFsFallbackRef.current = false;
            }).catch(() => {});
          }
        } catch { /* ignore */ }
        try { if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {}); } catch { /* ignore */ }
      }
      return { ...prev, mode: nextMode };
    });
  }

  function clearScreenControlsTimer() {
    const t = screenControlsHideTimerRef.current;
    if (t) {
      try { clearTimeout(t); } catch { /* ignore */ }
      screenControlsHideTimerRef.current = null;
    }
  }

  function scheduleHideScreenControls() {
    clearScreenControlsTimer();
    if (!screenView.open) return;
    screenControlsHideTimerRef.current = setTimeout(() => {
      setScreenControlsVisible(false);
    }, 4000);
  }

  function showScreenControlsAndSchedule() {
    setScreenControlsVisible(true);
    scheduleHideScreenControls();
  }

  function requestScreenFullscreen() {
    try {
      const el = screenOverlayRef.current || screenVideoRef.current;
      if (!el) return;
      const req =
        el.requestFullscreen?.bind(el) ||
        el.webkitRequestFullscreen?.bind(el) ||
        el.mozRequestFullScreen?.bind(el) ||
        el.msRequestFullscreen?.bind(el);
      if (!req) return;
      void Promise.resolve(req()).catch(() => {});
    } catch { /* ignore */ }
  }

  async function toggleMediaLightboxFullscreen() {
    try {
      if (mediaLightboxWindowFsFallbackRef.current) {
        const r = await window.sloncord?.setWindowFullscreen?.(false);
        if (r?.ok) mediaLightboxWindowFsFallbackRef.current = false;
        return;
      }

      const vid = mediaLightboxVideoRef.current;
      const inner = mediaLightboxInnerRef.current;
      const fsEl =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        /** @type {Document & { mozFullScreenElement?: Element | null }} */ (document).mozFullScreenElement ||
        /** @type {Document & { msFullscreenElement?: Element | null }} */ (document).msFullscreenElement;

      if (fsEl) {
        const x =
          document.exitFullscreen?.bind(document) ||
          document.webkitExitFullscreen?.bind(document) ||
          document.mozCancelFullScreen?.bind(document) ||
          document.msExitFullscreen?.bind(document);
        if (x) await Promise.resolve(x()).catch(() => {});
        return;
      }

      const target = vid || inner;
      if (!target) return;

      const t = /** @type {HTMLElement & { webkitRequestFullscreen?: () => void; msRequestFullscreen?: () => void; mozRequestFullScreen?: () => void }} */ (target);
      try {
        if (typeof t.requestFullscreen === "function") {
          await Promise.resolve(t.requestFullscreen({ navigationUI: "hide" }));
          return;
        }
        if (typeof t.webkitRequestFullscreen === "function") {
          t.webkitRequestFullscreen();
          return;
        }
        if (typeof t.mozRequestFullScreen === "function") {
          t.mozRequestFullScreen();
          return;
        }
        if (typeof t.msRequestFullscreen === "function") {
          t.msRequestFullscreen();
          return;
        }
      } catch {
        /* fall through to window fallback */
      }

      const wr = await window.sloncord?.setWindowFullscreen?.(true);
      if (wr?.ok) mediaLightboxWindowFsFallbackRef.current = true;
    } catch {
      /* ignore */
    }
  }

  async function exitFullscreenBeforeCloseLightbox() {
    try {
      if (mediaLightboxWindowFsFallbackRef.current) {
        await window.sloncord?.setWindowFullscreen?.(false);
        mediaLightboxWindowFsFallbackRef.current = false;
        return;
      }
      const fsEl =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        /** @type {Document & { mozFullScreenElement?: Element | null }} */ (document).mozFullScreenElement ||
        /** @type {Document & { msFullscreenElement?: Element | null }} */ (document).msFullscreenElement;
      if (!fsEl) return;
      const x =
        document.exitFullscreen?.bind(document) ||
        document.webkitExitFullscreen?.bind(document) ||
        document.mozCancelFullScreen?.bind(document) ||
        document.msExitFullscreen?.bind(document);
      if (x) await Promise.resolve(x()).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async function exitScreenFullscreen() {
    try {
      if (screenWindowFsFallbackRef.current) {
        const r = await window.sloncord?.setWindowFullscreen?.(false);
        if (r?.ok) screenWindowFsFallbackRef.current = false;
        setScreenIsFullscreen(false);
        return;
      }
    } catch { /* ignore */ }
    try {
      const fsEl = document.fullscreenElement;
      if (!fsEl) return;
      const x =
        document.exitFullscreen?.bind(document) ||
        document.webkitExitFullscreen?.bind(document) ||
        document.mozCancelFullScreen?.bind(document) ||
        document.msExitFullscreen?.bind(document);
      if (x) void Promise.resolve(x()).catch(() => {});
    } catch { /* ignore */ }
  }

  async function toggleNativeFullscreen() {
    if (screenIsFullscreen) {
      await exitScreenFullscreen();
      return;
    }
    // Prefer monitor fullscreen in desktop app.
    try {
      if (typeof window.sloncord?.setWindowFullscreen === "function") {
        if (screenView.mode !== "full") {
          flushSync(() => setScreenView((p) => ({ ...p, mode: "full" })));
        }
        const r = await window.sloncord.setWindowFullscreen(true);
        if (r?.ok) {
          screenWindowFsFallbackRef.current = true;
          setScreenIsFullscreen(true);
          return;
        }
      }
    } catch { /* ignore */ }
    // Fallback to DOM fullscreen (web).
    try {
      if (screenView.mode !== "full") {
        flushSync(() => setScreenView((p) => ({ ...p, mode: "full" })));
      }
      requestScreenFullscreen();
    } catch {
      requestScreenFullscreen();
    }
  }

  useEffect(() => {
    const onFs = () => {
      try {
        setScreenIsFullscreen(!!document.fullscreenElement);
      } catch {
        setScreenIsFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", onFs);
    onFs();
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    // Desktop: keep fullscreen state in sync with BrowserWindow fullscreen.
    try {
      const unsub = window.sloncord?.onWindowStateChanged?.((s) => {
        if (!s) return;
        if (s.fullscreen) {
          screenWindowFsFallbackRef.current = true;
          setScreenIsFullscreen(true);
        } else if (screenWindowFsFallbackRef.current) {
          screenWindowFsFallbackRef.current = false;
          setScreenIsFullscreen(false);
        }
      });
      return () => { try { if (typeof unsub === "function") unsub(); } catch { /* ignore */ } };
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    // Controls: visible by default on open; auto-hide only in full mode.
    clearScreenControlsTimer();
    if (!screenView.open) {
      setScreenControlsVisible(true);
      return;
    }
    if (screenView.mode !== "full") {
      setScreenControlsVisible(true);
      return;
    }
    setScreenControlsVisible(true);
    scheduleHideScreenControls();
    return () => clearScreenControlsTimer();
  }, [screenView.open, screenView.mode]);

  useEffect(() => {
    // iOS Safari/PWA: viewport changes (keyboard, pinch, rotation) can hide controls or shift taps.
    // Make controls reappear on visualViewport changes while the screen overlay is open.
    if (!screenView.open) return undefined;
    const vv = window.visualViewport;
    let raf = 0;
    const onVv = () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      raf = requestAnimationFrame(() => showScreenControlsAndSchedule());
    };
    try { vv?.addEventListener?.("resize", onVv, { passive: true }); } catch { /* ignore */ }
    try { vv?.addEventListener?.("scroll", onVv, { passive: true }); } catch { /* ignore */ }
    window.addEventListener("orientationchange", onVv, { passive: true });
    return () => {
      try { cancelAnimationFrame(raf); } catch { /* ignore */ }
      try { vv?.removeEventListener?.("resize", onVv); } catch { /* ignore */ }
      try { vv?.removeEventListener?.("scroll", onVv); } catch { /* ignore */ }
      try { window.removeEventListener("orientationchange", onVv); } catch { /* ignore */ }
    };
  }, [screenView.open]);

  useEffect(() => {
    if (!screenView.open) return;
    // Init window mode position (bottom-right) once per open.
    if (screenView.mode === "window" && !screenWindowPos.inited) {
      const w = 520;
      const h = 320;
      const pad = 16;
      const x = Math.max(pad, (window.innerWidth || 0) - w - pad);
      const y = Math.max(pad, (window.innerHeight || 0) - h - pad);
      setScreenWindowPos({ x, y, inited: true });
    }
  }, [screenView.open, screenView.mode, screenWindowPos.inited]);

  useEffect(() => {
    // Final safety net: if the stream track ends / disappears while overlay is open, close it.
    if (!screenView.open) return undefined;
    const pid = String(screenView.peerId || "");
    if (!pid) return undefined;
    let stoppedAt = 0;
    const t = setInterval(() => {
      try {
        if (!screenView.open) return;
        const v = screenVideoRef.current;
        const s = v?.srcObject as MediaStream | null;
        const vt = s?.getVideoTracks?.()?.[0] || null;
        const ended = !vt || vt.readyState === "ended";
        if (ended) {
          if (!stoppedAt) stoppedAt = Date.now();
          if (Date.now() - stoppedAt > 900) {
            closeScreenViewForPeer(pid);
          }
        } else {
          stoppedAt = 0;
        }
      } catch {
        /* ignore */
      }
    }, 450);
    return () => {
      try { clearInterval(t); } catch { /* ignore */ }
    };
  }, [screenView.open, screenView.peerId]);

  function clampScreenWindow(x, y) {
    const w = 520;
    const h = 320;
    const pad = 8;
    const maxX = Math.max(pad, (window.innerWidth || 0) - w - pad);
    const maxY = Math.max(pad, (window.innerHeight || 0) - h - pad);
    return { x: Math.max(pad, Math.min(maxX, x)), y: Math.max(pad, Math.min(maxY, y)) };
  }

  function onScreenDragStart(e) {
    if (screenView.mode !== "window") return;
    try { e.preventDefault(); } catch { /* ignore */ }
    const pid = e.pointerId || 1;
    screenDragRef.current = {
      active: true,
      startX: e.clientX || 0,
      startY: e.clientY || 0,
      baseX: Number(screenWindowPos.x) || 0,
      baseY: Number(screenWindowPos.y) || 0,
      pointerId: pid
    };
    try { e.currentTarget.setPointerCapture?.(pid); } catch { /* ignore */ }
  }

  function onScreenDragMove(e) {
    if (screenView.mode !== "window") return;
    if (!screenDragRef.current.active) return;
    if ((e.pointerId || 1) !== screenDragRef.current.pointerId) return;
    const dx = (e.clientX || 0) - screenDragRef.current.startX;
    const dy = (e.clientY || 0) - screenDragRef.current.startY;
    const next = clampScreenWindow(screenDragRef.current.baseX + dx, screenDragRef.current.baseY + dy);
    setScreenWindowPos((p) => ({ ...p, ...next, inited: true }));
  }

  function onScreenDragEnd(e) {
    if ((e.pointerId || 1) !== screenDragRef.current.pointerId) return;
    screenDragRef.current.active = false;
    try { e.currentTarget.releasePointerCapture?.(screenDragRef.current.pointerId); } catch { /* ignore */ }
  }

  async function createCategory(nameOverride) {
    clearAlerts();
    const name = String(nameOverride ?? newCategoryName ?? "").trim();
    if (!name || !selectedServerId) return;
    try {
      await api(`/servers/${selectedServerId}/categories`, {
        method: "POST",
        body: JSON.stringify({ name, isPrivate: !!newCategoryPrivate }),
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setNewCategoryName("");
      setNewCategoryPrivate(false);
      setShowCreateCategory(false);
      setStatus("Категория создана");
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function saveRenameCategory() {
    clearAlerts();
    try {
      const id = String(renameCategoryForm.id || "");
      const name = (renameCategoryForm.name || "").trim();
      if (!id || !name) return;
      await api(`/categories/${id}/meta`, { method: "PUT", body: JSON.stringify({ name }) });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setShowRenameCategory(false);
      setStatus("Категория обновлена");
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  async function deleteCategory(categoryId) {
    clearAlerts();
    const id = String(categoryId || "");
    if (!id) return;
    try {
      await api(`/categories/${id}`, { method: "DELETE" });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setStatus("Категория удалена");
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  function confirmDeleteCategory(cat) {
    if (!cat?.id) return;
    askConfirm(
      {
        title: "Удалить категорию",
        message: `Удалить категорию «${cat.name || ""}»? Каналы останутся без категории.`,
        confirmText: "Удалить",
      },
      async () => deleteCategory(cat.id)
    );
  }

  function closeChannelsContextMenu() {
    setChannelsContextMenu({ open: false, x: 0, y: 0 });
  }

  function openChannelsContextMenu(ev) {
    if (uiMode !== "server") return;
    if (!canModerateServerUser(selectedServer, profile?.id)) return;
    const t = ev?.target;
    if (!t || typeof t.closest !== "function") return;
    if (!t.closest(".channels")) return;
    if (t.closest(".voice-connection-panel")) return;
    if (t.closest(".channel-item, .channel-voice-group, .voice-members-inline, .voice-member-name, .voice-member-avatar, .channel-category-header, .server-top, button, a, input, textarea, select, label")) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    setChannelMenu({ openForId: "", x: 0, y: 0 });
    setChannelsContextMenu({
      open: true,
      x: Math.round(Number(ev.clientX) || 0),
      y: Math.round(Number(ev.clientY) || 0),
    });
  }

  function openCategoryMenu(catId, ev) {
    ev.preventDefault();
    ev.stopPropagation();
    closeChannelsContextMenu();
    const rect = ev.currentTarget?.getBoundingClientRect?.();
    const menuId = `cat:${String(catId || "")}`;
    const nextOpen = String(channelMenu?.openForId || "") === menuId ? "" : menuId;
    setChannelMenu({
      openForId: nextOpen,
      x: Math.round(Number(rect?.left ?? rect?.right ?? 0)),
      y: Math.round(Number(rect?.bottom ?? 0)),
    });
  }

  async function persistServerLayout(layoutChannels, layoutCategories) {
    if (!selectedServerId || !canModerateServerUser(selectedServer, profile?.id)) return;
    try {
      await api(`/servers/${selectedServerId}/layout`, {
        method: "PUT",
        body: JSON.stringify({
          channels: layoutChannels,
          categories: layoutCategories,
        }),
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  function dropLineMatches(line, target) {
    if (!line || !target) return false;
    return (
      String(line.type) === String(target.type)
      && String(line.id ?? "") === String(target.id ?? "")
      && String(line.pos ?? "before") === String(target.pos ?? "before")
    );
  }

  function isValidLayoutDropTarget(drag, target) {
    if (!drag || !target) return false;
    if (drag.type === "category") {
      if (target.type !== "category") return false;
      const dragId = String(drag.id ?? "");
      const targetId = String(target.id ?? "");
      if (dragId && dragId === targetId && String(target.pos ?? "before") === "before") return false;
      return true;
    }
    if (drag.type === "channel") {
      return target.type === "category" || target.type === "channel";
    }
    return false;
  }

  function endChannelDrag() {
    channelDragRef.current = null;
    setChannelDropLine(null);
  }

  function beginChannelDrag(item, ev) {
    if (!canModerateServerUser(selectedServer, profile?.id)) return;
    channelDragRef.current = item;
    setChannelDropLine(null);
    try { ev.dataTransfer.setData("application/x-sloncord-channel", JSON.stringify(item)); } catch { /* ignore */ }
    try { ev.dataTransfer.effectAllowed = "move"; } catch { /* ignore */ }
  }

  function resolveChannelDropTarget(target, ev) {
    if (!target || target.type !== "channel" || !ev?.currentTarget) return target;
    try {
      const rect = ev.currentTarget.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      return { ...target, pos: ev.clientY < mid ? "before" : "after" };
    } catch {
      return target;
    }
  }

  function channelDropTargetFromLine(fallback) {
    const line = channelDropLine;
    if (!line || String(line.type) !== String(fallback.type)) return fallback;
    if (line.type === "channel" && String(line.id) === String(fallback.id)) return line;
    if (line.type === "category" && String(line.id ?? "") === String(fallback.id ?? "")
      && String(line.pos ?? "before") === String(fallback.pos ?? "before")) {
      return line;
    }
    return fallback;
  }

  function handleChannelDragOver(target, ev) {
    const drag = channelDragRef.current;
    if (!drag) return;
    const resolved = resolveChannelDropTarget(target, ev);
    if (!isValidLayoutDropTarget(drag, resolved)) {
      // Keep the last valid drop line: temporary invalid targets (e.g. overlap/forbidden cursor)
      // shouldn't make the indicator jump/flicker.
      return;
    }
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
    setChannelDropLine(resolved);
  }

  async function handleChannelDrop(target) {
    const drag = channelDragRef.current;
    channelDragRef.current = null;
    setChannelDropLine(null);
    if (!drag || !selectedServer || !target) return;
    if (!canModerateServerUser(selectedServer, profile?.id)) return;

    const all = Array.isArray(selectedServer.channels) ? selectedServer.channels.slice() : [];
    const cats = Array.isArray(selectedServer.categories) ? selectedServer.categories.slice() : [];

    if (drag.type === "category" && target.type === "category") {
      const ordered = cats.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
      const from = ordered.findIndex((c) => String(c.id) === String(drag.id));
      if (from < 0) return;

      const targetId = String(target.id ?? "");
      let insertAt;
      if (targetId === "__top__") {
        insertAt = 0;
      } else if (targetId === "__bottom__") {
        insertAt = ordered.length;
      } else {
        const anchor = ordered.findIndex((c) => String(c.id) === targetId);
        if (anchor < 0) return;
        insertAt = target.pos === "after" ? anchor + 1 : anchor;
      }

      const [moved] = ordered.splice(from, 1);
      if (from < insertAt) insertAt -= 1;
      if (insertAt < 0) insertAt = 0;
      if (insertAt > ordered.length) insertAt = ordered.length;
      if (ordered.some((c, i) => String(c.id) === String(moved.id) && i === insertAt)) return;

      ordered.splice(insertAt, 0, moved);
      const layoutCategories = ordered.map((c, i) => ({ id: String(c.id), position: i }));
      await persistServerLayout(null, layoutCategories);
      return;
    }

    if (drag.type !== "channel") return;

    const moved = all.find((c) => String(c.id) === String(drag.id));
    if (!moved) return;

    const targetCategoryId = target.type === "category"
      ? String(target.id ?? "")
      : String(target.categoryId ?? drag.categoryId ?? "");

    let bucket = all
      .filter((c) => String(c.categoryId || "") === targetCategoryId && String(c.id) !== String(drag.id))
      .sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));

    if (target.type === "category") {
      if (String(target.pos) === "after") {
        bucket = [...bucket, moved];
      } else {
        bucket = [moved, ...bucket];
      }
    } else if (target.type === "channel") {
      const anchorIdx = bucket.findIndex((c) => String(c.id) === String(target.id));
      if (anchorIdx < 0) {
        bucket.push(moved);
      } else {
        const insertAt = target.pos === "after" ? anchorIdx + 1 : anchorIdx;
        bucket.splice(insertAt, 0, moved);
      }
    } else {
      return;
    }

    const layoutChannels = [];
    for (const c of all) {
      if (String(c.id) === String(drag.id)) continue;
      if (String(c.categoryId || "") === targetCategoryId) continue;
      layoutChannels.push({
        id: String(c.id),
        position: Number(c.position) || 0,
        categoryId: c.categoryId ? String(c.categoryId) : null,
      });
    }
    bucket.forEach((c, i) => {
      layoutChannels.push({
        id: String(c.id),
        position: i,
        categoryId: targetCategoryId || null,
      });
    });
    await persistServerLayout(layoutChannels, null);
  }

  function beginVoiceUserDrag(userId, sourceChannelId, ev) {
    if (!canModerateServerUser(selectedServer, profile?.id)) return;
    const uid = String(userId || "");
    const src = String(sourceChannelId || "");
    if (!uid || !src) return;
    if (uid === String(profile?.id || "")) return;
    voiceUserDragRef.current = { type: "voice-user", userId: uid, sourceChannelId: src };
    try {
      ev.dataTransfer.setData("application/x-sloncord-voice-user", JSON.stringify(voiceUserDragRef.current));
      ev.dataTransfer.effectAllowed = "move";
    } catch {
      /* ignore */
    }
  }

  function handleVoiceUserDragOver(channelId, ev) {
    if (!voiceUserDragRef.current) return;
    if (String(voiceUserDragRef.current.sourceChannelId) === String(channelId)) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = "move"; } catch { /* ignore */ }
    setVoiceUserDropTarget({ channelId: String(channelId) });
  }

  async function handleVoiceUserDrop(targetChannelId) {
    const drag = voiceUserDragRef.current;
    voiceUserDragRef.current = null;
    setVoiceUserDropTarget(null);
    if (!drag || drag.type !== "voice-user" || !selectedServer?.id) return;
    const uid = String(drag.userId || "");
    const src = String(drag.sourceChannelId || "");
    const dst = String(targetChannelId || "");
    if (!uid || !dst || src === dst) return;
    try {
      await api(`/servers/${selectedServer.id}/members/${uid}/move-voice`, {
        method: "POST",
        body: JSON.stringify({ channelId: dst }),
      });
      setStatus("Участник перемещён");
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  function openCreateTextInCategory(categoryId) {
    setPendingChannelCategoryId(String(categoryId || ""));
    setShowCreateTextChannel(true);
  }

  function openCreateVoiceInCategory(categoryId) {
    setPendingChannelCategoryId(String(categoryId || ""));
    setShowCreateVoiceChannel(true);
  }

  function renderServerCategoryChannels(catChannels, dragCategoryId) {
    const dragId = dragCategoryId != null ? String(dragCategoryId) : "";
    const canMod = canModerateServerUser(selectedServer, profile?.id);
    const visible = (catChannels || []).filter((ch) => shouldShowChannelInCollapsedCategory(ch, dragId));
    return visible.map((channel) => {
      if (channel.kind === "voice") {
        return (
          <VoiceChannelSidebarItem
            key={channel.id}
            channel={channel}
            dragCategoryId={dragId}
            showPrivateIcon={channelShowsPrivate(channel, dragId)}
            activeVoiceChannelId={activeVoiceChannelId}
            voiceConnected={voiceState.connected}
            voiceJoining={voiceState.joining}
            voiceState={voiceState}
            voicePresenceByChannelId={voicePresenceByChannelId}
            profile={profile}
            userAvatarUrlByUserId={userAvatarUrlByUserId}
            voicePeerNames={voicePeerNames}
            canManage={canManageServerChannel(channel, selectedServer, profile?.id)}
            canModerate={canMod}
            canDragUsers={canMod}
            channelDropLine={channelDropLine}
            voiceUserDropTarget={voiceUserDropTarget}
            onBeginDrag={beginChannelDrag}
            onDragEnd={endChannelDrag}
            onDragOver={handleChannelDragOver}
            onDrop={handleChannelDrop}
            dropChannel={(target) => { void handleChannelDrop(channelDropTargetFromLine(target)); }}
            onBeginUserDrag={beginVoiceUserDrag}
            onUserDragOver={handleVoiceUserDragOver}
            onUserDrop={handleVoiceUserDrop}
            onRowClick={onVoiceChannelRowClick}
            voiceChannelTimerVisible={voiceChannelTimerVisible}
            formatCallDuration={formatCallDuration}
            mergeScreenShareUserIds={mergeScreenShareUserIds}
            isUserSpeakingInVoice={isUserSpeakingInVoice}
            openUserCard={openUserCard}
            openScreenView={openScreenView}
            setChannelMenu={setChannelMenu}
            channelMenuOpenForId={channelMenu?.openForId}
          />
        );
      }
      const channelId = String(channel.id);
      const showDropBefore =
        channelDropLine?.type === "channel" &&
        String(channelDropLine.id) === channelId &&
        channelDropLine.pos === "before";
      const showDropAfter =
        channelDropLine?.type === "channel" &&
        String(channelDropLine.id) === channelId &&
        channelDropLine.pos === "after";
      return (
        <div key={channelId}>
          {showDropBefore && <div className="channel-drop-line" />}
          <div
            className={`channel-item ${selectedChannelId === channel.id ? "active" : ""} ${Number(channel.unreadCount) > 0 ? "channel-item--unread" : ""}`}
            draggable={canMod}
            onDragStart={(e) => beginChannelDrag({ type: "channel", id: channelId, categoryId: dragId }, e)}
            onDragEnd={endChannelDrag}
            onDragOver={(e) => {
              // Prevent parent .channels-list handler from overriding nearest channel target.
              try { e.stopPropagation(); } catch { /* ignore */ }
              handleChannelDragOver({ type: "channel", id: channelId, categoryId: dragId, pos: "before" }, e);
            }}
            onDrop={() => {
              void handleChannelDrop(channelDropTargetFromLine({ type: "channel", id: channelId, categoryId: dragId, pos: "before" }));
            }}
            onClick={() => selectTextChannel(channel.id, "server")}
          >
            <span className="chan-name" title={channel.name}>
              # {channel.name}
              {channelShowsPrivate(channel, dragId) && <SlonIcon name="lock" size={13} className="slon-icon--inline-end" />}
            </span>
            <span className="channel-item-spacer" />
            {Number(channel.unreadCount) > 0 && (
              <span className="unread-badge">{Number(channel.unreadCount) > 99 ? "99+" : channel.unreadCount}</span>
            )}
            {canManageServerChannel(channel, selectedServer, profile?.id) && (
              <button
                type="button"
                className="icon-btn channel-actions__more"
                title="Действия"
                aria-label="Действия"
                onMouseDown={(e) => { try { e.stopPropagation(); } catch { /* ignore */ } }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget?.getBoundingClientRect?.();
                  const nextOpen = String(channelMenu?.openForId || "") === channelId ? "" : channelId;
                  setChannelMenu({
                    openForId: nextOpen,
                    x: Math.round(Number(rect?.left ?? rect?.right ?? 0)),
                    y: Math.round(Number(rect?.bottom ?? 0)),
                  });
                }}
              >
                <SlonIcon name="dots" size={18} />
              </button>
            )}
          </div>
          {showDropAfter && <div className="channel-drop-line" />}
        </div>
      );
    });
  }

  function renderCategoryChannelsListTailDropZone(catId, canMod) {
    if (!canMod) return null;
    const tailTarget = { type: "category", id: catId, pos: "after" };
    return (
      <div
        className="channel-list-drop-zone channel-list-drop-zone--bottom"
        onDragOver={(e) => handleChannelDragOver(tailTarget, e)}
        onDrop={() => { void handleChannelDrop(channelDropTargetFromLine(tailTarget)); }}
      >
        {dropLineMatches(channelDropLine, tailTarget) && <div className="channel-drop-line" />}
      </div>
    );
  }

  function renderServerCategoryBlock(cat, catChannels, opts = {}) {
    const virtual = !!opts.virtual;
    const catId = virtual ? "" : String(cat.id);
    const blockKey = virtual ? "__uncategorized__" : catId;
    const canMod = canModerateServerUser(selectedServer, profile?.id);
    const collapsed = !virtual && isCategoryCollapsed(catId);
    return (
      <div key={blockKey} className={`channel-category-block${collapsed ? " channel-category-block--collapsed" : ""}`}>
        <div
          className="panel-header panel-header-row channel-category-header"
          draggable={!virtual && canMod}
          onDragStart={!virtual && canMod ? (e) => beginChannelDrag({ type: "category", id: catId }, e) : undefined}
          onDragEnd={!virtual && canMod ? endChannelDrag : undefined}
          onDragOver={!virtual && canMod ? (e) => {
            const drag = channelDragRef.current;
            if (!drag) return;
            if (drag.type === "category") {
              handleChannelDragOver({ type: "category", id: catId, pos: "before" }, e);
            } else if (drag.type === "channel") {
              handleChannelDragOver({ type: "category", id: catId, pos: "before" }, e);
            }
          } : undefined}
          onDrop={!virtual && canMod ? () => { void handleChannelDrop({ type: "category", id: catId, pos: "before" }); } : undefined}
        >
          {!virtual && (
            <button
              type="button"
              className={`channel-category-collapse-btn${collapsed ? " is-collapsed" : ""}`}
              title={collapsed ? "Развернуть категорию" : "Свернуть категорию"}
              aria-label={collapsed ? "Развернуть категорию" : "Свернуть категорию"}
              aria-expanded={!collapsed}
              onMouseDown={(e) => { try { e.stopPropagation(); } catch { /* ignore */ } }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleCategoryCollapsed(catId);
              }}
            >
              <SlonIcon name={collapsed ? "chevron-right" : "chevron-down"} size={11} />
            </button>
          )}
          <span className="channel-category-title">
            {cat.name}
            {cat.isPrivate && <SlonIcon name="lock" size={11} className="slon-icon--inline-end" />}
          </span>
          {canMod && (
            <button
              type="button"
              className="icon-btn channel-actions__more channel-category-actions__more"
              title="Действия"
              aria-label="Действия с категорией"
              onMouseDown={(e) => { try { e.stopPropagation(); } catch { /* ignore */ } }}
              onClick={(e) => openCategoryMenu(catId, e)}
            >
              <SlonIcon name="dots" size={18} />
            </button>
          )}
        </div>
        {!virtual && dropLineMatches(channelDropLine, { type: "category", id: catId, pos: "before" }) && (
          <div className="channel-drop-line" />
        )}
        <div
          className="channels-list"
          onDragOver={canMod ? (e) => {
            const drag = channelDragRef.current;
            if (!drag) return;
            // If we're over a specific channel row, let that row decide the nearest target.
            try {
              if (e.target !== e.currentTarget && (e.target as any)?.closest?.(".channel-item")) return;
            } catch { /* ignore */ }
            if (drag.type === "category") {
              e.preventDefault();
              if (channelDropLine) setChannelDropLine(null);
              return;
            }
            if (drag.type === "channel") {
              handleChannelDragOver({ type: "category", id: catId, pos: "after" }, e);
            }
          } : undefined}
          onDragLeave={canMod ? (e) => {
            // Clear indicator only when leaving the list entirely (not when moving between children).
            try {
              const rel = (e as any).relatedTarget as any;
              if (rel && e.currentTarget && (e.currentTarget as any).contains?.(rel)) return;
            } catch { /* ignore */ }
            if (channelDragRef.current) setChannelDropLine(null);
          } : undefined}
          onDrop={canMod ? () => {
            void handleChannelDrop(channelDropTargetFromLine({ type: "category", id: catId, pos: "after" }));
          } : undefined}
        >
          {renderServerCategoryChannels(catChannels, catId)}
          {renderCategoryChannelsListTailDropZone(catId, canMod)}
        </div>
      </div>
    );
  }

  function openUserCard(userId, ev, options = {}) {
    const id = String(userId || "");
    if (!id) return;
    const showVolume = options.showVolume === true;
    setUserCardDmDraft("");
    try {
      const ax = Number(ev?.clientX ?? window.innerWidth / 2);
      const ay = Number(ev?.clientY ?? window.innerHeight / 2);
      const { x, y } = clampUserVolumeCardPosition(ax, ay, 250, showVolume ? 340 : 280);
      setUserVolumePopup({ open: true, userId: id, x, y, anchorX: ax, anchorY: ay, showVolume });
    } catch {
      const ax = window.innerWidth / 2;
      const ay = window.innerHeight / 2;
      const { x, y } = clampUserVolumeCardPosition(ax, ay, 250, showVolume ? 340 : 280);
      setUserVolumePopup({ open: true, userId: id, x, y, anchorX: ax, anchorY: ay, showVolume });
    }
    try {
      ensureUserProfile(id).catch(() => {});
    } catch {
      // ignore
    }
  }

  async function refreshAudioDevicesAndApply() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setError("Браузер не поддерживает список устройств (enumerateDevices).");
      return;
    }
    // Ensure labels are available (some browsers require permission first).
    try {
      const now = Date.now();
      const alreadyOk = !!audioPermWarmRef.current.ok;
      const recentlyTried = audioPermWarmRef.current.tried && (now - (audioPermWarmRef.current.at || 0) < 30000);
      // Only prompt once per session (and not repeatedly when user opens settings).
      if (!alreadyOk && !recentlyTried) {
        audioPermWarmRef.current = { tried: true, ok: false, at: now };
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          try { s?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
          audioPermWarmRef.current.ok = true;
        } catch {
          // ignore (we can still list devices but labels may be empty)
        }
      }
    } catch { /* ignore */ }
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list.filter((d) => d.kind === "audioinput");
    const outputs = list.filter((d) => d.kind === "audiooutput");
    setAudioDevices({ inputs, outputs });
    try { voiceRef.current?.setInputDevice?.(audioSettings.inputDeviceId || ""); } catch { /* ignore */ }
    try { voiceRef.current?.setOutputDevice?.(audioSettings.outputDeviceId || ""); } catch { /* ignore */ }
    try { voiceRef.current?.setMicGain?.(audioSettings.micGain); } catch { /* ignore */ }
    try { voiceRef.current?.setSpeakerGain?.(audioSettings.speakerGain); } catch { /* ignore */ }
    try {
      voiceRef.current?.setAudioProcessing?.(buildVoiceProcessingOpts(audioSettings));
    } catch { /* ignore */ }
  }

  function openSettingsSheet(tab) {
    // Future-proof: we may add more tabs here later.
    setAudioSettingsOpen(true);
    refreshAudioDevicesAndApply().catch((e) => setError(e.message || String(e)));
  }

  function renderToast() {
    if (!(status || error)) return null;
    const node = (
      <div className="toast-bar" role="status" aria-live="polite">
        {status && <div className="success">{status}</div>}
        {error && <div className="danger">{error}</div>}
      </div>
    );
    try {
      const host = document.getElementById("toast-root");
      if (host) {
        return createPortal(node, host);
      }
    } catch {
      // ignore
    }
    return node;
  }

  function voiceChannelTimerVisible(presence, meId, isConnectedHere) {
    if (!presence?.startedAtUtc) return false;
    const ids = (presence.userIds || []).map((x) => String(x)).filter(Boolean);
    if (ids.length === 0) return false;
    if (isConnectedHere) return true;
    const me = String(meId || "");
    return ids.some((id) => id !== me);
  }

  function formatCallDuration(startedAtUtc, tick) {
    try {
      const t0 = Date.parse(startedAtUtc);
      if (!Number.isFinite(t0)) return "";
      const nowMs = Number(tick) || Date.now();
      const sec = Math.max(0, Math.floor((nowMs - t0) / 1000));
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const mm = String(m).padStart(2, "0");
      const ss = String(s).padStart(2, "0");
      return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss.padStart(2, "0")}`;
    } catch {
      return "";
    }
  }

  function formatLastSeen(ts) {
    try {
      const t0 = Date.parse(ts);
      if (!Number.isFinite(t0)) return "";
      const sec = Math.max(0, Math.floor((Date.now() - t0) / 1000));
      if (sec < 60) return "только что";
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min} мин назад`;
      const h = Math.floor(min / 60);
      if (h < 24) return `${h} ч назад`;
      const d = Math.floor(h / 24);
      if (d < 7) return `${d} дн назад`;
      const w = Math.floor(d / 7);
      return `${w} нед назад`;
    } catch {
      return "";
    }
  }

  function formatSystemTimestamp(ts) {
    try {
      const t0 = Date.parse(ts);
      if (!Number.isFinite(t0)) return "";
      const d = new Date(t0);
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const yyyy = String(d.getFullYear());
      const hh = String(d.getHours()).padStart(2, "0");
      const mi = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
    } catch {
      return "";
    }
  }

  function formatDayDividerLabel(ts) {
    try {
      const t0 = Date.parse(ts);
      if (!Number.isFinite(t0)) return "";
      const d = new Date(t0);
      const now = new Date();
      const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const day = startOfDay(d);
      const today = startOfDay(now);
      const yday = today - 86400000;
      if (day === today) return "сегодня";
      if (day === yday) return "вчера";
      const sameYear = d.getFullYear() === now.getFullYear();
      const fmt = new Intl.DateTimeFormat("ru-RU", sameYear
        ? { day: "numeric", month: "long" }
        : { day: "numeric", month: "long", year: "numeric" });
      return fmt.format(d);
    } catch {
      return "";
    }
  }

  const dataUi = !isNarrow ? "desktop" : mobileView;
  const openMembersSheet = () => setMembersSheet(true);
  const closeMembersSheet = () => setMembersSheet(false);
  const selectTextChannel = (channelId, modeOverride) => {
    setSelectedChannelId(channelId);
    try {
      const m = (modeOverride === "dm" || modeOverride === "server") ? modeOverride : uiModeRef.current;
      if (m === "server") localStorage.setItem("sloncord_last_channel_id", String(channelId));
      if (m === "dm") localStorage.setItem("sloncord_last_dm_id", String(channelId));
      if (m) localStorage.setItem("sloncord_last_ui_mode", String(m));
    } catch {
      // ignore
    }
    if (isNarrow) setMobileView("chat");
  };

  const connectVoiceToChannelRef = useRef(connectVoiceToChannel);
  connectVoiceToChannelRef.current = connectVoiceToChannel;
  const selectTextChannelRef = useRef(selectTextChannel);
  selectTextChannelRef.current = selectTextChannel;

  const joinServerByInviteCodeRef = useRef(async (_code: string) => {});
  joinServerByInviteCodeRef.current = async (codeRaw: string) => {
    const inviteCode = String(codeRaw || "").trim();
    if (!inviteCode) return;
    if (!token) {
      stashPendingInviteCode(inviteCode);
      return;
    }
    clearAlerts();
    try {
      const joinRes = await apiRef.current("/servers/join", {
        method: "POST",
        body: JSON.stringify({ inviteCode })
      });
      const joinedId = String(joinRes?.serverId || "").trim();
      const list = (await apiRef.current("/servers", { method: "GET" })) || [];
      setServers(list);
      setUiMode("server");
      const srv =
        (joinedId ? list.find((s) => String(s?.id) === joinedId) : null)
        || list.find((s) => String(s?.inviteCode || "") === inviteCode)
        || list[0]
        || null;
      if (srv?.id) {
        setSelectedServerId(String(srv.id));
        try { localStorage.setItem("sloncord_last_server_id", String(srv.id)); } catch { /* ignore */ }
        const firstText = (srv.channels || []).find((c) => c.kind === "public" || c.kind === "text");
        if (firstText?.id) selectTextChannelRef.current(String(firstText.id), "server");
      }
      if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
      setStatus("Вы присоединились к серверу");
    } catch (err) {
      setError(err?.message || String(err));
    }
  };

  useEffect(() => {
    if (!token) return undefined;
    const off = window.sloncord?.onCallNotifAction?.((detail) => {
      const callId = String(detail?.callId || "");
      const channelId = String(detail?.channelId || "");
      const fromUserId = String(detail?.fromUserId || "");
      const action = String(detail?.action || "");
      if (!callId || !channelId || !fromUserId) return;
      if (action !== "accept" && action !== "decline") return;
      const inc = dmCallRef.current?.incoming;
      if (!inc || String(inc.callId) !== callId) return;
      if (String(inc.channelId) !== channelId) return;
      if (String(inc.fromUserId) !== fromUserId) return;
      try {
        dmRingtoneRef.current.stopIncoming?.();
      } catch { /* ignore */ }
      dmRingtoneRef.current.stopIncoming = null;
      setDmCall((p) => ({ ...(p || {}), incoming: null }));
      if (action === "decline") {
        void apiRef.current(
          `/dm/${String(inc.channelId)}/call/respond`,
          {
            method: "POST",
            body: JSON.stringify({
              callId: String(inc.callId),
              action: "decline",
              toUserId: String(inc.fromUserId)
            })
          }
        ).catch(() => {});
        return;
      }
      void apiRef.current(
        `/dm/${String(inc.channelId)}/call/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            callId: String(inc.callId),
            action: "accept",
            toUserId: String(inc.fromUserId)
          })
        }
      ).catch(() => {});
      dmActiveCallSessionRef.current = {
        callId: String(inc.callId),
        channelId: String(inc.channelId),
        state: "active"
      };
      setUiMode("dm");
      selectTextChannelRef.current(String(inc.channelId), "dm");
      if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
      void connectVoiceToChannelRef.current(String(inc.channelId), { suppressJoinSfx: true }).catch(
        () => {}
      );
    });
    return () => {
      off?.();
    };
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const off = window.sloncord?.onOpenInvite?.((detail) => {
      const code = String(detail?.inviteCode || "").trim();
      if (!code) return;
      void joinServerByInviteCodeRef.current(code);
    });
    return () => {
      try { off?.(); } catch { /* ignore */ }
    };
  }, [token]);

  if (!token) {
    const authDownload = isWindowsClient && !isSloncordDesktop && desktopDownloadInfo && (() => {
      const p = String(desktopDownloadInfo.downloadUrl || "");
      const b = (
        String(apiBaseForDl || "")
          .replace(/\/$/, "")
          .trim() || (typeof window !== "undefined" ? window.location.origin : "")
      ).trim();
      const href = /^https?:\/\//i.test(p) ? p : (p.startsWith("/") ? `${b}${p}` : `${b}/${p}`);
      const sizeMb = (Number(desktopDownloadInfo.size) / (1024 * 1024)).toFixed(1);
      return (
        <a
          className="small-btn auth-top-download"
          href={href}
          rel="noopener noreferrer"
          title={`Windows · v${String(desktopDownloadInfo.version || "")} · ≈${sizeMb} МБ`}
        >
          Скачать
        </a>
      );
    })();
    return (
      <div className="auth-wrap">
        {authDownload}
        <div className="auth-card">
          <div className="auth-card__top">
            <h1 className="auth-title">
              <img
                alt=""
                src="/icons/sloncord.svg"
                width="28"
                height="28"
                style={{ display: "block" }}
              />
              <span>Sloncord</span>
            </h1>
          </div>
          <p className="muted">Веб-клиент в стиле Discord</p>
          <input
            placeholder="Логин"
            value={authForm.login}
            onChange={(e) => setAuthForm({ ...authForm, login: e.target.value })}
          />
          <input
            type="password"
            placeholder="Пароль"
            value={authForm.password}
            onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })}
          />
          {mode === "register" && (
            <input
              placeholder="Nickname"
              value={authForm.nickname}
              onChange={(e) => setAuthForm({ ...authForm, nickname: e.target.value })}
            />
          )}
          <div className="row">
            {mode === "login" ? (
              <>
                <button className="small-btn" onClick={login}>Войти</button>
                <button className="small-btn" onClick={() => setMode("register")}>Регистрация</button>
              </>
            ) : (
              <>
                <button className="small-btn" onClick={register}>Создать аккаунт</button>
                <button className="small-btn" onClick={() => setMode("login")}>Назад ко входу</button>
              </>
            )}
          </div>
          {status && <p className="success">{status}</p>}
          {error && <p className="danger">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className={`layout${isNarrow ? " layout--narrow" : ""}`} data-ui={dataUi}>
      <div className="layout-nav" aria-label="Навигация">
      <aside className="guilds">
        {(() => {
          const n = (dmChannels || []).reduce((acc, c) => acc + (Number(c?.unreadCount) || 0), 0);
          return (
            <div className="guild-dm-stack">
              <div
                className={`guild-icon guild-icon--dm ${uiMode === "dm" ? "active" : ""}`}
                title="Личные сообщения"
                onClick={() => {
                  setUiMode("dm");
                  if (window.matchMedia("(max-width: 900px)").matches) {
                    setSelectedChannelId("");
                    setMobileView("list");
                    closeMembersSheet();
                    return;
                  }
                  if (dmChannels[0]?.id) selectTextChannel(dmChannels[0].id, "dm");
                }}
              >
                <span className="dm-elephant" aria-hidden="true">
                  <svg viewBox="0 0 64 64" width="22" height="22" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M18 48c-4 0-7-3-7-7V28c0-9 8-16 19-16h6c11 0 19 7 19 16v6c0 5-4 9-9 9h-6c-1 0-2 1-2 2v6c0 1-1 2-2 2h-2c-1 0-2-1-2-2v-4c0-1-1-2-2-2h-5c-1 0-2 1-2 2v4c0 1-1 2-2 2h-2Z" stroke="currentColor" strokeWidth="4" strokeLinejoin="round"/>
                    <path d="M45 32c2 0 4 2 4 4s-2 4-4 4h-4" stroke="currentColor" strokeWidth="4" strokeLinecap="round"/>
                    <circle cx="24" cy="30" r="2.5" fill="currentColor"/>
                    <circle cx="36" cy="30" r="2.5" fill="currentColor"/>
                  </svg>
                </span>
                {n > 0 && (
                  <span className="guild-badge" aria-label="Непрочитанные личные сообщения">
                    {n > 99 ? "99+" : n}
                  </span>
                )}
              </div>
              {unreadDmSidebarAvatars.length > 0 && (
                <div className="guild-dm-unread-avatars" aria-label="Непрочитанные личные сообщения">
                  {unreadDmSidebarAvatars.map((item) => (
                    <button
                      key={item.channelId}
                      type="button"
                      className="guild-dm-unread-avatar"
                      title={item.nick || "Личное сообщение"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setUiMode("dm");
                        selectTextChannel(item.channelId, "dm");
                        if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
                      }}
                    >
                      <span className="guild-dm-unread-avatar__inner">
                        {item.avatarUrl ? (
                          <img alt="" src={item.avatarUrl} />
                        ) : (
                          <span className="guild-dm-unread-avatar-fallback">
                            {(item.nick.trim().slice(0, 1) || "?").toUpperCase()}
                          </span>
                        )}
                      </span>
                      {item.unreadCount > 0 && (
                        <span className="guild-badge guild-dm-unread-avatar-badge" aria-label="Непрочитанные сообщения">
                          {item.unreadCount > 99 ? "99+" : item.unreadCount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        <div className="guilds-divider" aria-hidden="true" />
        {servers.map((srv) => (
          <div
            key={srv.id}
            className={`guild-icon ${uiMode === "server" && String(selectedServerId) === String(srv.id) ? "active" : ""}`}
            title={srv.name}
            onClick={() => {
              setUiMode("server");
              setSelectedServerId(srv.id);
              try { localStorage.setItem("sloncord_last_server_id", String(srv.id)); } catch { /* ignore */ }
              // Mobile UX: open the channel list first (don't jump into a random text channel).
              if (window.matchMedia("(max-width: 900px)").matches) {
                // Important: prevent effects from treating a DM id as a server channel id.
                setSelectedChannelId("");
                setMobileView("list");
                closeMembersSheet();
                return;
              }
              const ft = (srv.channels || []).find((c) => c.kind === "public" || c.kind === "text");
              if (ft?.id) selectTextChannel(ft.id);
            }}
          >
            {serverAvatarUrlByServerId[String(srv.id)] ? (
              <img alt="" src={serverAvatarUrlByServerId[String(srv.id)]} className="guild-icon-img" />
            ) : (
              (srv.name || "?").trim().slice(0, 1).toUpperCase()
            )}
            {Number(srv.unreadCount) > 0 && (
              <span className="guild-badge" aria-label="Непрочитанные сообщения">
                {Number(srv.unreadCount) > 99 ? "99+" : srv.unreadCount}
              </span>
            )}
          </div>
        ))}
        <div
          className="guild-icon guild-icon-add"
          title="Новый сервер"
          onClick={() => {
            setUiMode("server");
            setShowCreateServer(true);
          }}
        >
              <SlonIcon name="plus" size={22} />
        </div>
      </aside>

      <aside
        className="channels"
        onContextMenu={uiMode === "server" ? openChannelsContextMenu : undefined}
      >
        {uiMode === "dm" ? (
          <div className="channels-body">
            <div className="panel-header panel-header-row">
              <span>Личные сообщения</span>
              <button
                type="button"
                className="icon-btn dm-new-chat-btn"
                title="Новый личный чат"
                aria-label="Новый личный чат"
                onClick={() => setShowNewDmModal(true)}
              >
                    <SlonIcon name="plus" size={22} />
              </button>
            </div>
            <div className="channels-list">
              {dmChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${selectedChannelId === channel.id ? "active" : ""} ${Number(channel.unreadCount) > 0 ? "channel-item--unread" : ""}`}
                  onClick={() => selectTextChannel(channel.id, "dm")}
                >
                  {(() => {
                    const ids = Array.isArray(channel.memberUserIds) ? channel.memberUserIds : [];
                    const meId = String(profile?.id || "");
                    const otherId = String(ids.map(String).find((x) => x && x !== meId) || "");
                    const url = otherId ? userAvatarUrlByUserId[otherId] : "";
                    const nick = String(channel.name || "");
                    return (
                      <span className="channel-item-left">
                        <span className="chan-avatar" aria-hidden="true">
                          {url ? (
                            <img alt="" src={url} />
                          ) : (
                            <span className="chan-avatar-fallback">{(nick.trim().slice(0, 1) || "?").toUpperCase()}</span>
                          )}
                        </span>
                        <span className="chan-name" title={nick || ""}>
                          {nick}
                        </span>
                      </span>
                    );
                  })()}
                  <span className="channel-item-spacer" />
                  {Number(channel.unreadCount) > 0 && (
                    <span className="unread-badge">{Number(channel.unreadCount) > 99 ? "99+" : channel.unreadCount}</span>
                  )}
                  <button
                    type="button"
                    className="icon-btn channel-actions__more"
                    title="Действия"
                    aria-label="Действия"
                    onMouseDown={(e) => { try { e.stopPropagation(); } catch { /* ignore */ } }}
                    onTouchStart={(e) => { try { e.stopPropagation(); } catch { /* ignore */ } }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget?.getBoundingClientRect?.();
                      const menuId = `dm:${channel.id}`;
                      const nextOpen = String(channelMenu?.openForId || "") === menuId ? "" : menuId;
                      setChannelMenu({
                        openForId: nextOpen,
                        x: Math.round(Number(rect?.left ?? rect?.right ?? 0)),
                        y: Math.round(Number(rect?.bottom ?? 0)),
                      });
                    }}
                  >
                    <SlonIcon name="dots" size={18} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="channels-body">
            {selectedServer && (
              <div className="server-top">
                <div className="server-top-row">
                  <div className="server-top-title">{selectedServer.name}</div>
                  <button
                    type="button"
                    className="server-top-menu-btn"
                    aria-label="Меню сервера"
                    title="Меню сервера"
                    onClick={() => setServerMenuOpen((v) => !v)}
                  >
                    <SlonIcon name="chevron-down" size={14} />
                  </button>
                </div>
                {selectedServer.description && (
                  <div className="server-top-desc muted">{selectedServer.description}</div>
                )}
              </div>
            )}
            {(() => {
              const canMod = canModerateServerUser(selectedServer, profile?.id);
              if (uncategorizedChannels.length === 0) return null;
              return (
                <div
                  className="channels-list channels-list--uncategorized"
                  onDragOver={canMod ? (e) => {
                    // If we're over a specific channel row, let that row decide the nearest target.
                    try {
                      if (e.target !== e.currentTarget && (e.target as any)?.closest?.(".channel-item")) return;
                    } catch { /* ignore */ }
                    if (channelDragRef.current?.type === "channel") {
                      handleChannelDragOver({ type: "category", id: "", pos: "after" }, e);
                    }
                  } : undefined}
                  onDragLeave={canMod ? (e) => {
                    try {
                      const rel = (e as any).relatedTarget as any;
                      if (rel && e.currentTarget && (e.currentTarget as any).contains?.(rel)) return;
                    } catch { /* ignore */ }
                    if (channelDragRef.current) setChannelDropLine(null);
                  } : undefined}
                  onDrop={canMod ? () => {
                    if (channelDragRef.current?.type === "channel") {
                      void handleChannelDrop(channelDropTargetFromLine({ type: "category", id: "", pos: "after" }));
                    }
                  } : undefined}
                >
                  {dropLineMatches(channelDropLine, { type: "category", id: "", pos: "before" }) && (
                    <div className="channel-drop-line" />
                  )}
                  {renderServerCategoryChannels(uncategorizedChannels, "")}
                  {renderCategoryChannelsListTailDropZone("", canMod)}
                </div>
              );
            })()}
            {canModerateServerUser(selectedServer, profile?.id) && serverCategories.length > 0 && (
              <div
                className="channel-category-drop-zone channel-category-drop-zone--top"
                onDragOver={(e) => handleChannelDragOver({ type: "category", id: "__top__", pos: "before" }, e)}
                onDrop={() => { void handleChannelDrop({ type: "category", id: "__top__", pos: "before" }); }}
              >
                {dropLineMatches(channelDropLine, { type: "category", id: "__top__", pos: "before" }) && (
                  <div className="channel-drop-line" />
                )}
              </div>
            )}
            {serverCategories.map((cat) => renderServerCategoryBlock(cat, channelsByCategoryId.get(String(cat.id)) || []))}
            {canModerateServerUser(selectedServer, profile?.id) && serverCategories.length > 0 && (
              <div
                className="channel-category-drop-zone channel-category-drop-zone--bottom"
                onDragOver={(e) => handleChannelDragOver({ type: "category", id: "__bottom__", pos: "after" }, e)}
                onDrop={() => { void handleChannelDrop({ type: "category", id: "__bottom__", pos: "after" }); }}
              >
                {dropLineMatches(channelDropLine, { type: "category", id: "__bottom__", pos: "after" }) && (
                  <div className="channel-drop-line" />
                )}
              </div>
            )}
            {canModerateServerUser(selectedServer, profile?.id) && (
              <div className="channels-body-spacer" aria-hidden="true" />
            )}
          </div>
        )}

        {(voiceState.connected || voiceState.joining) && activeVoiceChannelId && (
          <div className="voice-connection-panel" role="region" aria-label="Голосовая связь">
            <div className="voice-connection-row">
              <div
                className={`voice-connection-dot ${
                  voiceState.connected && voiceState.mediaLinkReady !== false
                    ? ""
                    : voiceState.connected
                      ? "is-reconnecting"
                      : "is-joining"
                }`}
                aria-hidden
              />
              <div className="voice-connection-titles">
                <div className="voice-connection-title">
                  {voiceState.connected
                    ? (voiceState.mediaLinkReady === false ? "Восстановление связи…" : "Голосовая связь")
                    : "Подключение…"}
                </div>
                <div className="voice-connection-sub muted">
                  {activeVoiceInfo?.kind === "dm"
                    ? `ЛС · ${activeVoiceInfo?.channel?.name || "Собеседник"}`
                    : `${(activeVoiceInfo?.server?.name || "Сервер")} · ${(activeVoiceInfo?.channel?.name || "Канал")}`}
                </div>
              </div>
            </div>
            <div className="voice-connection-actions">
              <button
                type="button"
                className={`user-voice-btn ${voiceState.muted ? "is-off" : ""}`}
                onClick={toggleMic}
                title={voiceState.muted ? "Включить микрофон" : "Выключить микрофон"}
                aria-pressed={voiceState.muted}
              >
                <SlonIcon name={voiceState.muted ? "mic-off" : "mic"} size={18} />
              </button>
              <button
                type="button"
                className={`user-voice-btn ${voiceState.deafened ? "is-off" : ""}`}
                onClick={toggleDeafen}
                title={voiceState.deafened ? "Включить звук" : "Режим без звука"}
                aria-pressed={voiceState.deafened}
              >
                <SlonIcon name={voiceState.deafened ? "headphones-off" : "headphones"} size={18} />
              </button>
              {voiceState.sharingScreen && isSloncordDesktop ? (
                <div className="voice-screen-menu-wrap" ref={screenShareMenuWrapRef}>
                  <button
                    type="button"
                    className="user-voice-btn is-off"
                    onClick={(e) => {
                      e.stopPropagation();
                      setScreenShareActionMenuOpen((o) => !o);
                    }}
                    title="Настройки демонстрации"
                    aria-label="Настройки демонстрации"
                    aria-haspopup="menu"
                    aria-expanded={screenShareActionMenuOpen}
                  >
                    <SlonIcon name="screen" size={18} />
                  </button>
                  {screenShareActionMenuOpen && (
                    <div
                      className="voice-screen-menu"
                      role="menu"
                      aria-label="Демонстрация экрана"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="voice-screen-menu__item"
                        role="menuitem"
                        onClick={() => {
                          void reconfigureScreenShare();
                        }}
                      >
                        Изменить настройки
                      </button>
                      <button
                        type="button"
                        className="voice-screen-menu__item voice-screen-menu__item--danger"
                        role="menuitem"
                        onClick={() => {
                          setScreenShareActionMenuOpen(false);
                          void toggleScreenShare();
                        }}
                      >
                        Остановить трансляцию
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className={`user-voice-btn ${voiceState.sharingScreen ? "is-off" : ""}`}
                  onClick={toggleScreenShare}
                  title={voiceState.sharingScreen ? "Остановить демонстрацию" : "Демонстрация экрана"}
                  aria-pressed={!!voiceState.sharingScreen}
                >
                  <SlonIcon name="screen" size={18} />
                </button>
              )}
              <button type="button" className="voice-connection-hangup" onClick={leaveVoice} title="Отключиться" aria-label="Отключиться">
                <SlonIcon name="hangup" size={18} />
              </button>
            </div>
          </div>
        )}

        {audioSettingsOpen && (
          <div
            className="sheet-backdrop sheet-backdrop--center"
            role="presentation"
            onClick={() => setAudioSettingsOpen(false)}
          >
            <div
              className="sheet-panel sheet-panel--center"
              role="dialog"
              aria-modal="true"
              aria-label="Настройки"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sheet-header">
                <div className="sheet-title">Настройки</div>
                <button type="button" className="sheet-close" onClick={() => setAudioSettingsOpen(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
              </div>
              <div className="sheet-body">
                <div className="panel-header--sub">Аудио</div>
                <div className="muted" style={{ marginTop: "6px" }}>
                  Здесь будут и другие настройки. Сейчас — звук.
                </div>
                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Устройства ввода</div>
                <select
                  className="form-field"
                  value={audioSettings.inputDeviceId}
                  onChange={(e) => {
                    const v = String(e.target.value || "");
                    setAudioSettings((p) => ({ ...p, inputDeviceId: v }));
                    try { localStorage.setItem("sloncord_audio_input_device", v); } catch { /* ignore */ }
                    try { voiceRef.current?.setInputDevice?.(v); } catch { /* ignore */ }
                  }}
                >
                  <option value="">По умолчанию</option>
                  {(audioDevices.inputs || []).map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Микрофон (${d.deviceId.slice(0, 6)})`}</option>
                  ))}
                </select>
                <div className="row" style={{ alignItems: "center" }}>
                  <div style={{ minWidth: "140px" }}>Усиление микрофона</div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={audioSettings.micGain}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 0;
                      setAudioSettings((p) => ({ ...p, micGain: v }));
                      try { localStorage.setItem("sloncord_audio_mic_gain", String(v)); } catch { /* ignore */ }
                      try { voiceRef.current?.setMicGain?.(v); } catch { /* ignore */ }
                    }}
                    style={{ flex: 1 }}
                  />
                  <div style={{ width: "54px", textAlign: "right" }}>{audioSettings.micGain}%</div>
                </div>

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Устройства вывода</div>
                <select
                  className="form-field"
                  value={audioSettings.outputDeviceId}
                  onChange={(e) => {
                    const v = String(e.target.value || "");
                    setAudioSettings((p) => ({ ...p, outputDeviceId: v }));
                    try { localStorage.setItem("sloncord_audio_output_device", v); } catch { /* ignore */ }
                    try { voiceRef.current?.setOutputDevice?.(v); } catch { /* ignore */ }
                  }}
                >
                  <option value="">По умолчанию (как в системе)</option>
                  {(audioDevices.outputs || []).map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Вывод (${d.deviceId.slice(0, 6)})`}</option>
                  ))}
                </select>
                <div className="muted" style={{ marginTop: "8px", lineHeight: 1.45 }}>
                  Если при демонстрации экрана со <strong>звуком системы</strong> зрители слышат себя в трансляции, попробуйте вывести
                  голос чата на <strong>другое устройство</strong>, чем игры и системные звуки (например наушники для голоса, динамики для системы).
                </div>
                <div className="row" style={{ alignItems: "center" }}>
                  <div style={{ minWidth: "140px" }}>Громкость</div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={audioSettings.speakerGain}
                    onChange={(e) => {
                      const v = Number(e.target.value) || 0;
                      setAudioSettings((p) => ({ ...p, speakerGain: v }));
                      try { localStorage.setItem("sloncord_audio_speaker_gain", String(v)); } catch { /* ignore */ }
                      try { voiceRef.current?.setSpeakerGain?.(v); } catch { /* ignore */ }
                    }}
                    style={{ flex: 1 }}
                  />
                  <div style={{ width: "54px", textAlign: "right" }}>{audioSettings.speakerGain}%</div>
                </div>

                <div className="muted" style={{ marginTop: "10px" }}>
                  Выбор устройства вывода поддерживается не во всех браузерах (например, iOS Safari).
                </div>

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Голос в канал</div>
                <p className="muted audio-settings-hint">
                  Галочки перезахватывают микрофон. Голос в эфир идёт непрерывно — без обрезки фраз посередине.
                </p>

                <div style={{ display: "grid", gap: "10px" }}>
                  <label className="audio-settings-check">
                    <input
                      type="checkbox"
                      checked={!!audioSettings.echoCancellation}
                      onChange={(e) => patchAudioSettings({ echoCancellation: !!e.target.checked })}
                    />
                    <span>Убрать эхо от колонок</span>
                  </label>

                  <label className="audio-settings-check">
                    <input
                      type="checkbox"
                      checked={!!audioSettings.noiseSuppression}
                      onChange={(e) => patchAudioSettings({ noiseSuppression: !!e.target.checked })}
                    />
                    <span>Шумоподавление (браузер)</span>
                  </label>

                  <label className="audio-settings-check">
                    <input
                      type="checkbox"
                      checked={!!audioSettings.autoGainControl}
                      onChange={(e) => patchAudioSettings({ autoGainControl: !!e.target.checked })}
                    />
                    <span>Ровная громкость голоса (AGC)</span>
                  </label>

                  {!!audioSettings.noiseSuppression && (
                    <div style={{ marginTop: "4px" }}>
                      <div className="muted" style={{ marginBottom: "6px" }}>
                        Сила шумоподавления: {Number(audioSettings.noiseReduction) || 0}%
                        {Number(audioSettings.noiseReduction) >= 70 ? " · усиленный режим" : ""}
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Number(audioSettings.noiseReduction) || 0}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                          patchAudioSettings({ noiseReduction: v });
                        }}
                        style={{ width: "100%" }}
                      />
                      <div className="muted audio-settings-hint" style={{ marginTop: "6px" }}>
                        0% — выкл., 30–50% — обычная комната, 70%+ — шумное помещение. Не отключает микрофон между словами.
                      </div>
                    </div>
                  )}
                </div>

                {(() => {
                  const info = voiceRef.current?.getAudioProcessingInfo?.();
                  if (!info?.summary) return null;
                  return (
                    <div className="muted audio-settings-hint" style={{ marginTop: "8px" }}>
                      {info.summary}
                    </div>
                  );
                })()}

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Индикатор «Говорю»</div>
                <p className="muted audio-settings-hint">
                  Только подсветка в списке участников и проверка ниже. На передачу голоса не влияет.
                </p>

                <label className="audio-settings-check">
                  <input
                    type="checkbox"
                    checked={audioSettings.inputSensitivityAuto !== false}
                    onChange={(e) => patchAudioSettings({ inputSensitivityAuto: !!e.target.checked })}
                  />
                  <span>Подстраивать порог под фон в комнате</span>
                </label>

                {audioSettings.inputSensitivityAuto === false && (
                  <div className="row" style={{ alignItems: "center", marginTop: "8px" }}>
                    <div style={{ minWidth: "148px" }}>Чувствительность</div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={audioSettings.inputSensitivity}
                      onChange={(e) => {
                        const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                        patchAudioSettings({ inputSensitivity: v });
                      }}
                      style={{ flex: 1 }}
                    />
                    <div style={{ width: "54px", textAlign: "right" }}>{audioSettings.inputSensitivity}</div>
                  </div>
                )}
                {audioSettings.inputSensitivityAuto !== false && (
                  <div className="muted audio-settings-hint" style={{ marginTop: "6px" }}>
                    Порог чуть выше фонового шума — индикатор совпадает с тем, что слышно в канале.
                  </div>
                )}

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Проверка микрофона</div>
                <div style={{ display: "grid", gap: "8px" }}>
                  <div className="audio-meter-track">
                    <div
                      className={`audio-meter-fill${inputMeter.open ? " audio-meter-fill--speaking" : ""}`}
                      style={{
                        width: `${Math.max(0, Math.min(100, Math.round((inputMeter.rms / 0.12) * 100)))}%`
                      }}
                    />
                    <div
                      className="audio-meter-threshold"
                      style={{
                        left: `${Math.max(0, Math.min(100, Math.round(((inputMeter.threshold || 0.006) / 0.12) * 100)))}%`
                      }}
                      title={`Порог: ${(inputMeter.threshold || 0).toFixed(3)}`}
                    />
                  </div>
                  <div className="muted" style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                    <span>Уровень: {(inputMeter.rms || 0).toFixed(3)}</span>
                    <span>Порог: {(inputMeter.threshold || 0.006).toFixed(3)}</span>
                    <span>Говорю: {inputMeter.open ? "да" : "нет"}</span>
                  </div>
                </div>

                {isSloncordDesktop && (
                  <>
                    <div className="panel-header--sub" style={{ marginTop: "18px" }}>Приложение (Windows)</div>
                    <div className="muted" style={{ marginTop: "6px", lineHeight: 1.45 }}>
                      Горячие клавиши работают глобально, пока Sloncord запущен. Задайте сочетание с клавишами Ctrl, Alt и/или Shift (рекомендуется).
                    </div>
                    <div className="panel-header--sub" style={{ marginTop: "12px" }}>Горячие клавиши</div>
                    <div className="row" style={{ alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "8px" }}>
                      <div style={{ minWidth: "160px" }}>Микрофон</div>
                      <div style={{ flex: 1, minWidth: "120px" }} className="muted">
                        {desktopHotkeyField === "mic" ? (
                          <span style={{ color: "#faa61a" }}>Нажмите сочетание… (Esc — отмена)</span>
                        ) : (
                          <span>{desktopPrefs.hotkeyToggleMic || "— не задано —"}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => setDesktopHotkeyField("mic")}
                        disabled={desktopHotkeyField != null && desktopHotkeyField !== "mic"}
                      >
                        Назначить
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        style={{ background: "#4a4f57" }}
                        onClick={() => {
                          void window.sloncord?.setDesktopPrefs?.({ hotkeyToggleMic: "" })?.then((r) => {
                            if (r?.ok) setDesktopPrefs((p) => ({ ...p, hotkeyToggleMic: "" }));
                          });
                        }}
                        disabled={!desktopPrefs.hotkeyToggleMic}
                      >
                        Сбросить
                      </button>
                    </div>
                    <div className="row" style={{ alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "10px" }}>
                      <div style={{ minWidth: "160px" }}>Наушники (глухота)</div>
                      <div style={{ flex: 1, minWidth: "120px" }} className="muted">
                        {desktopHotkeyField === "deafen" ? (
                          <span style={{ color: "#faa61a" }}>Нажмите сочетание… (Esc — отмена)</span>
                        ) : (
                          <span>{desktopPrefs.hotkeyToggleDeafen || "— не задано —"}</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => setDesktopHotkeyField("deafen")}
                        disabled={desktopHotkeyField != null && desktopHotkeyField !== "deafen"}
                      >
                        Назначить
                      </button>
                      <button
                        type="button"
                        className="small-btn"
                        style={{ background: "#4a4f57" }}
                        onClick={() => {
                          void window.sloncord?.setDesktopPrefs?.({ hotkeyToggleDeafen: "" })?.then((r) => {
                            if (r?.ok) setDesktopPrefs((p) => ({ ...p, hotkeyToggleDeafen: "" }));
                          });
                        }}
                        disabled={!desktopPrefs.hotkeyToggleDeafen}
                      >
                        Сбросить
                      </button>
                    </div>

                    <div className="panel-header--sub" style={{ marginTop: "14px" }}>Автозапуск</div>
                    <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", marginTop: "8px" }}>
                      <input
                        type="checkbox"
                        checked={!!desktopPrefs.loginOpenAtLogin}
                        onChange={(e) => {
                          const v = !!e.target.checked;
                          const nextHidden = v ? desktopPrefs.loginStartHidden : false;
                          setDesktopPrefs((p) => ({ ...p, loginOpenAtLogin: v, loginStartHidden: nextHidden }));
                          void window.sloncord?.setDesktopPrefs?.({
                            loginOpenAtLogin: v,
                            loginStartHidden: nextHidden,
                          });
                        }}
                      />
                      <span>Запускать Sloncord при старте Windows</span>
                    </label>
                    {desktopPrefs.loginOpenAtLogin && (
                      <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer", marginTop: "10px" }}>
                        <input
                          type="checkbox"
                          checked={!!desktopPrefs.loginStartHidden}
                          onChange={(e) => {
                            const v = !!e.target.checked;
                            setDesktopPrefs((p) => ({ ...p, loginStartHidden: v }));
                            void window.sloncord?.setDesktopPrefs?.({ loginStartHidden: v });
                          }}
                        />
                        <span>Открывать в свёрнутом состоянии</span>
                      </label>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {userVolumePopup.open && (
          <div
            ref={userVolumePopupRef}
            className="user-volume-card"
            style={{
              position: "fixed",
              left: userVolumePopup.x,
              top: userVolumePopup.y,
              width: "min(280px, calc(100vw - 24px))",
              maxHeight: "calc(100vh - 24px)",
              overflowY: "auto",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "10px",
              zIndex: 9999
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="user-volume-card__header">
              <button
                type="button"
                className="icon-btn user-volume-card__close"
                onClick={() => setUserVolumePopup({ open: false, userId: "", x: 0, y: 0, anchorX: 0, anchorY: 0, showVolume: false })}
                aria-label="Закрыть"
              >
                <SlonIcon name="close" size={16} />
              </button>
              <div className="user-volume-card__profile">
                <div className="user-volume-card__avatar">
                  {userAvatarUrlByUserId[String(userVolumePopup.userId)] ? (
                    <img alt="" src={userAvatarUrlByUserId[String(userVolumePopup.userId)]} />
                  ) : (
                    <span className="user-volume-card__avatar-fallback">
                      {(String(voicePeerNames[String(userVolumePopup.userId)] || userProfiles[String(userVolumePopup.userId)]?.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}
                    </span>
                  )}
                </div>
                <div
                  className={`user-volume-card__name ${slonTeamNickClass(userProfiles[String(userVolumePopup.userId)])}`}
                >
                  {userProfiles[String(userVolumePopup.userId)]?.nickname || voicePeerNames[String(userVolumePopup.userId)] || "…"}
                </div>
                <SlonTeamBadge flags={userProfiles[String(userVolumePopup.userId)]} />
                {String(userProfiles[String(userVolumePopup.userId)]?.bio || "").trim() ? (
                  <div className="user-volume-card__bio muted">
                    {String(userProfiles[String(userVolumePopup.userId)]?.bio || "").trim()}
                  </div>
                ) : null}
              </div>
            </div>
            <input
              className="form-field user-card-dm-input"
              placeholder={`Сообщение для @${userProfiles[String(userVolumePopup.userId)]?.nickname || voicePeerNames[String(userVolumePopup.userId)] || "user"}…`}
              value={userCardDmDraft}
              onChange={(e) => setUserCardDmDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const uid = String(userVolumePopup.userId || "");
                const txt = String(userCardDmDraft || "").trim();
                (async () => {
                  try {
                    const ch = await api("/dm/start-by-user", { method: "POST", body: JSON.stringify({ userId: uid }) });
                    if (ch?.id) {
                      setDmChannels((prev) => [ch, ...prev.filter((c) => String(c.id) !== String(ch.id))]);
                      setUiMode("dm");
                      setSelectedChannelId(ch.id);
                      if (txt) {
                        // Send immediately into the opened/created DM.
                        const prevSelected = String(selectedChannelId || "");
                        const prevMode = String(uiMode || "");
                        setSelectedChannelId(ch.id);
                        setUiMode("dm");
                        setTimeout(() => {
                          try {
                            setSelectedChannelId(ch.id);
                            setUiMode("dm");
                            const path = `/dm/${String(ch.id)}/messages`;
                            api(path, { method: "POST", body: JSON.stringify({ text: txt }) }).catch((e) => setError(e?.message || String(e)));
                            // Refresh current conversation view
                            try { refreshConversationData(String(ch.id), "dm"); } catch { /* ignore */ }
                          } catch { /* ignore */ }
                        }, 0);
                      }
                      setUserCardDmDraft("");
                      setUserVolumePopup({ open: false, userId: "", x: 0, y: 0, anchorX: 0, anchorY: 0 });
                    }
                  } catch (err) {
                    setError(err?.message || String(err));
                  }
                })();
              }}
              style={{ marginTop: "10px" }}
            />

            {(() => {
              const uid = String(userVolumePopup.userId || "");
              const showMod = uiMode === "server" && selectedServer && uid && canModerateMember(uid);
              const showAdminToggle = selectedServer && uid && isEffectiveServerOwner(selectedServer, profile?.id) && !isServerOwnerUser(selectedServer, uid);
              if (!showMod && !showAdminToggle) return null;
              const inVoice = isUserInServerVoice(uid);
              const isAdmin = isServerAdminUser(selectedServer, uid);
              return (
                <div className="user-card-actions">
                  {showMod && inVoice && (
                    <button
                      type="button"
                      className="user-card-action-btn"
                      title="Отключить от голосового канала"
                      aria-label="Отключить от голосового канала"
                      onClick={() => void disconnectMemberVoice(uid)}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2zM4 4l1.41 1.41L19 19l-1.41 1.41L4 4z"/></svg>
                    </button>
                  )}
                  {showMod && (
                    <button
                      type="button"
                      className="user-card-action-btn"
                      title="Исключить с сервера"
                      aria-label="Исключить с сервера"
                      onClick={() => confirmKickMember({ id: uid, nickname: userProfiles[uid]?.nickname || "" })}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 9V6l4 3-4 3V9h-2v6H8V9H6l4-3 4-3v3h2v6h4V9h2z"/></svg>
                    </button>
                  )}
                  {showMod && (
                    <button
                      type="button"
                      className="user-card-action-btn user-card-action-btn--danger"
                      title="Забанить на сервере"
                      aria-label="Забанить на сервере"
                      onClick={() => confirmBanMember({ id: uid, nickname: userProfiles[uid]?.nickname || "" })}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31C15.55 19.37 13.85 20 12 20zm6.21-1.79L7.79 6.79C9.14 5.63 10.85 5 12.5 5c4.42 0 8 3.58 8 8 0 1.65-.63 3.36-1.79 4.71z"/></svg>
                    </button>
                  )}
                  {showAdminToggle && (
                    <button
                      type="button"
                      className="user-card-action-btn"
                      title={isAdmin ? "Снять права администратора" : "Назначить администратором"}
                      aria-label={isAdmin ? "Снять права администратора" : "Назначить администратором"}
                      onClick={() => void toggleMemberAdmin(uid, !isAdmin)}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
                    </button>
                  )}
                </div>
              );
            })()}

            {userVolumePopup.showVolume && (
              <>
            <div className="muted" style={{ fontSize: "12px", lineHeight: 1.2, marginTop: "10px" }}>Громкость пользователя</div>
            <div className="row" style={{ alignItems: "center", marginTop: "8px" }}>
              <input
                type="range"
                min="0"
                max="300"
                value={Number(userVolumesRef.current[String(userVolumePopup.userId)] ?? 100)}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(300, Number(e.target.value) || 0));
                  userVolumesRef.current = { ...(userVolumesRef.current || {}), [String(userVolumePopup.userId)]: v };
                  try { localStorage.setItem("sloncord_voice_user_volumes", JSON.stringify(userVolumesRef.current)); } catch { /* ignore */ }
                  try { voiceRef.current?.setUserVolume?.(String(userVolumePopup.userId), v); } catch { /* ignore */ }
                  setUserVolumePopup((p) => ({ ...p }));
                }}
                style={{ flex: 1 }}
              />
              <input
                type="number"
                min="0"
                max="300"
                value={Number(userVolumesRef.current[String(userVolumePopup.userId)] ?? 100)}
                onChange={(e) => {
                  const v = Math.max(0, Math.min(300, Number(e.target.value) || 0));
                  userVolumesRef.current = { ...(userVolumesRef.current || {}), [String(userVolumePopup.userId)]: v };
                  try { localStorage.setItem("sloncord_voice_user_volumes", JSON.stringify(userVolumesRef.current)); } catch { /* ignore */ }
                  try { voiceRef.current?.setUserVolume?.(String(userVolumePopup.userId), v); } catch { /* ignore */ }
                  setUserVolumePopup((p) => ({ ...p }));
                }}
                style={{
                  width: "70px",
                  marginLeft: "8px",
                  borderRadius: "8px",
                  border: "1px solid var(--border)",
                  background: "var(--bg-input)",
                  color: "var(--text-main)",
                  padding: "6px 8px"
                }}
              />
            </div>
              </>
            )}
          </div>
        )}

        <div className="user-card">
          <div className="user-card-main">
            <div className="user-card-avatar">
              {userAvatarUrlByUserId[String(profile?.id)] ? (
                <img alt="" src={userAvatarUrlByUserId[String(profile?.id)]} />
              ) : (
                <span className="avatar-fallback">{(profile?.nickname || "?").trim().slice(0, 1).toUpperCase()}</span>
              )}
            </div>
            <div className="user-card-identity">
              <div><b className={slonTeamNickClass(profile)}>{profile?.nickname}</b></div>
              <SlonTeamBadge flags={profile} />
              <div className="muted">{profile?.login}</div>
            </div>
          </div>
          <div className="user-card-actions" style={{ marginTop: "8px" }}>
            <button
              type="button"
              className="user-card-action-btn"
              title="Профиль"
              aria-label="Профиль"
              onClick={() => setShowEditProfile(true)}
            >
              <SlonIcon name="profile" size={18} />
            </button>
            <button
              type="button"
              className="user-card-action-btn"
              title="Настройки"
              aria-label="Настройки"
              onClick={() => openSettingsSheet("audio")}
            >
              <SlonIcon name="settings" size={18} />
            </button>
            <button
              type="button"
              className="user-card-action-btn user-card-action-btn--danger"
              title="Выйти"
              aria-label="Выйти"
              onClick={logout}
            >
              <SlonIcon name="logout" size={18} />
            </button>
          </div>
        </div>
      </aside>
      </div>

      <main className="chat">
        <div ref={remoteAudioHostRef} className="remote-audio-host" aria-hidden="true" />
        <div ref={remoteVideoHostRef} className="remote-video-host" aria-hidden="true" />
        <header className="chat-header">
          <div className="chat-header-top">
            {isNarrow && mobileView === "chat" && (
              <button
                type="button"
                className="back-btn"
                onClick={() => { setMobileView("list"); closeMembersSheet(); }}
                aria-label="К списку чатов"
              >
                <SlonIcon name="chevron-left" size={18} />
              </button>
            )}
            <div className="chat-header-title">
              {selectedChannel ? (
                uiMode === "dm" ? (
                  <span className="chat-title-dm">
                    {(() => {
                      const ids = Array.isArray(selectedChannel.memberUserIds) ? selectedChannel.memberUserIds : [];
                      const meId = String(profile?.id || "");
                      const otherId = String(ids.map(String).find((x) => x && x !== meId) || "");
                      const url = otherId ? userAvatarUrlByUserId[otherId] : "";
                      const nick = String(selectedChannel.name || "");
                      return (
                        <>
                          <span className="chat-title-dm__avatar" aria-hidden="true">
                            {url ? (
                              <img alt="" src={url} />
                            ) : (
                              <span className="chan-avatar-fallback">{(nick.trim().slice(0, 1) || "?").toUpperCase()}</span>
                            )}
                          </span>
                          <span>{nick}</span>
                        </>
                      );
                    })()}
                  </span>
                ) : (
                  `# ${selectedChannel.name}`
                )
              ) : "Выберите канал"}
            </div>
            {isNarrow && mobileView === "chat" && members.length > 0 && (
              <button type="button" className="small-btn members-fab" onClick={openMembersSheet}>
                Участники
              </button>
            )}
            {uiMode === "dm" && selectedChannel && (
              <button
                type="button"
                className="icon-btn"
                title={String(activeVoiceChannelId) === String(selectedChannel.id) && (voiceState.connected || voiceState.joining)
                  ? "Отключиться от звонка"
                  : "Начать звонок"}
                aria-label="Звонок"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (String(activeVoiceChannelId) === String(selectedChannel.id) && (voiceState.connected || voiceState.joining)) {
                    // cancel outgoing call if still ringing
                    try {
                      const out = dmCall?.outgoing;
                      if (out?.callId && String(out.channelId) === String(selectedChannel.id)) {
                        api(`/dm/${String(selectedChannel.id)}/call/cancel`, { method: "POST", body: JSON.stringify({ callId: String(out.callId) }) }).catch(() => {});
                      }
                    } catch { /* ignore */ }
                    try { dmRingtoneRef.current.stopOutgoing?.(); } catch { /* ignore */ }
                    dmRingtoneRef.current.stopOutgoing = null;
                    setDmCall((p) => ({ ...(p || {}), outgoing: null }));
                    leaveVoice();
                  } else {
                    // Start ringing: notify the other user, play ringback for caller, show global UI.
                    const ids = Array.isArray(selectedChannel.memberUserIds) ? selectedChannel.memberUserIds.map(String) : [];
                    const meId = String(profile?.id || "");
                    const otherId = String(ids.find((x) => x && x !== meId) || "");
                    const callId = (crypto?.randomUUID?.() || `call-${Date.now()}-${Math.random().toString(16).slice(2)}`).toString();
                    if (otherId) {
                      setDmCall((p) => ({ ...(p || {}), outgoing: { callId, channelId: String(selectedChannel.id), toUserId: otherId, toNickname: String(selectedChannel.name || "") } }));
                        dmActiveCallSessionRef.current = { callId, channelId: String(selectedChannel.id), state: "ringing" };
                      try { dmRingtoneRef.current.stopOutgoing?.(); } catch { /* ignore */ }
                      dmRingtoneRef.current.stopOutgoing = startDmRingtone("outgoing");
                      api(`/dm/${String(selectedChannel.id)}/call/start`, { method: "POST", body: JSON.stringify({ callId }) }).catch(() => {});
                      // Join voice immediately (callee will join on accept).
                      connectVoiceToChannel(String(selectedChannel.id), { suppressJoinSfx: true });
                    } else {
                      connectVoiceToChannel(String(selectedChannel.id));
                    }
                  }
                }}
              >
                <SlonIcon name="phone" size={18} />
              </button>
            )}
            {uiMode === "dm" && selectedChannel && (
              <button
                type="button"
                className="icon-btn"
                title="Уведомления"
                aria-label="Уведомления"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const cid = String(selectedChannel.id || "");
                  const name = String(selectedChannel.name || "ЛС");
                  const prefs = readNotifPrefs(`${NOTIF_DM_KEY_PREFIX}${cid}`);
                  // bell-off when either sound or banners disabled
                  openNotifSettingsForDm(cid, name);
                }}
              >
                {(() => {
                  const cid = String(selectedChannel.id || "");
                  const prefs = readNotifPrefs(`${NOTIF_DM_KEY_PREFIX}${cid}`);
                  const off = !prefs.sound && !prefs.banners;
                  const partial = (!prefs.sound || !prefs.banners) && !off;
                  return off ? <SlonIcon name="bell-off" size={18} /> : (partial ? <SlonIcon name="bell-off" size={18} /> : <SlonIcon name="bell" size={18} />);
                })()}
              </button>
            )}
            {isWindowsClient && !isSloncordDesktop && desktopDownloadInfo && (() => {
              const p = String(desktopDownloadInfo.downloadUrl || "");
              const b = (
                String(apiBaseForDl || "")
                  .replace(/\/$/, "")
                  .trim() || (typeof window !== "undefined" ? window.location.origin : "")
              ).trim();
              const href = /^https?:\/\//i.test(p) ? p : (p.startsWith("/") ? `${b}${p}` : `${b}/${p}`);
              const sizeMb = (Number(desktopDownloadInfo.size) / (1024 * 1024)).toFixed(1);
              return (
                <a
                  className="chat-header-download"
                  href={href}
                  rel="noopener noreferrer"
                  title={`Windows · v${String(desktopDownloadInfo.version || "")} · ≈${sizeMb} МБ`}
                  onClick={(e) => e.stopPropagation()}
                >
                  Скачать .exe
                </a>
              );
            })()}
          </div>
        </header>

        {/* Mobile DM voice roster: .members is hidden on narrow layouts, so render it in-chat. */}
        {isNarrow && uiMode === "dm" && selectedChannel && (
          <div className="dm-voice-roster-inline">
            {(() => {
              const pid = String(selectedChannel.id);
              const meId = String(profile?.id || "");
              const isConnectedHere = String(activeVoiceChannelId) === pid && (voiceState.connected || voiceState.joining);
              const presence = voicePresenceByChannelId[pid];
              const ids = (isConnectedHere
                ? ((voiceState.rosterUserIds && voiceState.rosterUserIds.length > 0) ? voiceState.rosterUserIds : (presence?.userIds || []))
                : (presence?.userIds || []))
                .map((x) => String(x))
                .filter(Boolean);
              const presenceIds = (presence?.userIds || [])
                .map((x) => String(x))
                .filter((id) => id && id !== meId);
              if (isConnectedHere ? !ids.length : !presenceIds.length) return null;

              const sharers = isConnectedHere
                ? mergeScreenShareUserIds(voiceState.screenShareUserIds, presence?.screenShareUserIds)
                : new Set((presence?.screenShareUserIds || []).map((x) => String(x)).filter(Boolean));
              const others = (isConnectedHere ? ids : presenceIds).filter((x) => x && x !== meId);
              const meSpeaking = isUserSpeakingInVoice(meId, pid);
              const meSharing = sharers.has(String(meId));
              return (
                <div className="dm-voice-roster-inline__inner">
                  <div className="panel-header--sub" style={{ paddingTop: 0 }}>Звонок</div>
                  <ul className={`voice-members-inline ${isConnectedHere ? "" : "voice-members-inline--presence"}`} style={{ marginLeft: 0 }}>
                    {meId && isConnectedHere && (
                      <li key={`dmvpi-${pid}-me`} className={meSpeaking ? "is-speaking" : ""}>
                        <span className={`voice-member-avatar ${meSpeaking ? "is-speaking" : ""}`}>
                          {userAvatarUrlByUserId[String(meId)] ? (
                            <img alt="" src={userAvatarUrlByUserId[String(meId)]} />
                          ) : (
                            <span className="avatar-fallback">{(String(profile?.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                          )}
                        </span>
                        <span className="voice-member-name">{profile?.nickname || "Я"}</span>
                        {meSharing && <span className="live-pill">в эфире</span>}
                        {voiceState.muted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
                        {voiceState.deafened && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
                      </li>
                    )}
                    {others.map((id) => {
                      const isSp = isConnectedHere && isUserSpeakingInVoice(id, pid);
                      const isSharing = sharers.has(String(id));
                      const isMuted = isConnectedHere
                        ? (voiceState.mutedUserIds || []).some((x) => String(x) === String(id))
                        : (presence?.mutedUserIds || []).some((x) => String(x) === String(id));
                      const isDeaf = isConnectedHere
                        ? (voiceState.deafenedUserIds || []).some((x) => String(x) === String(id))
                        : (presence?.deafenedUserIds || []).some((x) => String(x) === String(id));
                      return (
                        <li key={`dmvpi-${pid}-${id}`} className={isSp ? "is-speaking" : ""}>
                          <span className={`voice-member-avatar ${isSp ? "is-speaking" : ""}`}>
                            {userAvatarUrlByUserId[String(id)] ? (
                              <img alt="" src={userAvatarUrlByUserId[String(id)]} />
                            ) : (
                              <span className="avatar-fallback">{(voicePeerNames[String(id)] || "?").trim().slice(0, 1).toUpperCase()}</span>
                            )}
                          </span>
                          <span className="voice-member-name">{voicePeerNames[String(id)] || "…"}</span>
                          {sharers.has(String(id)) && <span className="live-pill">в эфире</span>}
                          {isMuted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
                          {isDeaf && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
                          {sharers.has(String(id)) && (
                            <button
                              type="button"
                              className="icon-btn screen-join-btn"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openScreenView(id);
                              }}
                              title="Подключиться к демонстрации"
                              aria-label="Подключиться к демонстрации"
                            >
                              <SlonIcon name="expand" size={16} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })()}
          </div>
        )}

        <section
          className="messages"
          ref={messagesBoxRef}
          onDragOver={(e) => {
            // Allow dropping files into the chat area
            if (e.dataTransfer?.types?.includes?.("Files")) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            try {
              const files = Array.from(e.dataTransfer?.files || []);
              if (!files.length) return;
              e.preventDefault();
              addFilesToPendingForCurrentChat(files);
              try { composerInputRef.current?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
            } catch {
              // ignore
            }
          }}
          onScroll={() => {
            const el = messagesBoxRef.current;
            if (!el) return;
            const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            shouldAutoScrollRef.current = nearBottom;
          }}
        >
          {!selectedChannel && (
            <>
              <div className="muted hide-when-narrow">Создайте или выберите чат слева</div>
              <div className="muted only-narrow">Выберите чат в списке</div>
            </>
          )}
          {(() => {
            const unreadCount =
              uiMode === "dm"
                ? (dmChannels || []).find((c) => String(c.id) === String(selectedChannelId))?.unreadCount
                : (channels || []).find((c) => String(c.id) === String(selectedChannelId))?.unreadCount;
            const meId = String(profile?.id || "");
            const firstUnreadIndex = computeFirstUnreadIndex(messages, unreadCount, meId);
            const n = firstUnreadIndex >= 0 ? Math.max(0, messages.length - firstUnreadIndex) : 0;
            const splitIndex = firstUnreadIndex;
            let marked = false;

            const markReadNow = () => {
              if (marked) return;
              marked = true;
              (async () => {
                try {
                  if (!selectedChannelId) return;
                  if (uiModeRef.current === "server") {
                    await api(`/channels/${selectedChannelId}/read`, { method: "POST" });
                  } else {
                    await api(`/dm/${selectedChannelId}/read`, { method: "POST" });
                  }
                } catch {
                  // ignore
                } finally {
                  patchUnreadState(selectedChannelId, 0);
                }
              })();
            };

            // If server says there are unread messages, but our boundary logic hides the divider,
            // still mark the chat as read and clear badges (e.g. when unread tail only contains my messages
            // or when read state already advanced but counts didn't).
            if (!marked && Math.max(0, Number(unreadCount) || 0) > 0 && splitIndex < 0) {
              markReadNow();
            }

            return messages.map((msg, idx) => {
              const isUnread = splitIndex >= 0 && idx >= splitIndex;
              const isSystemMsg =
                String(msg?.senderUserId || "") === SYSTEM_USER_ID
                || String(msg?.senderNickname || "").trim().toLowerCase() === "sloncord";
              const isSystemMissedCall = isSystemMsg && /^пропущенн/i.test(String(msg?.text || "").trim());
              const prev = idx > 0 ? messages[idx - 1] : null;
              const prevDay = prev?.createdAtUtc ? (new Date(prev.createdAtUtc)).toDateString() : "";
              const curDay = msg?.createdAtUtc ? (new Date(msg.createdAtUtc)).toDateString() : "";
              const showDayDivider = !!msg?.createdAtUtc && (!prev || (prevDay && curDay && prevDay !== curDay));
              const dayLabel = showDayDivider ? formatDayDividerLabel(msg.createdAtUtc) : "";
              return (
                <Fragment key={msg.id}>
                  {showDayDivider && dayLabel && (
                    <div className="day-divider" role="separator" aria-label={`День: ${dayLabel}`}>
                      <span className="day-divider__line" />
                      <span className="day-divider__pill">{dayLabel}</span>
                      <span className="day-divider__line" />
                    </div>
                  )}
                  {idx === splitIndex && n > 0 && (
                    <div
                      ref={unreadDividerRef}
                      className="unread-divider"
                      role="separator"
                      aria-label="Непрочитанные сообщения"
                    >
                      <span className="unread-divider__line" />
                      <span className="unread-divider__pill">непрочитанные сообщения</span>
                      <span className="unread-divider__line" />
                    </div>
                  )}
                  <div
                    className={`message${isSystemMsg ? " message--system" : ""}${isSystemMissedCall ? " message--system-missed-call" : ""}${isUnread ? " message--unread" : ""}${String(highlightedMessageId) === String(msg.id) ? " message--highlight" : ""}${(isNarrow && String(swipeReplyUi.msgId) === String(msg.id) && swipeReplyUi.progress > 0) ? " is-swipe-active" : ""}`}
                    id={`msg-${String(msg.id)}`}
                    onMouseEnter={() => {
                      if (isUnread) markReadNow();
                    }}
                    onPointerDown={(e) => {
                      if (!isNarrow) return;
                      if (isSystemMsg) return;
                      try {
                        if (String(e.pointerType || "") !== "touch") return;
                        if (editing?.id) return;
                        // don't start swipe on buttons/links
                        const tag = String(e?.target?.tagName || "").toLowerCase();
                        if (tag === "button" || tag === "input" || tag === "textarea") return;
                        if (e?.target?.closest?.("button")) return;
                      } catch { /* ignore */ }
                      swipeReplyRef.current = {
                        active: true,
                        msgId: String(msg.id),
                        startX: Number(e.clientX || 0),
                        startY: Number(e.clientY || 0),
                        lastDx: 0,
                        locked: ""
                      };
                      setSwipeReplyUi({ msgId: String(msg.id), progress: 0 });
                    }}
                    onPointerMove={(e) => {
                      if (!isNarrow) return;
                      const st = swipeReplyRef.current;
                      if (!st?.active) return;
                      if (String(st.msgId) !== String(msg.id)) return;
                      if (String(e.pointerType || "") !== "touch") return;
                      const dx = Number(e.clientX || 0) - Number(st.startX || 0);
                      const dy = Number(e.clientY || 0) - Number(st.startY || 0);
                      const adx = Math.abs(dx);
                      const ady = Math.abs(dy);
                      if (!st.locked) {
                        if (adx > 10 || ady > 10) st.locked = adx > ady ? "h" : "v";
                      }
                      if (st.locked === "v") return;
                      // swipe left only
                      const leftDx = Math.min(0, dx);
                      st.lastDx = leftDx;
                      const threshold = 84;
                      const prog = Math.max(0, Math.min(1, (-leftDx) / threshold));
                      setSwipeReplyUi({ msgId: String(msg.id), progress: prog });
                      try { if (prog > 0) e.preventDefault(); } catch { /* ignore */ }
                    }}
                    onPointerUp={() => {
                      if (!isNarrow) return;
                      const st = swipeReplyRef.current;
                      if (!st?.active) return;
                      if (String(st.msgId) !== String(msg.id)) return;
                      const dx = Number(st.lastDx || 0);
                      const threshold = 84;
                      const shouldReply = (-dx) >= threshold;
                      swipeReplyRef.current = { active: false, msgId: "", startX: 0, startY: 0, lastDx: 0, locked: "" };
                      setSwipeReplyUi({ msgId: "", progress: 0 });
                      if (shouldReply) {
                        try { if (navigator.vibrate) navigator.vibrate(10); } catch { /* ignore */ }
                        beginReplyDraft({
                          id: String(msg.id),
                          senderNickname: String(msg.senderNickname || ""),
                          text: String(msg.text || ""),
                          firstAttachment: (Array.isArray(msg.attachments) && msg.attachments.length > 0) ? msg.attachments[0] : (msg.file || null)
                        });
                      }
                    }}
                    onPointerCancel={() => {
                      const st = swipeReplyRef.current;
                      if (!st?.active) return;
                      swipeReplyRef.current = { active: false, msgId: "", startX: 0, startY: 0, lastDx: 0, locked: "" };
                      setSwipeReplyUi({ msgId: "", progress: 0 });
                    }}
                  >
                  {isNarrow && String(swipeReplyUi.msgId) === String(msg.id) && swipeReplyUi.progress > 0 && (
                    <div className="message-swipe" aria-hidden="true">
                      <div
                        className="message-swipe__bubble"
                        style={{
                          transform: `scale(${0.85 + 0.25 * Math.max(0, Math.min(1, swipeReplyUi.progress))})`,
                          opacity: Math.max(0, Math.min(1, swipeReplyUi.progress))
                        }}
                      >
                        <SlonIcon name="reply" size={16} />
                      </div>
                    </div>
                  )}
              {!isSystemMsg && (
                <div className="msg-avatar">
                  {messageAvatarUrl(msg) ? (
                    <img alt="" src={messageAvatarUrl(msg)} />
                  ) : (
                    <span className="avatar-fallback">
                      {(String(msg.senderNickname || "?").trim().slice(0, 1) || "?").toUpperCase()}
                    </span>
                  )}
                </div>
              )}
              <div className="msg-body">
                {isSystemMsg && (
                  <div className="system-msg-meta">
                    <span className="system-msg-time">{formatSystemTimestamp(msg.createdAtUtc)}</span>
                  </div>
                )}
                {!isSystemMsg && (
                  <div className="message-top">
                    <div className="message-top-left">
                      <span
                        className={`msg-author ${slonTeamNickClass({
                          isPlatformRoot: msg.senderIsPlatformRoot,
                          isPlatformModerator: msg.senderIsPlatformModerator,
                        })} ${String(msg?.senderUserId || "") && String(msg?.senderUserId) !== SYSTEM_USER_ID ? "msg-author--clickable" : ""}`}
                        onClick={(e) => {
                          const uid = String(msg?.senderUserId || "");
                          if (!uid || uid === SYSTEM_USER_ID) return;
                          e.stopPropagation();
                          openUserCard(uid, e);
                        }}
                      >
                        {msg.senderNickname}
                      </span>
                      <span className="msg-time">
                        {msg?.clientStatus === "sending"
                          ? "отправка…"
                          : new Date(msg.createdAtUtc).toLocaleString()}
                        {msg.editedAtUtc ? " · изм." : ""}
                      </span>
                    </div>
                    <div className="message-actions">
                      <button
                        type="button"
                        className="icon-btn message-actions__quick"
                        title="Ответить"
                        aria-label="Ответить"
                        onMouseDown={(e) => { e.preventDefault(); }}
                        onClick={() => {
                          beginReplyDraft({
                            id: String(msg.id),
                            senderNickname: String(msg.senderNickname || ""),
                            text: String(msg.text || ""),
                            firstAttachment: (Array.isArray(msg.attachments) && msg.attachments.length > 0) ? msg.attachments[0] : (msg.file || null)
                          });
                        }}
                      >
                        <SlonIcon name="reply" size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn message-actions__quick"
                        title="Переслать"
                        aria-label="Переслать"
                        onClick={() => {
                          setForwardModal({
                            open: true,
                            query: "",
                            selectedIds: {},
                            source: msg
                          });
                        }}
                      >
                        <SlonIcon name="forward" size={16} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn message-actions__more"
                        title="Действия"
                        aria-label="Действия"
                        onMouseDown={(e) => {
                          // Prevent the global outside-click handler from closing the menu
                          // before this button's onClick toggles it.
                          try { e.stopPropagation(); } catch { /* ignore */ }
                        }}
                        onTouchStart={(e) => {
                          // iOS Safari: touchstart fires before click; stopPropagation keeps toggle stable.
                          try { e.stopPropagation(); } catch { /* ignore */ }
                        }}
                        onClick={(e) => {
                          const rect = e.currentTarget?.getBoundingClientRect?.();
                          const nextOpen = String(messageMenu?.openForId || "") === String(msg.id) ? "" : String(msg.id);
                          setMessageMenu({
                            openForId: nextOpen,
                            x: Math.round(Number(rect?.left ?? rect?.right ?? 0)),
                            y: Math.round(Number(rect?.bottom ?? 0))
                          });
                        }}
                      >
                        …
                      </button>
                    </div>
                  </div>
                )}
                {msg?.replyTo && !msg.isDeleted && (
                  <button
                    type="button"
                    className="message-reply"
                    onClick={(e) => {
                      try {
                        e.preventDefault();
                        e.stopPropagation();
                      } catch { /* ignore */ }
                      const rid = String(msg?.replyTo?.id || msg?.replyToMessageId || "");
                      void jumpToReferencedMessage(rid);
                    }}
                    title="Перейти к сообщению"
                  >
                    <span className="message-reply__thread" aria-hidden="true" />
                    <span className="message-reply__content">
                      <span className="message-reply__author">
                        <span className="message-reply__avatar" aria-hidden="true">
                          {(() => {
                            const url = messageAvatarUrl({ senderAvatarFileId: msg.replyTo.senderAvatarFileId, senderUserId: msg.replyTo.senderUserId } as any);
                            const nick = String(msg.replyTo.senderNickname || "…");
                            return url ? (
                              <img alt="" src={url} />
                            ) : (
                              <span className="message-reply__avatar-fallback">{(nick.trim().slice(0, 1) || "?").toUpperCase()}</span>
                            );
                          })()}
                        </span>
                        <span className="message-reply__who">{String(msg.replyTo.senderNickname || "…")}</span>
                      </span>
                      <span className="message-reply__text">
                        {String(msg.replyTo.text || "").trim()
                          ? String(msg.replyTo.text).trim()
                          : (msg.replyTo.firstAttachment ? <><SlonIcon name="attach" size={13} className="slon-icon--inline-start" /> Вложение</> : "…")}
                      </span>
                    </span>
                  </button>
                )}

                {editing.id === msg.id ? (
                  <div className="message-edit">
                    <textarea
                      id={`edit-${String(msg.id)}`}
                      rows="3"
                      className="message-edit__textarea"
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing({ id: "", text: "", originalText: "", removeAttachmentFileIds: [] });
                          return;
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          saveEditMessage();
                        }
                      }}
                    />
                    <div className="message-edit__hint">
                      Esc — отмена · Enter — сохранить · Shift+Enter — новая строка
                    </div>
                  </div>
                ) : isSystemMsg ? (
                  <div className="system-msg-line">
                    {isSystemMissedCall && <span className="system-call-icon" aria-hidden><SlonIcon name="phone" size={16} /></span>}
                    <span>{renderTextWithLinks(String(msg.text || "").trim())}</span>
                  </div>
                ) : (() => {
                  const { header, body } = splitForwardedText(msg.text || "");
                  return (
                    <>
                      {header && <div className="message-forwarded">{header}</div>}
                      {body && <div>{renderTextWithLinks(body)}</div>}
                    </>
                  );
                })()}
                {(() => {
                  const serverAttList = Array.isArray(msg.attachments) && msg.attachments.length > 0
                    ? msg.attachments
                    : (msg.file ? [msg.file] : []);
                  const hasServerAtts = serverAttList.length > 0;
                  // Optimistic local upload message: render local attachments with progress until server message arrives.
                  if (Array.isArray(msg?.clientAttachments) && msg.clientAttachments.length > 0 && !hasServerAtts) {
                    return (
                      <div className="msg-attachments-list">
                        {msg.clientAttachments.map((a) => {
                          const isImg = a.previewUrl && String(a.type || "").startsWith("image/");
                          const isVid = a.previewUrl && String(a.type || "").startsWith("video/");
                          return (
                            <div key={String(a.id || a.name)} className="msg-attachment-wrap">
                              <div className="pending-attachment__tile" style={{ width: "120px", height: "120px" }}>
                                {isImg ? (
                                  <img src={a.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                                ) : isVid ? (
                                  <>
                                    <video src={a.previewUrl} muted playsInline className="pending-attachment__video-el" />
                                    <span className="pending-attachment__play" aria-hidden><SlonIcon name="play" size={18} /></span>
                                  </>
                                ) : (
                                  <div className="pending-attachment__fileicon">
                                    <img src={fileIconForName(a.name || "")} alt="" />
                                  </div>
                                )}
                                {(a.status === "uploading" || a.status === "done") && (
                                  <div className="pending-attachment__progress">
                                    <div className="pending-attachment__progress-bar" style={{ width: `${Math.round((Number(a.progress) || 0) * 100)}%` }} />
                                  </div>
                                )}
                              </div>
                              {a.status === "error" && a.errorMessage && (
                                <div className="pending-attachment__error">{a.errorMessage}</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  const list = serverAttList;
                  if (!list.length) return null;
                  const removedSet = new Set((editing.id === msg.id ? (editing.removeAttachmentFileIds || []) : []).map((x) => String(x)));
                  return (
                    <div className="msg-attachments-list">
                      {list
                        .filter((f) => !removedSet.has(String(f.id)))
                        .map((f) => (
                          <div key={String(f.id)} className="msg-attachment-wrap">
                            {editing.id === msg.id && (
                              <button
                                type="button"
                                className="msg-attachment-wrap__remove"
                                aria-label="Удалить вложение"
                                title="Удалить вложение"
                                onClick={() => {
                                  setEditing((cur) => {
                                    if (!cur || String(cur.id) !== String(msg.id)) return cur;
                                    const curIds = Array.isArray(cur.removeAttachmentFileIds) ? cur.removeAttachmentFileIds.map(String) : [];
                                    if (curIds.includes(String(f.id))) return cur;
                                    return { ...cur, removeAttachmentFileIds: [...curIds, String(f.id)] };
                                  });
                                }}
                              >
                                <SlonIcon name="close" size={16} />
                              </button>
                            )}
                            <MessageFilePreview
                              file={{ id: f.id, originalName: f.originalName || "file.bin" }}
                              token={token}
                              onOpenLightbox={(lb) => setMediaLightbox({ open: true, ...lb })}
                              onDownload={() => downloadFile(f.id, f.originalName || "file.bin")}
                              onMediaLoaded={() => {
                                if (!shouldAutoScrollRef.current) return;
                                const el = messagesBoxRef.current;
                                if (!el) return;
                                try { el.scrollTop = el.scrollHeight; } catch { /* ignore */ }
                              }}
                            />
                          </div>
                        ))}
                    </div>
                  );
                })()}
              </div>
                  </div>
                </Fragment>
              );
            });
          })()}
          <div ref={messagesEndRef} />
        </section>

        {showJumpToBottom && (
          <button
            type="button"
            className="jump-to-bottom"
            aria-label="Вниз"
            title="Вниз"
            onClick={() => {
              try {
                const el = messagesBoxRef.current;
                if (!el) return;
                shouldAutoScrollRef.current = true;
                el.scrollTop = el.scrollHeight;
                setShowJumpToBottom(false);
              } catch { /* ignore */ }
            }}
          >
            <SlonIcon name="arrow-down" size={18} />
          </button>
        )}

        {activeChatMute ? (
          <footer className="composer composer--muted">
            <div className="composer-muted" role="status">
              Ваш чат временно заблокирован по причине: {activeChatMute.reason || "—"}. Разблокировка: {formatChatMuteUntil(activeChatMute.until)}
            </div>
          </footer>
        ) : (
        <footer className="composer">
          {replyDraft?.id && (
            <div className="composer-reply">
              <div className="composer-reply__meta">
                <div className="composer-reply__title">Ответ пользователю <b>{String(replyDraft.senderNickname || "…")}</b></div>
                <div className="composer-reply__text">
                  {String(replyDraft.text || "").trim()
                    ? String(replyDraft.text).trim()
                    : (replyDraft.firstAttachment ? <><SlonIcon name="attach" size={13} className="slon-icon--inline-start" /> Вложение</> : "…")}
                </div>
              </div>
              <button
                type="button"
                className="composer-reply__close"
                aria-label="Отменить ответ"
                title="Отменить ответ"
                onClick={() => setReplyDraft(null)}
              >
                <SlonIcon name="close" size={16} />
              </button>
            </div>
          )}
          {pendingAttachments?.length > 0 && (
            <div className="pending-attachments" onPaste={handleComposerPaste}>
              {pendingAttachments.map((a) => (
                <div key={a.id} className="pending-attachment" title={a.file?.name || ""}>
                  <div className="pending-attachment__tile">
                    {(() => {
                      const isImg = a.previewUrl && a.file.type?.startsWith("image/");
                      const isVid = a.previewUrl && a.file.type?.startsWith("video/");
                      if (isImg) {
                        return (
                          <button
                            type="button"
                            className="pending-attachment__thumb"
                            onClick={() => {
                              if (a.previewUrl) {
                                setMediaLightbox({
                                  open: true,
                                  dataUrl: a.previewUrl,
                                  name: a.file.name,
                                  fileId: "",
                                  kind: "image"
                                });
                              }
                            }}
                          >
                            <img src={a.previewUrl} alt="" />
                          </button>
                        );
                      }
                      if (isVid) {
                        return (
                          <button
                            type="button"
                            className="pending-attachment__thumb pending-attachment__thumb--video"
                            onClick={() => setMediaLightbox({
                              open: true,
                              dataUrl: a.previewUrl,
                              name: a.file.name,
                              fileId: "",
                              kind: "video"
                            })}
                          >
                            <video src={a.previewUrl} playsInline muted className="pending-attachment__video-el" />
                            <span className="pending-attachment__play" aria-hidden><SlonIcon name="play" size={18} /></span>
                          </button>
                        );
                      }
                      const icon = fileIconForName(a.file?.name || "");
                      return (
                        <div className="pending-attachment__fileicon">
                          <img src={icon} alt="" />
                        </div>
                      );
                    })()}

                    <button
                      type="button"
                      className="pending-attachment__remove"
                      onClick={() => {
                        if (a?.previewUrl) {
                          try { URL.revokeObjectURL(a.previewUrl); } catch { /* ignore */ }
                        }
                        setPendingAttachmentsForChat((prev) => (prev || []).filter((x) => x.id !== a.id));
                      }}
                      aria-label="Удалить вложение"
                      title="Удалить"
                    >
                      <SlonIcon name="close" size={16} />
                    </button>

                    {(a.status === "uploading" || a.status === "done") && (
                      <div className="pending-attachment__progress">
                        <div className="pending-attachment__progress-bar" style={{ width: `${Math.round((Number(a.progress) || 0) * 100)}%` }} />
                      </div>
                    )}
                  </div>

                  {a.status === "error" && a.errorMessage && (
                    <div className="pending-attachment__error">{a.errorMessage}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {(() => {
            const chId = String(selectedChannelId || "");
            const m = typingByChannelId[chId] || {};
            const ids = Object.keys(m || {}).filter((uid) => (Number(m[uid]) || 0) > Date.now());
            const names = ids
              .map((uid) => userProfiles[String(uid)]?.nickname || voicePeerNames[String(uid)] || "…")
              .slice(0, 3);
            const text =
              !ids.length
                ? ""
                : names.length === 1
                  ? `${names[0]} печатает…`
                  : names.length === 2
                    ? `${names[0]} и ${names[1]} печатают…`
                    : `${names[0]}, ${names[1]} и ещё ${ids.length - 2} печатают…`;
            return text
              ? <div className="composer-typing" aria-live="polite">{text}</div>
              : null;
          })()}
          <div
            className="composer-row"
            onDragOver={(e) => {
              if (!selectedChannel) return;
              if (e.dataTransfer?.types?.includes?.("Files")) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!selectedChannel) return;
              try {
                const files = Array.from(e.dataTransfer?.files || []);
                if (!files.length) return;
                e.preventDefault();
                addFilesToPendingForCurrentChat(files);
                try { composerInputRef.current?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
              } catch {
                // ignore
              }
            }}
          >
          <div className="composer-add-wrap" ref={composerAddRef}>
            <label
              className={`composer-add-btn${!selectedChannel ? " is-disabled" : ""}`}
              title="Загрузить файл"
              aria-label="Загрузить файл"
              htmlFor="composer-file-input"
              onMouseDown={(e) => {
                if (!selectedChannel) e.preventDefault();
              }}
              onClick={() => {
                // #region agent log
                fetch('http://127.0.0.1:7316/ingest/cd99b0ec-f39d-4358-92be-d852aa4559d1',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0f7ff1'},body:JSON.stringify({sessionId:'0f7ff1',runId:'pre-fix',hypothesisId:'H1',location:'app.jsx:composer-add-btn',message:'open file picker (+)',data:{selectedChannel:!!selectedChannel},timestamp:Date.now()})}).catch(()=>{});
                // #endregion agent log
              }}
            >
                  <SlonIcon name="plus" size={22} />
            </label>
            {/* Keep the file input always mounted. iOS/Safari may block programmatic click() on hidden/unmounted inputs. */}
            <input
              id="composer-file-input"
              ref={fileInputRef}
              type="file"
              multiple
              style={{ position: "absolute", left: "-9999px", width: "1px", height: "1px", opacity: 0 }}
              onChange={(e) => {
                // #region agent log
                fetch('http://127.0.0.1:7316/ingest/cd99b0ec-f39d-4358-92be-d852aa4559d1',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0f7ff1'},body:JSON.stringify({sessionId:'0f7ff1',runId:'pre-fix',hypothesisId:'H2',location:'app.jsx:file-input:onChange',message:'file input change fired',data:{filesLen:Number(e?.target?.files?.length||0)},timestamp:Date.now()})}).catch(()=>{});
                // #endregion agent log
                const files = Array.from(e.target.files || []);
                if (files.length) addFilesToPendingForCurrentChat(files);
                e.target.value = "";
              }}
            />
          </div>
          <div className="composer-input-wrap">
            <textarea
              ref={composerInputRef}
              className="composer-textarea"
              rows={1}
              placeholder={selectedChannel ? "Написать сообщение…" : "Сначала выберите чат"}
              value={newMessage}
              enterKeyHint="enter"
              onChange={(e) => {
                setNewMessage(e.target.value);
                syncComposerHeight();
                emitTypingSoon();
              }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              disabled={!selectedChannel}
            />
          </div>
          <button
            className="composer-send-btn"
            onMouseDown={(e) => { e.preventDefault(); }}
            onTouchStart={(e) => { e.preventDefault(); }}
            onClick={() => {
              sendChatMessage();
              // Re-focus for mobile keyboards (best-effort).
              try { composerInputRef.current?.focus?.({ preventScroll: true }); } catch { /* ignore */ }
            }}
            disabled={!selectedChannel || (!newMessage.trim() && !(pendingAttachments?.length > 0))}
            aria-label="Отправить"
            title="Отправить"
          >
            <SlonIcon name="send" size={18} />
          </button>
          </div>
        </footer>
        )}
      </main>

      <aside className="members">
        <div className="panel-header">{uiMode === "dm" ? "Собеседник" : "Участники"}</div>
        {uiMode === "dm" && selectedChannel && (
          <div style={{ padding: "10px 14px 6px" }}>
            {(() => {
              const pid = String(selectedChannel.id);
              const isConnectedHere = String(activeVoiceChannelId) === pid && (voiceState.connected || voiceState.joining);
              const presence = voicePresenceByChannelId[pid];
              const meId = String(profile?.id || "");
              const ids = (isConnectedHere
                ? ((voiceState.rosterUserIds && voiceState.rosterUserIds.length > 0) ? voiceState.rosterUserIds : (presence?.userIds || []))
                : (presence?.userIds || []))
                .map((x) => String(x))
                .filter(Boolean);
              const presenceIds = (presence?.userIds || [])
                .map((x) => String(x))
                .filter((id) => id && id !== meId);
              if (isConnectedHere ? !ids.length : !presenceIds.length) return null;

              const sharers = isConnectedHere
                ? mergeScreenShareUserIds(voiceState.screenShareUserIds, presence?.screenShareUserIds)
                : new Set((presence?.screenShareUserIds || []).map((x) => String(x)).filter(Boolean));
              const others = (isConnectedHere ? ids : presenceIds).filter((x) => x && x !== meId);
              const meSpeaking = isUserSpeakingInVoice(meId, pid);
              const meSharing = sharers.has(String(meId));
              return (
                <>
                  <div className="panel-header--sub" style={{ paddingTop: 0 }}>Голос</div>
                  <ul className={`voice-members-inline ${isConnectedHere ? "" : "voice-members-inline--presence"}`} style={{ marginLeft: 0 }}>
                    {meId && isConnectedHere && (
                      <li key={`dmvp-${pid}-me`} className={meSpeaking ? "is-speaking" : ""}>
                        <span className={`voice-member-avatar ${meSpeaking ? "is-speaking" : ""}`}>
                          {userAvatarUrlByUserId[String(meId)] ? (
                            <img alt="" src={userAvatarUrlByUserId[String(meId)]} />
                          ) : (
                            <span className="avatar-fallback">{(String(profile?.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                          )}
                        </span>
                        <span className="voice-member-name">{profile?.nickname || "Я"}</span>
                        {meSharing && <span className="live-pill">в эфире</span>}
                        {voiceState.muted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
                        {voiceState.deafened && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
                      </li>
                    )}
                    {others.map((id) => {
                      const isSp = isConnectedHere && isUserSpeakingInVoice(id, pid);
                      const isSharing = sharers.has(String(id));
                      const isMuted = isConnectedHere
                        ? (voiceState.mutedUserIds || []).some((x) => String(x) === String(id))
                        : (presence?.mutedUserIds || []).some((x) => String(x) === String(id));
                      const isDeaf = isConnectedHere
                        ? (voiceState.deafenedUserIds || []).some((x) => String(x) === String(id))
                        : (presence?.deafenedUserIds || []).some((x) => String(x) === String(id));
                      return (
                        <li key={`dmvp-${pid}-${id}`} className={isSp ? "is-speaking" : ""}>
                          <span className={`voice-member-avatar ${isSp ? "is-speaking" : ""}`}>
                            {userAvatarUrlByUserId[String(id)] ? (
                              <img alt="" src={userAvatarUrlByUserId[String(id)]} />
                            ) : (
                              <span className="avatar-fallback">{(voicePeerNames[String(id)] || "?").trim().slice(0, 1).toUpperCase()}</span>
                            )}
                          </span>
                          <span
                            className="voice-member-name"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openUserCard(id, e, { showVolume: true });
                            }}
                            title="Настроить громкость пользователя"
                            style={{ cursor: "pointer" }}
                          >
                            {voicePeerNames[String(id)] || "…"}
                          </span>
                          {sharers.has(String(id)) && <span className="live-pill">в эфире</span>}
                          {isMuted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен"><SlonIcon name="mic-off" size={14} /></span>}
                          {isDeaf && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены"><SlonIcon name="headphones-off" size={14} /></span>}
                          {sharers.has(String(id)) && (
                            <button
                              type="button"
                              className="icon-btn screen-join-btn"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openScreenView(id);
                              }}
                              title="Подключиться к демонстрации"
                              aria-label="Подключиться к демонстрации"
                            >
                              <SlonIcon name="expand" size={16} />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </>
              );
            })()}
          </div>
        )}
        <div className="members-list">
          {uiMode === "dm" ? (
            <>
              {(Array.isArray(members) ? members : []).map((m) => (
                <div key={m.id} className="member">
                  <div className="member-row">
                    <span className="member-avatar">
                      {userAvatarUrlByUserId[String(m.id)] ? (
                        <img alt="" src={userAvatarUrlByUserId[String(m.id)]} />
                      ) : (
                        <span className="avatar-fallback">{(String(m.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                      )}
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                      <b className={slonTeamNickClass(m)} style={{ lineHeight: 1.1 }}>{m.nickname}</b>
                      {(() => {
                        const id = String(m.id);
                        const p = userPresenceByUserId[id] || {};
                        const online = (p.online != null ? !!p.online : !!m.online);
                        const lastSeen = String(p.lastSeenAtUtc || m.lastSeenAtUtc || "");
                        if (online) {
                          return (
                            <span className="muted presence-line" style={{ fontSize: "12px" }}>
                              <span className="presence-dot presence-dot--online" aria-hidden />
                              Online
                            </span>
                          );
                        }
                        const s = formatLastSeen(lastSeen);
                        return (
                          <span className="muted presence-line" style={{ fontSize: "12px" }}>
                            <span className="presence-dot presence-dot--offline" aria-hidden />
                            {s ? `был(а) ${s}` : "Offline"}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="members-section-title">В сети — {groupedMembers.online.length}</div>
              {groupedMembers.online.map((m) => (
            <div key={m.id} className="member member--interactive">
              <div
                className={`member-row${uiMode === "server" && canModerateServerUser(selectedServer, profile?.id) ? " member-row--mod-tools" : ""}`}
                role="button"
                tabIndex={0}
                onClick={(e) => openUserCard(m.id, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openUserCard(m.id, e);
                  }
                }}
              >
                <span className="member-avatar">
                  {userAvatarUrlByUserId[String(m.id)] ? (
                    <img alt="" src={userAvatarUrlByUserId[String(m.id)]} />
                  ) : (
                    <span className="avatar-fallback">{(String(m.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                  )}
                </span>
                <div className="member-info">
                  <span className="member-name-line">
                    <b className={slonTeamNickClass(m)}>{m.nickname}</b>
                  </span>
                  <span className="muted presence-line" style={{ fontSize: "12px" }}>
                    <span className="presence-dot presence-dot--online" aria-hidden />
                    Online
                  </span>
                </div>
                {memberRoleBadgeSlot(m.id)}
                {uiMode === "server" && canModerateServerUser(selectedServer, profile?.id) && memberKickSlot(m.id)}
              </div>
            </div>
              ))}

              <div className="members-section-title" style={{ marginTop: "10px" }}>Не в сети — {groupedMembers.offline.length}</div>
              {groupedMembers.offline.map((m) => (
            <div key={m.id} className="member member--interactive">
              <div
                className={`member-row${uiMode === "server" && canModerateServerUser(selectedServer, profile?.id) ? " member-row--mod-tools" : ""}`}
                role="button"
                tabIndex={0}
                onClick={(e) => openUserCard(m.id, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openUserCard(m.id, e);
                  }
                }}
              >
                <span className="member-avatar">
                  {userAvatarUrlByUserId[String(m.id)] ? (
                    <img alt="" src={userAvatarUrlByUserId[String(m.id)]} />
                  ) : (
                    <span className="avatar-fallback">{(String(m.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                  )}
                </span>
                <div className="member-info">
                  <span className="member-name-line">
                    <b className={slonTeamNickClass(m)}>{m.nickname}</b>
                  </span>
                  {(() => {
                    const id = String(m.id);
                    const p = userPresenceByUserId[id] || {};
                    const lastSeen = String(p.lastSeenAtUtc || m.lastSeenAtUtc || "");
                    const s = formatLastSeen(lastSeen);
                    return (
                      <span className="muted presence-line" style={{ fontSize: "12px" }}>
                        <span className="presence-dot presence-dot--offline" aria-hidden />
                        {s ? `был(а) ${s}` : "Offline"}
                      </span>
                    );
                  })()}
                </div>
                {memberRoleBadgeSlot(m.id)}
                {uiMode === "server" && canModerateServerUser(selectedServer, profile?.id) && memberKickSlot(m.id)}
              </div>
            </div>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>

    {serverMenuOpen && selectedServer && (
      <div className="server-menu-backdrop" onClick={() => setServerMenuOpen(false)} role="presentation">
        <div className="server-menu" role="menu" aria-label="Меню сервера" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="server-menu-item" onClick={() => { void copyServerInvite(); setServerMenuOpen(false); }}>
            Приглашение
          </button>
          <button
            type="button"
            className="server-menu-item"
            onClick={() => {
              openNotifSettingsForServer(String(selectedServer.id || ""), String(selectedServer.name || "Сервер"));
              setServerMenuOpen(false);
            }}
          >
            Уведомления…
          </button>
          {canModerateServerUser(selectedServer, profile?.id) && (
            <button
              type="button"
              className="server-menu-item"
              onClick={() => {
                setServerMenuOpen(false);
                void openServerBlacklist();
              }}
            >
              Чёрный список
            </button>
          )}
          {isEffectiveServerOwner(selectedServer, profile?.id) ? (
            <>
              <button
                type="button"
                className="server-menu-item"
                onClick={() => {
                  setRenameServerForm({ name: selectedServer.name || "", description: selectedServer.description || "" });
                  setServerMenuOpen(false);
                  setShowRenameServer(true);
                }}
              >
                Переименовать сервер
              </button>
              <label className="server-menu-item" style={{ cursor: "pointer" }}>
                Изменить аватар сервера
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadServerAvatar(selectedServer.id, f);
                    e.target.value = "";
                    setServerMenuOpen(false);
                  }}
                />
              </label>
              <button
                type="button"
                className="server-menu-item danger"
                onClick={() => { confirmDeleteServer(selectedServer); setServerMenuOpen(false); }}
              >
                Удалить сервер
              </button>
            </>
          ) : (
            <button
              type="button"
              className="server-menu-item"
              onClick={() => { confirmLeaveServer(selectedServer); setServerMenuOpen(false); }}
            >
              Покинуть сервер
            </button>
          )}
        </div>
      </div>
    )}

    {serverBlacklistOpen && selectedServer && (
      <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setServerBlacklistOpen(false)} role="presentation">
        <div className="sheet-panel sheet-panel--center blacklist-modal" role="dialog" aria-modal="true" aria-label="Чёрный список" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>Чёрный список — {selectedServer.name || "Сервер"}</span>
            <button type="button" className="sheet-close" onClick={() => setServerBlacklistOpen(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
          </div>
          <div className="sheet-body">
            {serverBansLoading ? (
              <div className="muted">Загрузка…</div>
            ) : !serverBans.length ? (
              <div className="muted">Забаненных пользователей нет.</div>
            ) : (
              <ul className="blacklist-list">
                {serverBans.map((b) => {
                  const uid = String(b.userId || "");
                  const u = b.user || {};
                  return (
                    <li key={uid} className="blacklist-item">
                      <span className="member-avatar blacklist-item__avatar">
                        {userAvatarUrlByUserId[uid] ? (
                          <img alt="" src={userAvatarUrlByUserId[uid]} />
                        ) : (
                          <span className="avatar-fallback">{(String(u.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                        )}
                      </span>
                      <span className="blacklist-item__name">{u.nickname || uid}</span>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void unbanServerMember(uid)}
                      >
                        Разбанить
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    )}

    {showRenameServer && (
      <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowRenameServer(false)} role="presentation">
        <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>Сервер</span>
            <button type="button" className="sheet-close" onClick={() => setShowRenameServer(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
          </div>
          <div className="sheet-body">
            <input
              className="form-field"
              placeholder="Название сервера"
              value={renameServerForm.name}
              onChange={(e) => setRenameServerForm((p) => ({ ...p, name: e.target.value }))}
            />
            <textarea
              className="form-field form-field--textarea"
              placeholder="Описание (необязательно)"
              rows="3"
              value={renameServerForm.description}
              onChange={(e) => setRenameServerForm((p) => ({ ...p, description: e.target.value }))}
            />
            <div className="row">
              <button type="button" className="small-btn" onClick={saveRenameServer}>Сохранить</button>
              <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowRenameServer(false)}>Отмена</button>
            </div>
          </div>
        </div>
      </div>
    )}

    {showRenameChannel && (
      <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowRenameChannel(false)} role="presentation">
        <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>Канал</span>
            <button type="button" className="sheet-close" onClick={() => setShowRenameChannel(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
          </div>
          <div className="sheet-body">
            <input
              className="form-field"
              placeholder="Новое имя канала"
              value={renameChannelForm.name}
              onChange={(e) => setRenameChannelForm((p) => ({ ...p, name: e.target.value }))}
            />
            <div className="row">
              <button type="button" className="small-btn" onClick={saveRenameChannel}>Сохранить</button>
              <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowRenameChannel(false)}>Отмена</button>
            </div>
          </div>
        </div>
      </div>
    )}

    {notifSettingsModal.open && (
      <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setNotifSettingsModal((p) => ({ ...(p || {}), open: false }))} role="presentation">
        <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>Уведомления · {notifSettingsModal.title || (notifSettingsModal.scope === "dm" ? "ЛС" : "Сервер")}</span>
            <button type="button" className="sheet-close" onClick={() => setNotifSettingsModal((p) => ({ ...(p || {}), open: false }))} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
          </div>
          <div className="sheet-body" style={{ display: "grid", gap: "10px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!notifSettingsModal.sound}
                onChange={(e) => {
                  const sound = !!e.target.checked;
                  const next = { ...notifSettingsModal, sound };
                  setNotifSettingsModal(next);
                  saveNotifSettingsModal(next);
                }}
              />
              <span>Звук уведомлений</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!!notifSettingsModal.banners}
                onChange={(e) => {
                  const banners = !!e.target.checked;
                  const next = { ...notifSettingsModal, banners };
                  setNotifSettingsModal(next);
                  saveNotifSettingsModal(next);
                }}
              />
              <span>Баннеры (системные уведомления)</span>
            </label>
            <div className="muted" style={{ fontSize: "12px", lineHeight: 1.3 }}>
              Звук проигрывается при каждом входящем сообщении. Баннеры показываются, когда вкладка скрыта и браузер разрешил уведомления.
            </div>
          </div>
        </div>
      </div>
    )}

    {(dmCall?.incoming || dmCall?.outgoing) && (
      <div
        className="sheet-backdrop sheet-backdrop--center"
        role="presentation"
        onClick={() => {
          // Do not close by backdrop tap for incoming call (avoid accidental declines).
        }}
      >
        <div className="call-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          {dmCall?.incoming ? (
            <>
              <div className="call-modal__title">Входящий звонок</div>
              <div className="call-modal__sub">От <b>{String(dmCall.incoming.fromNickname || "Пользователь")}</b></div>
              <div className="call-modal__row">
                <button
                  type="button"
                  className="small-btn call-btn-decline"
                  onClick={() => {
                    const inc = dmCall.incoming;
                    try { dmRingtoneRef.current.stopIncoming?.(); } catch { /* ignore */ }
                    dmRingtoneRef.current.stopIncoming = null;
                    setDmCall((p) => ({ ...(p || {}), incoming: null }));
                    api(`/dm/${String(inc.channelId)}/call/respond`, { method: "POST", body: JSON.stringify({ callId: String(inc.callId), action: "decline", toUserId: String(inc.fromUserId) }) }).catch(() => {});
                  }}
                >
                  Отклонить
                </button>
                <button
                  type="button"
                  className="small-btn call-btn-accept"
                  onClick={() => {
                    const inc = dmCall.incoming;
                    try { dmRingtoneRef.current.stopIncoming?.(); } catch { /* ignore */ }
                    dmRingtoneRef.current.stopIncoming = null;
                    setDmCall((p) => ({ ...(p || {}), incoming: null }));
                    api(`/dm/${String(inc.channelId)}/call/respond`, { method: "POST", body: JSON.stringify({ callId: String(inc.callId), action: "accept", toUserId: String(inc.fromUserId) }) }).catch(() => {});
                    dmActiveCallSessionRef.current = { callId: String(inc.callId), channelId: String(inc.channelId), state: "active" };
                    setUiMode("dm");
                    selectTextChannel(String(inc.channelId), "dm");
                    if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
                    connectVoiceToChannel(String(inc.channelId), { suppressJoinSfx: true }).catch(() => {});
                  }}
                >
                  Принять
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="call-modal__title">Звонок…</div>
              <div className="call-modal__sub">Вызываю <b>{String(dmCall?.outgoing?.toNickname || "…")}</b></div>
              <div className="call-modal__row">
                <button
                  type="button"
                  className="small-btn call-btn-decline"
                  onClick={() => {
                    const out = dmCall.outgoing;
                    if (!out) return;
                    try { dmRingtoneRef.current.stopOutgoing?.(); } catch { /* ignore */ }
                    dmRingtoneRef.current.stopOutgoing = null;
                    setDmCall((p) => ({ ...(p || {}), outgoing: null }));
                    api(`/dm/${String(out.channelId)}/call/cancel`, { method: "POST", body: JSON.stringify({ callId: String(out.callId) }) }).catch(() => {});
                    try { if (String(activeVoiceChannelId) === String(out.channelId)) leaveVoice(); } catch { /* ignore */ }
                  }}
                >
                  Отменить
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )}

    {String(messageMenu?.openForId || "") && messageMenuMsg && (
      <div
        className="message-menu message-menu--fixed"
        ref={messageMenuRef}
        role="menu"
        aria-label="Меню сообщения"
        style={{
          top: `${Math.max(8, Number(messageMenu?.y || 0) + 6)}px`,
          left: `${Math.max(8, Number(messageMenu?.x || 0))}px`
        }}
      >
        <button
          type="button"
          className="message-menu__item"
          role="menuitem"
          onClick={() => {
            setMessageMenu({ openForId: "" });
            beginReplyDraft({
              id: String(messageMenuMsg.id),
              senderNickname: String(messageMenuMsg.senderNickname || ""),
              text: String(messageMenuMsg.text || ""),
              firstAttachment: (Array.isArray(messageMenuMsg.attachments) && messageMenuMsg.attachments.length > 0) ? messageMenuMsg.attachments[0] : (messageMenuMsg.file || null)
            });
          }}
        >
          <span className="message-menu__label">Ответить</span>
          <span className="message-menu__icon" aria-hidden><SlonIcon name="reply" size={16} /></span>
        </button>

        <button
          type="button"
          className="message-menu__item"
          role="menuitem"
          onClick={() => {
            setMessageMenu({ openForId: "" });
            setForwardModal({
              open: true,
              query: "",
              selectedIds: {},
              source: messageMenuMsg
            });
          }}
        >
          <span className="message-menu__label">Переслать</span>
          <span className="message-menu__icon" aria-hidden><SlonIcon name="forward" size={16} /></span>
        </button>

        {String(messageMenuMsg.senderUserId) !== String(profile?.id) && !messageMenuMsg.isDeleted && (
          <button
            type="button"
            className="message-menu__item danger"
            role="menuitem"
            onClick={() => {
              setMessageMenu({ openForId: "" });
              setReportModal({ open: true, messageId: String(messageMenuMsg.id), reason: "" });
            }}
          >
            <span className="message-menu__label">Пожаловаться</span>
            <span className="message-menu__icon" aria-hidden>⚑</span>
          </button>
        )}

        {String(messageMenuMsg.senderUserId) === String(profile?.id) && (
          <button
            type="button"
            className="message-menu__item"
            role="menuitem"
            onClick={() => {
              setMessageMenu({ openForId: "" });
              startEditMessage(messageMenuMsg);
            }}
          >
            <span className="message-menu__label">Редактировать</span>
            <span className="message-menu__icon" aria-hidden>✎</span>
          </button>
        )}

        {(String(messageMenuMsg.senderUserId) === String(profile?.id)
          || (uiMode === "server" && canModerateServerUser(selectedServer, profile?.id))) && (
          <button
            type="button"
            className="message-menu__item danger"
            role="menuitem"
            onClick={() => {
              setMessageMenu({ openForId: "" });
              confirmDeleteMessage(messageMenuMsg);
            }}
          >
            <span className="message-menu__label">Удалить</span>
            <span className="message-menu__icon" aria-hidden><SlonIcon name="trash" size={16} /></span>
          </button>
        )}
      </div>
    )}

    {channelsContextMenu.open && canModerateServerUser(selectedServer, profile?.id) && (
      <div
        className="message-menu message-menu--fixed"
        ref={channelsContextMenuRef}
        role="menu"
        aria-label="Меню каналов"
        style={{
          top: `${Math.max(8, channelsContextMenu.y)}px`,
          left: `${Math.max(8, channelsContextMenu.x)}px`,
        }}
      >
        <button
          type="button"
          className="message-menu__item"
          role="menuitem"
          onClick={() => {
            closeChannelsContextMenu();
            setShowCreateCategory(true);
          }}
        >
          <span className="message-menu__label">Создать категорию</span>
        </button>
        <button
          type="button"
          className="message-menu__item"
          role="menuitem"
          onClick={() => {
            closeChannelsContextMenu();
            setPendingChannelCategoryId("");
            setShowCreateTextChannel(true);
          }}
        >
          <span className="message-menu__label">Создать текстовый канал</span>
        </button>
        <button
          type="button"
          className="message-menu__item"
          role="menuitem"
          onClick={() => {
            closeChannelsContextMenu();
            setPendingChannelCategoryId("");
            setShowCreateVoiceChannel(true);
          }}
        >
          <span className="message-menu__label">Создать голосовой канал</span>
        </button>
      </div>
    )}

    {String(channelMenu?.openForId || "") && (
      <div
        className="message-menu message-menu--fixed"
        ref={channelMenuRef}
        role="menu"
        aria-label="Меню канала"
        style={{
          top: `${Math.max(8, Number(channelMenu?.y || 0) + 6)}px`,
          left: `${Math.max(8, Number(channelMenu?.x || 0))}px`
        }}
      >
        {String(channelMenu.openForId || "").startsWith("cat:") ? (
          <>
            <button
              type="button"
              className="message-menu__item"
              role="menuitem"
              onClick={() => {
                const catId = String(channelMenu.openForId || "").slice(4);
                setChannelMenu({ openForId: "", x: 0, y: 0 });
                openCreateVoiceInCategory(catId);
              }}
            >
              <span className="message-menu__label">Создать голосовой канал</span>
            </button>
            <button
              type="button"
              className="message-menu__item"
              role="menuitem"
              onClick={() => {
                const catId = String(channelMenu.openForId || "").slice(4);
                setChannelMenu({ openForId: "", x: 0, y: 0 });
                openCreateTextInCategory(catId);
              }}
            >
              <span className="message-menu__label">Создать текстовый канал</span>
            </button>
            {String(channelMenu.openForId || "").slice(4) ? (
              <>
                {(() => {
                  const catId = String(channelMenu.openForId || "").slice(4);
                  const cat = (selectedServer?.categories || []).find((c) => String(c?.id) === catId);
                  if (!cat?.isPrivate) {
                    return (
                      <button
                        type="button"
                        className="message-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setChannelMenu({ openForId: "", x: 0, y: 0 });
                          void setCategoryPrivate(catId, true);
                        }}
                      >
                        <span className="message-menu__label">Сделать приватной</span>
                        <span className="message-menu__icon" aria-hidden><SlonIcon name="lock" size={16} /></span>
                      </button>
                    );
                  }
                  return (
                    <>
                      <button
                        type="button"
                        className="message-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setChannelMenu({ openForId: "", x: 0, y: 0 });
                          if (cat) void openCategoryAccessModal(cat);
                        }}
                      >
                        <span className="message-menu__label">Доступ к категории</span>
                        <span className="message-menu__icon" aria-hidden><SlonIcon name="lock" size={16} /></span>
                      </button>
                      <button
                        type="button"
                        className="message-menu__item"
                        role="menuitem"
                        onClick={() => {
                          setChannelMenu({ openForId: "", x: 0, y: 0 });
                          void setCategoryPrivate(catId, false);
                        }}
                      >
                        <span className="message-menu__label">Сделать публичной</span>
                      </button>
                    </>
                  );
                })()}
                <button
                  type="button"
                  className="message-menu__item"
                  role="menuitem"
                  onClick={() => {
                    const catId = String(channelMenu.openForId || "").slice(4);
                    const cat = (selectedServer?.categories || []).find((c) => String(c?.id) === catId);
                    setChannelMenu({ openForId: "", x: 0, y: 0 });
                    setRenameCategoryForm({ id: catId, name: String(cat?.name || "") });
                    setShowRenameCategory(true);
                  }}
                >
                  <span className="message-menu__label">Редактировать категорию</span>
                </button>
                <button
                  type="button"
                  className="message-menu__item danger"
                  role="menuitem"
                  onClick={() => {
                    const catId = String(channelMenu.openForId || "").slice(4);
                    const cat = (selectedServer?.categories || []).find((c) => String(c?.id) === catId);
                    setChannelMenu({ openForId: "", x: 0, y: 0 });
                    if (cat) confirmDeleteCategory(cat);
                  }}
                >
                  <span className="message-menu__label">Удалить категорию</span>
                </button>
              </>
            ) : null}
          </>
        ) : String(channelMenu.openForId || "").startsWith("dm:") ? (
          <button
            type="button"
            className="message-menu__item danger"
            role="menuitem"
            onClick={() => {
              const id = String(channelMenu.openForId || "").slice(3);
              const ch = (dmChannelsRef.current || []).find((c) => String(c?.id) === id);
              setChannelMenu({ openForId: "", x: 0, y: 0 });
              if (ch) confirmDeleteDmChannel(ch);
            }}
          >
            <span className="message-menu__label">Удалить чат</span>
            <span className="message-menu__icon" aria-hidden><SlonIcon name="trash" size={16} /></span>
          </button>
        ) : (
          <>
        <button
          type="button"
          className="message-menu__item"
          role="menuitem"
          onClick={() => {
            const id = String(channelMenu.openForId || "");
            if (!id) return;
            const ch = (channelsRef.current || []).find((c) => String(c?.id || "") === id);
            setChannelMenu({ openForId: "", x: 0, y: 0 });
            setRenameChannelForm({ id, name: String(ch?.name || "") });
            setShowRenameChannel(true);
          }}
        >
          <span className="message-menu__label">Редактировать</span>
          <span className="message-menu__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm2.92 2.83H5v-.92l8.06-8.06.92.92L5.92 20.08zM20.71 7.04a1 1 0 0 0 0-1.41L18.37 3.29a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
          </span>
        </button>

        {(() => {
          const id = String(channelMenu.openForId || "");
          const ch = (channelsRef.current || []).find((c) => String(c?.id || "") === id);
          if (!ch?.isPrivate || !canManageServerChannel(ch, selectedServer, profile?.id)) return null;
          return (
            <button
              type="button"
              className="message-menu__item"
              role="menuitem"
              onClick={() => {
                setChannelMenu({ openForId: "", x: 0, y: 0 });
                void openChannelAccessModal(ch);
              }}
            >
              <span className="message-menu__label">Доступ к каналу</span>
              <span className="message-menu__icon" aria-hidden><SlonIcon name="lock" size={16} /></span>
            </button>
          );
        })()}

        <button
          type="button"
          className="message-menu__item danger"
          role="menuitem"
          onClick={() => {
            const id = String(channelMenu.openForId || "");
            if (!id) return;
            const ch = (channelsRef.current || []).find((c) => String(c?.id || "") === id);
            setChannelMenu({ openForId: "", x: 0, y: 0 });
            if (ch) confirmDeleteChannel(ch);
          }}
        >
          <span className="message-menu__label">Удалить</span>
          <span className="message-menu__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z"/>
            </svg>
          </span>
        </button>
          </>
        )}
      </div>
    )}

    {mediaLightbox.open && (
      <div
        className="media-lightbox"
        role="dialog"
        aria-modal="true"
        onClick={() => {
          void exitFullscreenBeforeCloseLightbox().finally(() => {
            setMediaLightbox((s) => ({ ...s, open: false }));
          });
        }}
      >
        <div
          ref={mediaLightboxInnerRef}
          className="media-lightbox__inner"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="media-lightbox__close"
            onClick={() => {
              void exitFullscreenBeforeCloseLightbox().finally(() => {
                setMediaLightbox((s) => ({ ...s, open: false }));
              });
            }}
            aria-label="Закрыть"
          >
            <SlonIcon name="close" size={18} />
          </button>
          {mediaLightbox.fileId && (
            <button
              type="button"
              className="media-lightbox__dl"
              onClick={() => {
                if (mediaLightbox.fileId) {
                  void downloadFile(mediaLightbox.fileId, mediaLightbox.name || "file");
                }
              }}
            >
              Скачать
            </button>
          )}
          {mediaLightbox.kind === "video" ? (
            <>
              <button
                type="button"
                className="media-lightbox__fs"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleMediaLightboxFullscreen();
                }}
                aria-label="На весь экран"
                title="На весь экран"
              >
                <SlonIcon name="expand" size={16} />
              </button>
              <video
                ref={mediaLightboxVideoRef}
                src={mediaLightbox.dataUrl}
                className="media-lightbox__media media-lightbox__media--video"
                controls
                controlsList="nofullscreen"
                autoPlay
                playsInline
              />
            </>
          ) : (
            <img src={mediaLightbox.dataUrl} alt="" className="media-lightbox__media" />
          )}
        </div>
      </div>
    )}

    {reportModal.open && (
      <div
        className="sheet-backdrop sheet-backdrop--center"
        onClick={closeReportModal}
        role="presentation"
      >
        <div
          className="sheet-panel sheet-panel--center"
          role="dialog"
          aria-modal="true"
          aria-label="Пожаловаться на сообщение"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sheet-header">
            <span>Пожаловаться</span>
            <button type="button" className="sheet-close" onClick={closeReportModal} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
          </div>
          <div className="sheet-body">
            <div className="muted" style={{ fontSize: "13px", lineHeight: 1.35, marginBottom: "10px" }}>
              Опишите причину жалобы. Поле необязательное.
            </div>
            <textarea
              className="form-field"
              placeholder="Причина жалобы (необязательно)"
              value={reportModal.reason}
              onChange={(e) => setReportModal((p) => ({ ...p, reason: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submitReportMessage();
                }
              }}
              rows={4}
              autoFocus
            />
            <div className="row" style={{ marginTop: "12px", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={closeReportModal}>
                Отмена
              </button>
              <button type="button" className="small-btn" style={{ background: "var(--danger)" }} onClick={() => void submitReportMessage()}>
                Отправить
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {confirmModal.open && (
      <div
        className="sheet-backdrop sheet-backdrop--center"
        onClick={() => setConfirmModal((s) => ({ ...s, open: false, checkbox: null }))}
        role="presentation"
      >
        <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>{confirmModal.title || "Подтвердите действие"}</span>
            <button
              type="button"
              className="sheet-close"
              onClick={() => setConfirmModal((s) => ({ ...s, open: false, checkbox: null }))}
              aria-label="Закрыть"
            >
              <SlonIcon name="close" size={18} />
            </button>
          </div>
          <div className="sheet-body">
            <div style={{ lineHeight: 1.35, marginBottom: "12px" }}>{confirmModal.message}</div>
            {confirmModal.checkbox && (
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={!!confirmModal.checkbox.checked}
                  onChange={(e) =>
                    setConfirmModal((s) =>
                      s.checkbox
                        ? { ...s, checkbox: { ...s.checkbox, checked: e.target.checked } }
                        : s
                    )
                  }
                />
                <span>{confirmModal.checkbox.label}</span>
              </label>
            )}
            <div className="row">
              <button
                type="button"
                className="small-btn"
                style={{ background: "var(--danger)" }}
                onClick={async () => {
                  const fn = confirmActionRef.current;
                  const payload = confirmModal.checkbox
                    ? { deleteForPeer: !!confirmModal.checkbox.checked }
                    : undefined;
                  setConfirmModal((s) => ({ ...s, open: false, checkbox: null }));
                  confirmActionRef.current = null;
                  try {
                    await fn?.(payload);
                  } catch (e) {
                    setError(e.message || String(e));
                  }
                }}
              >
                {confirmModal.confirmText || "Удалить"}
              </button>
              <button
                type="button"
                className="small-btn"
                style={{ background: "#4a4f57" }}
                onClick={() => setConfirmModal((s) => ({ ...s, open: false, checkbox: null }))}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {forwardModal.open && (
      <div
        className="sheet-backdrop sheet-backdrop--center"
        onClick={() => setForwardModal({ open: false, query: "", selectedIds: {}, source: null })}
        role="presentation"
      >
        <div className="sheet-panel sheet-panel--center forward-panel" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>Переслать сообщение</span>
            <button
              type="button"
              className="sheet-close"
              onClick={() => setForwardModal({ open: false, query: "", selectedIds: {}, source: null })}
              aria-label="Закрыть"
            >
              <SlonIcon name="close" size={18} />
            </button>
          </div>
          <div className="sheet-body">
            <input
              className="form-field"
              placeholder="Поиск чатов"
              value={String(forwardModal.query || "")}
              onChange={(e) => setForwardModal((s) => ({ ...s, query: e.target.value }))}
              autoFocus
            />
            <div className="forward-list" role="list">
              {forwardTargets
                .filter((t) => {
                  const q = String(forwardModal.query || "").trim().toLowerCase();
                  if (!q) return true;
                  return `${t.label} ${t.sublabel}`.toLowerCase().includes(q);
                })
                .map((t) => (
                  <label key={t.key} className="forward-item" role="listitem">
                    <input
                      type="checkbox"
                      checked={!!forwardModal.selectedIds?.[t.key]}
                      onChange={(e) => setForwardModal((s) => ({ ...s, selectedIds: { ...(s.selectedIds || {}), [t.key]: e.target.checked } }))}
                    />
                    <div className="forward-item__meta">
                      <div className="forward-item__label">{t.label}</div>
                      <div className="forward-item__sub">{t.sublabel}</div>
                    </div>
                  </label>
                ))}
            </div>
            <div className="row" style={{ marginTop: "12px", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="small-btn"
                style={{ background: "#4a4f57" }}
                onClick={() => setForwardModal({ open: false, query: "", selectedIds: {}, source: null })}
              >
                Отмена
              </button>
              <button type="button" className="small-btn" onClick={() => void submitForward()}>
                Переслать
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {showNewDmModal && (
      <div
        className="sheet-backdrop sheet-backdrop--center"
        onClick={() => {
          setShowNewDmModal(false);
          setInviteNickname("");
        }}
        role="presentation"
      >
        <div
          className="sheet-panel sheet-panel--center"
          role="dialog"
          aria-modal="true"
          aria-label="Новый личный чат"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sheet-header">
            <div className="sheet-title">Новый личный чат</div>
            <button
              type="button"
              className="sheet-close"
              onClick={() => {
                setShowNewDmModal(false);
                setInviteNickname("");
              }}
              aria-label="Закрыть"
            >
              <SlonIcon name="close" size={18} />
            </button>
          </div>
          <div className="sheet-body">
            <input
              className="form-field"
              placeholder="Никнейм"
              value={inviteNickname}
              onChange={(e) => setInviteNickname(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void startDmByNickname();
                }
              }}
              autoFocus
            />
            <div className="row" style={{ marginTop: "12px", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                className="small-btn"
                style={{ background: "#4a4f57" }}
                onClick={() => {
                  setShowNewDmModal(false);
                  setInviteNickname("");
                }}
              >
                Отмена
              </button>
              <button type="button" className="small-btn" onClick={() => void startDmByNickname()}>
                Написать
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {showEditProfile && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.5)",
          display: "grid",
          placeItems: "center",
          zIndex: 180,
          padding: "16px",
          paddingTop: "max(16px, env(safe-area-inset-top, 0px))"
        }}>
          <div className="auth-card" style={{ maxHeight: "90dvh", overflow: "auto" }}>
            <h2>Редактирование профиля</h2>
            <div className="profile-avatar-edit">
              <div className="avatar avatar--lg">
                {userAvatarUrlByUserId[String(profile?.id)] ? (
                  <img alt="" src={userAvatarUrlByUserId[String(profile?.id)]} />
                ) : (
                  <span>{(profile?.nickname || "?").trim().slice(0, 1).toUpperCase()}</span>
                )}
              </div>
              <label className="small-btn" style={{ display: "inline-flex", alignItems: "center" }}>
                Загрузить аватар
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadMyAvatar(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <input
              placeholder="Nickname"
              value={editForm.nickname}
              onChange={(e) => setEditForm({ ...editForm, nickname: e.target.value })}
            />
            <textarea
              placeholder="О себе"
              rows="4"
              value={editForm.bio}
              onChange={(e) => setEditForm({ ...editForm, bio: e.target.value })}
            />

            <div className="panel-header--sub" style={{ marginTop: "10px" }}>Сменить пароль</div>
            <input
              placeholder="Текущий пароль"
              type="password"
              value={pwdForm.current}
              onChange={(e) => setPwdForm((p) => ({ ...p, current: e.target.value }))}
            />
            <input
              placeholder="Новый пароль"
              type="password"
              value={pwdForm.next}
              onChange={(e) => { setPwdTouched(true); setPwdForm((p) => ({ ...p, next: e.target.value })); }}
              style={{
                border: pwdTouched && pwdForm.next && pwdForm.confirm
                  ? (pwdForm.next === pwdForm.confirm ? "1px solid rgba(35, 165, 89, 0.9)" : "1px solid rgba(218, 55, 60, 0.9)")
                  : undefined
              }}
            />
            <input
              placeholder="Повторите новый пароль"
              type="password"
              value={pwdForm.confirm}
              onChange={(e) => { setPwdTouched(true); setPwdForm((p) => ({ ...p, confirm: e.target.value })); }}
              style={{
                border: pwdTouched && pwdForm.next && pwdForm.confirm
                  ? (pwdForm.next === pwdForm.confirm ? "1px solid rgba(35, 165, 89, 0.9)" : "1px solid rgba(218, 55, 60, 0.9)")
                  : undefined
              }}
            />
            {pwdTouched && pwdForm.next && pwdForm.confirm && pwdForm.next !== pwdForm.confirm && (
              <div className="danger" style={{ marginTop: "-6px", marginBottom: "6px" }}>пароли должны совпадать</div>
            )}
            <div className="row">
              <button className="small-btn" onClick={saveProfile}>Сохранить</button>
              <button className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowEditProfile(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}

      {membersSheet && isNarrow && (
        <div className="sheet-backdrop" onClick={closeMembersSheet} role="presentation">
          <div
            className="sheet-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="members-sheet-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <span id="members-sheet-title">{uiMode === "dm" ? "Собеседник" : "Участники"}</span>
              <button type="button" className="sheet-close" onClick={closeMembersSheet} aria-label="Закрыть">
                <SlonIcon name="close" size={16} />
              </button>
            </div>
            <div className="sheet-body members-list">
              <div className="members-section-title">В сети — {groupedMembers.online.length}</div>
              {groupedMembers.online.map((m) => (
                <div key={m.id} className="member">
                  <div className="member-row">
                    <span className="member-avatar">
                      {userAvatarUrlByUserId[String(m.id)] ? (
                        <img alt="" src={userAvatarUrlByUserId[String(m.id)]} />
                      ) : (
                        <span className="avatar-fallback">{(String(m.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                      )}
                    </span>
                    <div><b className={slonTeamNickClass(m)}>{m.nickname}</b></div>
                  </div>
                </div>
              ))}

              <div className="members-section-title" style={{ marginTop: "10px" }}>Не в сети — {groupedMembers.offline.length}</div>
              {groupedMembers.offline.map((m) => (
                <div key={m.id} className="member">
                  <div className="member-row">
                    <span className="member-avatar">
                      {userAvatarUrlByUserId[String(m.id)] ? (
                        <img alt="" src={userAvatarUrlByUserId[String(m.id)]} />
                      ) : (
                        <span className="avatar-fallback">{(String(m.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}</span>
                      )}
                    </span>
                    <div><b className={slonTeamNickClass(m)}>{m.nickname}</b></div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

    {screenView.open && (
        <div
          ref={screenOverlayRef}
          className={`screen-overlay ${screenView.mode === "window" ? "screen-overlay--window" : "screen-overlay--full"}${screenIsFullscreen ? " is-native-fullscreen" : ""}`}
          role="dialog"
          aria-modal="true"
          style={screenView.mode === "window" ? { left: `${screenWindowPos.x || 16}px`, top: `${screenWindowPos.y || 16}px` } : undefined}
        >
          {screenView.mode === "window" && (
            <div
              className="screen-drag-handle"
              onPointerDown={onScreenDragStart}
              onPointerMove={onScreenDragMove}
              onPointerUp={onScreenDragEnd}
              onPointerCancel={onScreenDragEnd}
              role="button"
              tabIndex={0}
              aria-label="Переместить окно демонстрации"
              title="Перетащить"
            >
              <span className="screen-drag-dot" />
              <span className="screen-drag-dot" />
              <span className="screen-drag-dot" />
            </div>
          )}

          <div
            className="screen-surface"
            onMouseMove={() => showScreenControlsAndSchedule()}
            onPointerDown={(e) => {
              // Show controls on any interaction, but ignore taps on buttons.
              showScreenControlsAndSchedule();
              try {
                const tag = String(e?.target?.tagName || "").toLowerCase();
                if (tag === "button") return;
                if (e?.target?.closest?.("button")) return;
              } catch { /* ignore */ }

              // Double-tap for touch devices (Discord-like). Only when not dragging.
              if (String(e.pointerType || "") === "touch") {
                const now = Date.now();
                const prev = lastScreenTapRef.current || { at: 0, x: 0, y: 0 };
                const dx = Math.abs((e.clientX || 0) - (prev.x || 0));
                const dy = Math.abs((e.clientY || 0) - (prev.y || 0));
                if (now - (prev.at || 0) < 320 && dx < 30 && dy < 30) {
                  toggleScreenViewMode();
                  lastScreenTapRef.current = { at: 0, x: 0, y: 0 };
                  return;
                }
                lastScreenTapRef.current = { at: now, x: e.clientX || 0, y: e.clientY || 0 };
              }
            }}
            onFocusCapture={() => showScreenControlsAndSchedule()}
            onDoubleClick={(e) => {
              try {
                const tag = String(e?.target?.tagName || "").toLowerCase();
                if (tag === "button") return;
                if (e?.target?.closest?.("button")) return;
              } catch { /* ignore */ }
              toggleScreenViewMode();
            }}
          >
            <video ref={screenVideoRef} className="screen-video" autoPlay playsInline />

            <div
              className={`screen-controls ${screenControlsVisible ? "" : "is-hidden"}`}
              role="toolbar"
              aria-label="Управление демонстрацией экрана"
              onMouseEnter={() => showScreenControlsAndSchedule()}
            >
              <button
                type="button"
                className={`user-voice-btn ${voiceState.muted ? "is-off" : ""}`}
                onClick={toggleMic}
                title={voiceState.muted ? "Включить микрофон" : "Выключить микрофон"}
                aria-pressed={voiceState.muted}
              >
                <SlonIcon name={voiceState.muted ? "mic-off" : "mic"} size={18} />
              </button>
              <button
                type="button"
                className={`user-voice-btn ${voiceState.deafened ? "is-off" : ""}`}
                onClick={toggleDeafen}
                title={voiceState.deafened ? "Включить звук" : "Режим без звука"}
                aria-pressed={voiceState.deafened}
              >
                <SlonIcon name={voiceState.deafened ? "headphones-off" : "headphones"} size={18} />
              </button>
              {screenView?.peerId ? (
                <input
                  type="range"
                  min="0"
                  max="300"
                  defaultValue="100"
                  onChange={(e) => {
                    const v = Math.max(0, Math.min(300, Number(e.target.value) || 0));
                    try { voiceRef.current?.setScreenAudioVolume?.(String(screenView.peerId), v); } catch { /* ignore */ }
                  }}
                  title="Громкость звука демонстрации"
                  aria-label="Громкость звука демонстрации"
                  style={{ width: "120px" }}
                />
              ) : null}
              <div className="screen-controls__spacer" aria-hidden="true" />
              <button
                type="button"
                className="user-voice-btn"
                onClick={() => { void toggleNativeFullscreen(); }}
                title={screenIsFullscreen ? "Выйти из полноэкранного режима" : "Полноэкранный режим (на весь монитор)"}
                aria-label={screenIsFullscreen ? "Выйти из полноэкранного режима" : "Полноэкранный режим (на весь монитор)"}
              >
                {screenIsFullscreen ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M7 14H5v5h5v-2H7v-3Zm0-4h2V7h3V5H5v5Zm10 9h-3v-2h3v-3h2v5h-2Zm0-14V5h-5v2h3v3h2Z"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M7 14H5v5h5v-2H7v-3Zm12 5h-5v-2h3v-3h2v5ZM7 10h2V7h3V5H5v5Zm12-5v5h-2V7h-3V5h5Z"/>
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="user-voice-btn"
                onClick={toggleScreenViewMode}
                title={screenView.mode === "full" ? "Свернуть в окно" : "На весь экран"}
                aria-label={screenView.mode === "full" ? "Свернуть в окно" : "На весь экран"}
              >
                {screenView.mode === "full" ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M19 7H5v10h14V7Zm2-2v14H3V5h18Z"/>
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M19 7H5v10h14V7Zm2-2v14H3V5h18Zm-6 3h3v3h-2V9h-1V8ZM9 16H8v-1H6v-2h3v3Z"/>
                  </svg>
                )}
              </button>
              <button
                type="button"
                className="screen-controls__close"
                onClick={closeScreenView}
                title="Отключиться от демонстрации"
                aria-label="Отключиться от демонстрации"
              >
                <SlonIcon name="close" size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

    {showCreateServer && (
        <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowCreateServer(false)} role="presentation">
          <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <span>Новый сервер</span>
              <button type="button" className="sheet-close" onClick={() => setShowCreateServer(false)} aria-label="Закрыть">
                <SlonIcon name="close" size={16} />
              </button>
            </div>
            <div className="sheet-body">
              <input
                placeholder="Название сервера"
                className="form-field"
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
              />
              <textarea
                placeholder="Описание сервера"
                rows="3"
                className="form-field form-field--textarea"
                value={newServerDescription}
                onChange={(e) => setNewServerDescription(e.target.value)}
              />
              <div className="row">
                <button type="button" className="small-btn" onClick={createNewServer}>Создать</button>
                <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowCreateServer(false)}>Отмена</button>
              </div>
            </div>
          </div>
        </div>
      )}

    {showCreateTextChannel && (
        <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowCreateTextChannel(false)} role="presentation">
          <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <span>Новый текстовый канал</span>
              <button type="button" className="sheet-close" onClick={() => setShowCreateTextChannel(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
            </div>
            <div className="sheet-body">
              <input
                placeholder="Название канала"
                className="form-field"
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createChannel(newChannelName);
                  }
                }}
              />
              {canModerateServerUser(selectedServer, profile?.id) && (() => {
                const pendingCat = (selectedServer?.categories || []).find(
                  (c) => String(c?.id) === String(pendingChannelCategoryId)
                );
                if (pendingCat?.isPrivate) {
                  return (
                    <p className="muted" style={{ marginTop: 8, fontSize: "0.85rem" }}>
                      Категория приватная — новый канал унаследует её доступ.
                    </p>
                  );
                }
                return (
                  <label className="confirm-check" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={newChannelPrivate} onChange={(e) => setNewChannelPrivate(e.target.checked)} />
                    <span>Приватный канал (доступ выдаётся вручную)</span>
                  </label>
                );
              })()}
              <div className="row">
                <button type="button" className="small-btn" onClick={() => createChannel(newChannelName)}>Создать</button>
                <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowCreateTextChannel(false)}>Отмена</button>
              </div>
            </div>
          </div>
        </div>
      )}

    {channelAccessModal.open && (
        <div
          className="sheet-backdrop sheet-backdrop--center"
          role="presentation"
          onClick={() => {
            if (!channelAccessModal.saving) {
              setChannelAccessModal({
                open: false,
                channelId: "",
                channelName: "",
                loading: false,
                saving: false,
                serverMembers: [],
                selectedUserIds: new Set(),
                initialMemberIds: new Set(),
              });
            }
          }}
        >
          <div
            className="sheet-panel sheet-panel--center channel-access-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Доступ к каналу"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <span>Доступ к каналу — {channelAccessModal.channelName || "…"}</span>
              <button
                type="button"
                className="sheet-close"
                aria-label="Закрыть"
                disabled={channelAccessModal.saving}
                onClick={() => setChannelAccessModal({
                  open: false,
                  channelId: "",
                  channelName: "",
                  loading: false,
                  saving: false,
                  serverMembers: [],
                  selectedUserIds: new Set(),
                  initialMemberIds: new Set(),
                })}
              >
                <SlonIcon name="close" size={16} />
              </button>
            </div>
            <div className="sheet-body">
              {channelAccessModal.loading ? (
                <div className="muted">Загрузка участников…</div>
              ) : (
                <div className="channel-access-list">
                  {(channelAccessModal.serverMembers || []).map((m) => {
                    const uid = String(m?.id || "");
                    const checked = channelAccessModal.selectedUserIds instanceof Set
                      ? channelAccessModal.selectedUserIds.has(uid)
                      : false;
                    return (
                      <label key={uid} className="channel-access-row confirm-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleChannelAccessUser(uid)}
                        />
                        <span className="channel-access-row__avatar">
                          {userAvatarUrlByUserId[uid] ? (
                            <img alt="" src={userAvatarUrlByUserId[uid]} />
                          ) : (
                            <span className="avatar-fallback">
                              {(String(m?.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}
                            </span>
                          )}
                        </span>
                        <span className="channel-access-row__name">{m?.nickname || "…"}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="small-btn"
                  disabled={channelAccessModal.loading || channelAccessModal.saving}
                  onClick={() => { void saveChannelAccessModal(); }}
                >
                  {channelAccessModal.saving ? "Сохранение…" : "Сохранить"}
                </button>
                <button
                  type="button"
                  className="small-btn"
                  style={{ background: "#4a4f57" }}
                  disabled={channelAccessModal.saving}
                  onClick={() => setChannelAccessModal({
                    open: false,
                    channelId: "",
                    channelName: "",
                    loading: false,
                    saving: false,
                    serverMembers: [],
                    selectedUserIds: new Set(),
                    initialMemberIds: new Set(),
                  })}
                >
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    {categoryAccessModal.open && (
        <div
          className="sheet-backdrop sheet-backdrop--center"
          role="presentation"
          onClick={() => {
            if (!categoryAccessModal.saving) {
              setCategoryAccessModal({
                open: false,
                categoryId: "",
                categoryName: "",
                loading: false,
                saving: false,
                serverMembers: [],
                selectedUserIds: new Set(),
                initialMemberIds: new Set(),
              });
            }
          }}
        >
          <div
            className="sheet-panel sheet-panel--center channel-access-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Доступ к категории"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-header">
              <span>Доступ к категории — {categoryAccessModal.categoryName || "…"}</span>
              <button
                type="button"
                className="sheet-close"
                aria-label="Закрыть"
                disabled={categoryAccessModal.saving}
                onClick={() => setCategoryAccessModal({
                  open: false,
                  categoryId: "",
                  categoryName: "",
                  loading: false,
                  saving: false,
                  serverMembers: [],
                  selectedUserIds: new Set(),
                  initialMemberIds: new Set(),
                })}
              >
                <SlonIcon name="close" size={16} />
              </button>
            </div>
            <div className="sheet-body">
              {categoryAccessModal.loading ? (
                <div className="muted">Загрузка участников…</div>
              ) : (
                <div className="channel-access-list">
                  {(categoryAccessModal.serverMembers || []).map((m) => {
                    const uid = String(m?.id || "");
                    const checked = categoryAccessModal.selectedUserIds instanceof Set
                      ? categoryAccessModal.selectedUserIds.has(uid)
                      : false;
                    return (
                      <label key={uid} className="channel-access-row confirm-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCategoryAccessUser(uid)}
                        />
                        <span className="channel-access-row__avatar">
                          {userAvatarUrlByUserId[uid] ? (
                            <img alt="" src={userAvatarUrlByUserId[uid]} />
                          ) : (
                            <span className="avatar-fallback">
                              {(String(m?.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}
                            </span>
                          )}
                        </span>
                        <span className="channel-access-row__name">{m?.nickname || "…"}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <div className="row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="small-btn"
                  disabled={categoryAccessModal.loading || categoryAccessModal.saving}
                  onClick={() => { void saveCategoryAccessModal(); }}
                >
                  {categoryAccessModal.saving ? "Сохранение…" : "Сохранить"}
                </button>
                <button
                  type="button"
                  className="small-btn"
                  style={{ background: "#4a4f57" }}
                  disabled={categoryAccessModal.saving}
                  onClick={() => setCategoryAccessModal({
                    open: false,
                    categoryId: "",
                    categoryName: "",
                    loading: false,
                    saving: false,
                    serverMembers: [],
                    selectedUserIds: new Set(),
                    initialMemberIds: new Set(),
                  })}
                >
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    {showRenameCategory && (
        <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowRenameCategory(false)} role="presentation">
          <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <span>Редактировать категорию</span>
              <button type="button" className="sheet-close" onClick={() => setShowRenameCategory(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
            </div>
            <div className="sheet-body">
              <input
                placeholder="Название категории"
                className="form-field"
                value={renameCategoryForm.name}
                onChange={(e) => setRenameCategoryForm({ ...renameCategoryForm, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveRenameCategory();
                  }
                }}
              />
              <div className="row">
                <button type="button" className="small-btn" onClick={() => void saveRenameCategory()}>Сохранить</button>
                <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowRenameCategory(false)}>Отмена</button>
              </div>
            </div>
          </div>
        </div>
      )}

    {showCreateCategory && (
        <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowCreateCategory(false)} role="presentation">
          <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <span>Новая категория</span>
              <button type="button" className="sheet-close" onClick={() => setShowCreateCategory(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
            </div>
            <div className="sheet-body">
              <input
                placeholder="Название категории"
                className="form-field"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createCategory(newCategoryName);
                  }
                }}
              />
              {canModerateServerUser(selectedServer, profile?.id) && (
                <label className="confirm-check" style={{ marginTop: 8 }}>
                  <input type="checkbox" checked={newCategoryPrivate} onChange={(e) => setNewCategoryPrivate(e.target.checked)} />
                  <span>Приватная категория (доступ выдаётся вручную)</span>
                </label>
              )}
              <div className="row">
                <button type="button" className="small-btn" onClick={() => createCategory(newCategoryName)}>Создать</button>
                <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowCreateCategory(false)}>Отмена</button>
              </div>
            </div>
          </div>
        </div>
      )}

    {showCreateVoiceChannel && (
        <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowCreateVoiceChannel(false)} role="presentation">
          <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <span>Новый голосовой канал</span>
              <button type="button" className="sheet-close" onClick={() => setShowCreateVoiceChannel(false)} aria-label="Закрыть"><SlonIcon name="close" size={18} /></button>
            </div>
            <div className="sheet-body">
              <input
                placeholder="Название канала"
                className="form-field"
                value={newVoiceChannelName}
                onChange={(e) => setNewVoiceChannelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createVoiceChannel(newVoiceChannelName);
                  }
                }}
              />
              {canModerateServerUser(selectedServer, profile?.id) && (() => {
                const pendingCat = (selectedServer?.categories || []).find(
                  (c) => String(c?.id) === String(pendingChannelCategoryId)
                );
                if (pendingCat?.isPrivate) {
                  return (
                    <p className="muted" style={{ marginTop: 8, fontSize: "0.85rem" }}>
                      Категория приватная — новый канал унаследует её доступ.
                    </p>
                  );
                }
                return (
                  <label className="confirm-check" style={{ marginTop: 8 }}>
                    <input type="checkbox" checked={newVoiceChannelPrivate} onChange={(e) => setNewVoiceChannelPrivate(e.target.checked)} />
                    <span>Приватный канал (доступ выдаётся вручную)</span>
                  </label>
                );
              })()}
              <div className="row">
                <button type="button" className="small-btn" onClick={() => createVoiceChannel(newVoiceChannelName)}>Создать</button>
                <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowCreateVoiceChannel(false)}>Отмена</button>
              </div>
            </div>
          </div>
        </div>
      )}

    {renderToast()}
    </div>
  );
}


function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Ошибка чтения файла"));
        return;
      }
      const base64 = result.split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

function fileToBase64WithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const t = setTimeout(() => {
      try { reader.abort(); } catch { /* ignore */ }
      reject(new Error("Таймаут чтения файла"));
    }, 45000);
    reader.onprogress = (e) => {
      try {
        if (!e?.lengthComputable) return;
        const p = e.total > 0 ? (e.loaded / e.total) : 0;
        onProgress?.(p);
      } catch {
        // ignore
      }
    };
    reader.onload = () => {
      try { clearTimeout(t); } catch { /* ignore */ }
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Ошибка чтения файла"));
        return;
      }
      const base64 = result.split(",")[1] || "";
      try { onProgress?.(1); } catch { /* ignore */ }
      resolve(base64);
    };
    reader.onerror = () => {
      try { clearTimeout(t); } catch { /* ignore */ }
      reject(new Error("Не удалось прочитать файл"));
    };
    reader.onabort = () => {
      try { clearTimeout(t); } catch { /* ignore */ }
    };
    reader.readAsDataURL(file);
  });
}

export default function SloncordRoot() {
  const setup =
    typeof window !== "undefined" && window.sloncord && !getApiBase();

  const body = setup ? <ElectronServerSetup /> : <App />;

  const electronChrome =
    typeof window !== "undefined" && typeof window.sloncord?.minimizeWindow === "function";

  if (!electronChrome) {
    return body;
  }

  return (
    <div className="electron-root">
      <ElectronUpdateOverlay />
      <ElectronTitleBar />
      <div className="electron-root__body">{body}</div>
    </div>
  );
}
