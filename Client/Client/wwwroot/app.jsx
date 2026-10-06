const { useCallback, useEffect, useMemo, useRef, useState } = React;

const API_BASE = "";
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
  UserPresenceUpdated: "user.presence",
  DmCallIncoming: "dm.call.incoming",
  DmCallResponse: "dm.call.response",
  DmCallCancelled: "dm.call.cancelled"
};

function fileKindByName(name) {
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp4", "webm", "ogg", "mov", "m4v"].includes(ext)) return "video";
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

function MessageFilePreview({ file, token, onOpenLightbox, onDownload, onMediaLoaded }) {
  const k = useMemo(() => fileKindByName(file?.originalName), [file?.originalName]);
  const [dataUrl, setDataUrl] = useState(null);
  const [videoPosterUrl, setVideoPosterUrl] = useState("");
  const [showVideoPosterOverlay, setShowVideoPosterOverlay] = useState(true);
  const [videoStarted, setVideoStarted] = useState(false);
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
  const directVideoSrc = useMemo(() => (
    file?.id && accessTokenQS ? `${API_BASE}/files/${file.id}/content?${accessTokenQS}` : ""
  ), [file?.id, accessTokenQS]);
  const directVideoPoster = useMemo(() => (
    file?.id && accessTokenQS ? `${API_BASE}/files/${file.id}/thumb?${accessTokenQS}` : ""
  ), [file?.id, accessTokenQS]);

  useEffect(() => {
    if (k !== "video") return;
    setShowVideoPosterOverlay(true);
    setVideoStarted(false);
  }, [k, file?.id]);

  useEffect(() => {
    if (k !== "video") return;
    if (!file?.id) return;
    if (!directVideoSrc) return;

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
        v.src = directVideoSrc;

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
  }, [k, file?.id, directVideoSrc, directVideoPoster, placeholderVideoPoster]);

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
        let r = await fetch(`${API_BASE}/files/${file.id}/content`, { headers, signal: abort.signal });
        if (r.ok) {
          const blob = await r.blob();
          objectUrl = URL.createObjectURL(blob);
          if (!dead) setDataUrl(objectUrl);
          return;
        }
        // Fallback to legacy JSON base64 endpoint.
        r = await fetch(`${API_BASE}/files/${file.id}`, { headers: { "Content-Type": "application/json", ...headers }, signal: abort.signal });
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

  if (k === "other") {
    return (
      <div className="msg-file">
        <span>{file.originalName}</span>
        <button type="button" onClick={onDownload}>Скачать</button>
      </div>
    );
  }

  if (k === "video") {
    const posterSrc = videoPosterUrl || placeholderVideoPoster;
    return (
      <div className="msg-attachment msg-attachment--video">
        <div className="msg-attachment__video">
          {showVideoPosterOverlay && (
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
            ref={videoElRef}
            src={directVideoSrc || ""}
            poster={videoPosterUrl || directVideoPoster || undefined}
            preload="metadata"
            controls={!!videoStarted}
            playsInline
            className="msg-attachment__video-el"
            onLoadedMetadata={() => {
              try { onMediaLoaded?.(); } catch { /* ignore */ }
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
          />
          {!videoStarted && (
            <button
              type="button"
              className="msg-attachment__playbtn"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                  setVideoStarted(true);
                  setShowVideoPosterOverlay(false);
                  videoElRef.current?.play?.().catch(() => {});
                } catch { /* ignore */ }
              }}
              aria-label="Воспроизвести"
              title="Воспроизвести"
            >
              ▶
            </button>
          )}
          <button
            type="button"
            className="msg-attachment__fs"
            onClick={() => onOpenLightbox({ dataUrl: directVideoSrc || "", name: file.originalName, fileId: file.id, kind: "video" })}
            title="На весь экран"
          >
            ⛶
          </button>
          <span
            className="msg-attachment__dlhover msg-attachment__dlhover--video"
            onClick={(e) => { e.stopPropagation(); onDownload(); }}
            title="Скачать"
            role="button"
            tabIndex={0}
          >
            ⬇
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
            ⬇
          </span>
        </button>
      </div>
    );
  }

  return null;
}

function App() {
  const MESSAGES_PAGE_SIZE = 30;
  const [mode, setMode] = useState("login");
  const [token, setToken] = useState(localStorage.getItem("sloncord_token") || "");
  const [profile, setProfile] = useState(null);

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
  function mergeMessagesKeepingLocal(prev, fresh) {
    const a = Array.isArray(prev) ? prev : [];
    const b = Array.isArray(fresh) ? fresh : [];
    const seen = new Set(b.map((m) => String(m?.id || "")));
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
    return merged;
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
  const confirmActionRef = useRef(null);
  const composerAddRef = useRef(null);
  const fileInputRef = useRef(null);
  const composerInputRef = useRef(null);
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
  const [screenView, setScreenView] = useState({ open: false, peerId: "", mode: "full" }); // mode: full | window
  const [screenWindowPos, setScreenWindowPos] = useState(() => ({ x: 0, y: 0, inited: false }));
  const screenDragRef = useRef({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, pointerId: 0 });
  const screenOverlayRef = useRef(null);
  const screenVideoRef = useRef(null);
  const [screenIsFullscreen, setScreenIsFullscreen] = useState(false);
  const [screenControlsVisible, setScreenControlsVisible] = useState(true);
  const screenControlsHideTimerRef = useRef(null);
  const lastScreenTapRef = useRef({ at: 0, x: 0, y: 0 });
  const voicePresenceFetched = useRef(new Set());
  const [voicePresenceByChannelId, setVoicePresenceByChannelId] = useState({});
  const [nowTick, setNowTick] = useState(() => Date.now());
  const voiceRef = useRef(null);
  const connectVoiceInFlight = useRef(false);
  const channelsRef = useRef([]);
  const serversRef = useRef([]);
  const voiceNamesFetched = useRef(new Set());
  const voiceNamesInFlight = useRef(new Set());
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
      advancedNoiseSuppression: String(read("sloncord_audio_advanced_ns", "0")) === "1",
      inputSensitivityAuto: String(read("sloncord_audio_sens_auto", "1")) !== "0",
      inputSensitivity: Number(read("sloncord_audio_sens", "55")) || 55
    };
  });

  const didInitialLoadRef = useRef(false);

  const [inputMeter, setInputMeter] = useState(() => ({ rms: 0, threshold: 0.03, open: false }));

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
  const [userVolumePopup, setUserVolumePopup] = useState({ open: false, userId: "", x: 0, y: 0 });
  const [userCardDmDraft, setUserCardDmDraft] = useState("");
  const userVolumesRef = useRef({});
  useEffect(() => {
    try {
      userVolumesRef.current = JSON.parse(localStorage.getItem("sloncord_voice_user_volumes") || "{}") || {};
    } catch {
      userVolumesRef.current = {};
    }
  }, []);

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
  const [replyDraft, setReplyDraft] = useState(null); // { id, senderNickname, text, firstAttachment? }
  const [forwardModal, setForwardModal] = useState({ open: false, query: "", selectedIds: {}, source: null });
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // Mobile swipe-to-reply (Discord-like)
  const swipeReplyRef = useRef({ active: false, msgId: "", startX: 0, startY: 0, lastDx: 0, locked: "" }); // locked: "" | "h" | "v"
  const [swipeReplyUi, setSwipeReplyUi] = useState({ msgId: "", progress: 0 }); // progress 0..1

  // DM call UI (ringing)
  const [dmCall, setDmCall] = useState({ incoming: null, outgoing: null }); // incoming/outgoing: { callId, channelId, fromUserId, fromNickname }
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

  const textChannels = useMemo(
    () => channels.filter((c) => c.kind === "public" || c.kind === "text"),
    [channels]
  );
  const voiceChannels = useMemo(() => channels.filter((c) => c.kind === "voice"), [channels]);

  const selectedChannel = useMemo(() => {
    if (uiMode === "dm")
      return dmChannels.find((c) => c.id === selectedChannelId) || null;
    const c = channels.find((c) => c.id === selectedChannelId);
    if (!c) return null;
    if (c.kind === "voice") return null;
    return c;
  }, [channels, dmChannels, selectedChannelId, uiMode]);

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

  async function kickMemberFromServer(userId) {
    clearAlerts();
    try {
      if (!token) return;
      if (!selectedServer?.id) return;
      await api(`/servers/${selectedServer.id}/members/${userId}`, { method: "DELETE" });
      const users = await api(`/channels/${selectedChannelId}/members`, { method: "GET" });
      setMembers(users || []);
      setStatus("Участник удалён");
    } catch (e) {
      setError(e.message || String(e));
    }
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
    if (!status && !error) return undefined;
    const t = setTimeout(() => {
      setStatus("");
      setError("");
    }, 8000);
    return () => clearTimeout(t);
  }, [status, error]);

  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
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
      // If server returned non-JSON (often HTML on 500), surface a short snippet for debugging.
      if ((!data || typeof data === "string") && text) {
        const snippet = String(text)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 220);
        if (snippet) message = `${message}: ${snippet}`;
      }
      throw new Error(message);
    }
    return data;
  }

  async function ensureAvatarUrl(fileId) {
    const fid = String(fileId || "");
    if (!fid) return "";
    if (avatarUrlByFileId[fid]) return avatarUrlByFileId[fid];
    try {
      const data = await api(`/avatars/${fid}`, { method: "GET" });
      const ct = data?.contentType || "image/png";
      const b64 = data?.fileBase64 || "";
      if (!b64) return "";
      const url = `data:${ct};base64,${b64}`;
      setAvatarUrlByFileId((prev) => ({ ...prev, [fid]: url }));
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
      const up = { nickname: p.nickname || id, avatarFileId: p.avatarFileId || "", bio: p.bio || "" };
      setUserProfiles((prev) => ({ ...prev, [id]: up }));
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
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      // Accept ANY file kind (images, videos, documents, etc)
      if (it.kind === "file") {
        e.preventDefault();
        const blob = it.getAsFile();
        if (!blob) continue;
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

    const init = await fetch(`${API_BASE}/uploads/init`, {
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
      const r = await fetch(`${API_BASE}/uploads/${uploadId}/chunk`, {
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

    const complete = await fetch(`${API_BASE}/uploads/${uploadId}/complete`, {
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
      const inviteCode = params.get("invite");
      if (inviteCode?.trim()) {
        try {
          await api("/servers/join", {
            method: "POST",
            body: JSON.stringify({ inviteCode: inviteCode.trim() })
          });
          const next = new URLSearchParams(window.location.search);
          next.delete("invite");
          const url = `${window.location.pathname}${next.toString() ? `?${next}` : ""}`;
          window.history.replaceState({}, "", url);
          list = (await api("/servers", { method: "GET" })) || [];
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

  const voiceRestoreTried = useRef(false);
  useEffect(() => {
    if (!token) return;
    if (voiceRestoreTried.current) return;
    if (voiceState.connected || voiceState.joining) return;
    if (!servers || servers.length === 0) return;
    let last = "";
    try {
      last = localStorage.getItem("sloncord_last_voice_channel_id") || "";
    } catch {
      last = "";
    }
    if (!last) {
      voiceRestoreTried.current = true;
      return;
    }
    // Try reconnect once after reload.
    voiceRestoreTried.current = true;
    connectVoiceToChannel(last).catch(() => {});
  }, [token, servers, voiceState.connected, voiceState.joining]);

  useEffect(() => {
    if (!token) return undefined;
    if (!window.signalR) {
      setError("Не удалось загрузить SignalR (проверьте сеть/CDN)");
      return undefined;
    }

    const signalR = window.signalR;
    const url = `${API_BASE}/hubs/sloncord?access_token=${encodeURIComponent(token)}`;
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
          if (prev.some((m) => String(m.id) === String(msg.id))) return prev;
          return [...prev, msg];
        });
        setTimeout(() => scrollToBottomIfPinned(), 0);
        // If we're currently viewing this chat and a message from someone else arrives,
        // immediately mark as read (prevents unread badges from getting stuck).
        try {
          const canAutoRead = isFromOther && !document.hidden && !!shouldAutoScrollRef.current;
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
        if (isFromOther && document.hidden && prefs.banners) {
          const ctx = ctx0;
          const preview = msg.text || "[файл]";
          const title = ctx.kind === "dm"
            ? `От ${msg.senderNickname}`
            : (ctx.kind === "channel" ? `${ctx.serverName || "Sloncord"} • #${ctx.channelName || "канал"}` : "Sloncord");
          const body = ctx.kind === "dm" ? `ЛС: ${preview}` : `${msg.senderNickname}: ${preview}`;
          showLocalNotification(title, body);
          tryVibrate();
        }
      } else if (isFromOther && document.hidden && prefs.banners) {
        const ctx = ctx0;
        const preview = msg.text || "[файл]";
        const title = ctx.kind === "dm"
          ? `От ${msg.senderNickname}`
          : (ctx.kind === "channel" ? `${ctx.serverName || "Sloncord"} • #${ctx.channelName || "канал"}` : "Sloncord");
        const body = ctx.kind === "dm" ? `ЛС: ${preview}` : `${msg.senderNickname}: ${preview}`;
        showLocalNotification(title, body);
        tryVibrate();
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

    connection.on(RT.VoicePresenceUpdated, (payload) => {
      const chId = payload?.channelId;
      if (!chId) return;
      setVoicePresenceByChannelId((prev) => ({
        ...prev,
        [String(chId)]: {
          channelId: String(chId),
          userIds: (payload.userIds || []).map((x) => String(x)),
          screenShareUserIds: (payload.screenShareUserIds || []).map((x) => String(x)),
          mutedUserIds: (payload.mutedUserIds || []).map((x) => String(x)),
          deafenedUserIds: (payload.deafenedUserIds || []).map((x) => String(x)),
          startedAtUtc: payload.startedAtUtc || ""
        }
      }));
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
      const signalR = window.signalR;
      if (!hub || !signalR) return;
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
    if (!token) return;
    // Fetch presence for voice channels so the list is visible even when not connected.
    (async () => {
      for (const ch of voiceChannels) {
        const id = String(ch.id);
        if (!id) continue;
        if (voicePresenceFetched.current.has(id)) continue;
        voicePresenceFetched.current.add(id);
        try {
          const p = await api(`/channels/${id}/voice/presence`, { method: "GET" });
          setVoicePresenceByChannelId((prev) => ({ ...prev, [id]: p }));
        } catch {
          // ignore
        }
      }
    })();
  }, [token, voiceChannels]);

  useEffect(() => {
    // Update voice timers only when there is at least one active voice call.
    const hasActive = Object.values(voicePresenceByChannelId || {}).some((p) => (p?.userIds || []).length > 0 && p?.startedAtUtc);
    if (!hasActive) return undefined;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [voicePresenceByChannelId]);

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
    // Аватары файлов + профили отправителей — сразу пакетом (раньше было 2 эффекта и N последовательных await)
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
      await Promise.all([
        ...fids.map((fid) => (avatarUrlByFileId[fid] ? Promise.resolve() : ensureAvatarUrl(fid))),
        ...uids.map((id) => ensureUserProfile(id))
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

  async function loadOlderMessagesIfNeeded(reason) {
    let finishLoad = () => {};
    try {
      const cid = String(selectedChannelIdRef.current || "");
      const mode = String(uiModeRef.current || "server");
      if (!cid) return;
      const el = messagesBoxRef.current;
      if (!el) return;

      const { loadingOlder, hasMoreOlder } = getPageStateForCurrent();
      if (loadingOlder || loadOlderInFlightRef.current || !hasMoreOlder) return;

      let anchorMsgId = "";
      let anchorDistanceFromScrollTop = null;
      try {
        const boxRect = el.getBoundingClientRect?.();
        const boxTop = boxRect?.top ?? 0;
        const nodes = el.querySelectorAll?.(".message[id^='msg-']") || [];
        for (const n of nodes) {
          const r = n.getBoundingClientRect?.();
          if (!r) continue;
          if (r.bottom > boxTop + 8) {
            anchorMsgId = String(n.id || "");
            // Distance from scrollTop so we can restore without relying on scrollHeight deltas.
            anchorDistanceFromScrollTop = Number(n.offsetTop || 0) - Number(el.scrollTop || 0);
            break;
          }
        }
      } catch {
        /* ignore */
      }

      const current = Array.isArray(messagesRef.current) ? messagesRef.current : messages;
      const list = Array.isArray(current) ? current : [];
      const oldest = list[0];
      const before = oldest?.createdAtUtc;
      if (!before) {
        setHasMoreOlderForCurrent(false);
        return;
      }

      const startedPageKey = pageKey();
      loadOlderInFlightRef.current = true;
      setLoadingOlderForCurrent(true);
      finishLoad = () => {
        loadOlderInFlightRef.current = false;
        const cur = pageStateRef.current[startedPageKey] || {};
        pageStateRef.current[startedPageKey] = { ...cur, loadingOlder: false };
      };

      const prevScrollHeight = el.scrollHeight;
      const prevScrollTop = el.scrollTop;

      const pathBase = mode === "dm" ? `/dm/${cid}/messages` : `/channels/${cid}/messages`;
      const url = `${pathBase}?limit=${encodeURIComponent(String(MESSAGES_PAGE_SIZE))}&before=${encodeURIComponent(String(before))}`;
      const older = await api(url, { method: "GET" });
      if (!isStillOnChannel(cid)) {
        finishLoad();
        return;
      }

      const olderList = Array.isArray(older) ? older : [];
      if (olderList.length === 0) {
        setHasMoreOlderForCurrent(false);
        finishLoad();
        return;
      }

      setMessages((prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        const seen = new Set(prevList.map((m) => String(m?.id || "")));
        const merged = [];
        for (const m of olderList) {
          const id = String(m?.id || "");
          if (id && !seen.has(id)) merged.push(m);
        }
        return [...merged, ...prevList];
      });

      scheduleRestoreScrollAfterPrepend({
        prevScrollHeight,
        prevScrollTop,
        anchorMsgId,
        anchorDistanceFromScrollTop,
        expectedCid: cid,
        onDone: finishLoad
      });

      if (olderList.length < MESSAGES_PAGE_SIZE) {
        setHasMoreOlderForCurrent(false);
      }
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
      await api(`/servers/${selectedServerId}/channels`, {
        method: "POST",
        body: JSON.stringify({ name, type: "text" })
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setNewChannelName("");
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
      await api(`/servers/${selectedServerId}/channels`, {
        method: "POST",
        body: JSON.stringify({ name, type: "voice" })
      });
      const list = (await api("/servers", { method: "GET" })) || [];
      setServers(list);
      setNewVoiceChannelName("");
      setShowCreateVoiceChannel(false);
      setUiMode("server");
      setStatus("Голосовой канал создан");
    } catch (e) {
      setError(e.message);
    } finally {
      channelActionLock.current = false;
    }
  }

  function copyServerInvite() {
    clearAlerts();
    if (!selectedServer?.inviteCode) {
      setError("Нет кода приглашения");
      return;
    }
    const u = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(selectedServer.inviteCode)}`;
    try {
      void navigator.clipboard.writeText(u);
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

      const next = [...dmChannels.filter((c) => c.id !== dm.id), dm];
      setDmChannels(next);
      setUiMode("dm");
      setSelectedChannelId(dm.id);
      if (window.matchMedia("(max-width: 900px)").matches) setMobileView("chat");
      setStatus("DM открыт");
    } catch (e) {
      setError(e.message);
    }
  }

  async function sendChatMessage() {
    clearAlerts();
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

              await api(path, {
                method: "POST",
                body: JSON.stringify({
                  text: ci === 0 ? (text || "") : "",
                  replyToMessageId: ci === 0 && replyToId ? replyToId : undefined,
                  files: files.length ? files : undefined,
                  attachmentFileIds: attachmentFileIds.length ? attachmentFileIds : undefined
                })
              });

              // Remove optimistic message after successful POST (realtime will deliver the real one).
              setMessages((prev) => prev.filter((m) => String(m.id) !== String(localMsgId)));
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
          }
        })();
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
    setEditing({ id: "", text: "", originalText: "", removeAttachmentFileIds: [] });
  }, [selectedChannelId, uiMode]);

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
      // Prefer binary content endpoint so large files work.
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      let r = await fetch(`${API_BASE}/files/${fileId}/content`, { headers });
      if (r.ok) {
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = originalName || "file.bin";
        link.click();
        URL.revokeObjectURL(url);
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
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = originalName || "file.bin";
      link.click();
      URL.revokeObjectURL(url);
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
          setUserProfiles((prev) => ({ ...(prev || {}), [String(updated.id)]: { ...(prev?.[String(updated.id)] || {}), avatarFileId: String(updated.avatarFileId || "") } }));
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

  async function connectVoiceToChannel(voiceChannelId, opts) {
    if (connectVoiceInFlight.current) {
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

      if (!window.isSecureContext) {
        setError("Голосовой чат в браузере требует HTTPS (или localhost). Откройте сайт по https://…");
        return;
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError("Этот браузер/контекст не даёт доступ к микрофону (нужен HTTPS/localhost и поддержка WebRTC).");
        return;
      }

      const me = profile?.id ? profile : await api("/profile", { method: "GET" });
      setProfile(me);

      setActiveVoiceChannelId(String(voiceChannelId));
      voiceNamesFetched.current.clear();
      setVoicePeerNames({});

      destroyVoiceInstance();
      setVoiceState({
        connected: false,
        joining: true,
        mediaLinkReady: false,
        room: "",
        peers: 0,
        muted: (() => {
          try { return (localStorage.getItem("sloncord_voice_deafened") === "1") || (localStorage.getItem("sloncord_voice_mic_enabled") === "0"); } catch { return false; }
        })(),
        deafened: (() => {
          try { return localStorage.getItem("sloncord_voice_deafened") === "1"; } catch { return false; }
        })(),
        remotePeerUserIds: [],
        rosterUserIds: []
      });

      const host = remoteAudioHostRef.current;
      const videoHost = remoteVideoHostRef.current;
      let iceServers = null;
      try {
        const cfg = await api("/voice/ice", { method: "GET" });
        iceServers = cfg?.iceServers || null;
      } catch {
        iceServers = null;
      }
      const roomId = `channel:${voiceChannelId}`;
      const sfu = await api("/voice/sfuToken", { method: "POST", body: JSON.stringify({ roomId }) });
      const session = createSfuVoiceSession({
        token,
        roomId,
        selfUserId: me.id,
        remoteAudioHost: host,
        remoteVideoHost: videoHost,
        onState: setVoiceState,
        iceServers,
        sfuUrl: sfu?.sfuUrl,
        sfuToken: sfu?.token
      });
      voiceRef.current = session;
      await session.join();
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
    }
  }

  function leaveVoice() {
    clearAlerts();
    try {
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
      setError(e.message || String(e));
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
    const re = /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/gi;
    const parts = [];
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) parts.push(s.slice(last, start));
      const raw = m[0];
      const href = raw.startsWith("http") ? raw : `https://${raw}`;
      let sameOrigin = false;
      try {
        const u = new URL(href, window.location.origin);
        sameOrigin = u.origin === window.location.origin;
      } catch {
        sameOrigin = false;
      }
      parts.push(
        <a
          key={`lnk-${start}-${end}`}
          href={href}
          target={sameOrigin ? "_self" : "_blank"}
          rel={sameOrigin ? undefined : "noreferrer"}
        >
          {raw}
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
    // Try to kick negotiation and wait for the remote video track to arrive.
    try {
      voiceRef.current?.ensurePeerFor?.(pid);
      voiceRef.current?.renegotiateAll?.();
    } catch {
      // ignore
    }

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
      if (Date.now() - startedAt > timeoutMs) {
        setError("Демонстрация пока не доступна (нет видеопотока).");
        return;
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 0);
  }

  function closeScreenView() {
    // Stop hearing screen audio when closing the viewer (Discord-like).
    try { voiceRef.current?.setScreenAudioVolume?.(String(screenView.peerId || ""), 0); } catch { /* ignore */ }
    try {
      if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
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

  function toggleScreenViewMode() {
    // If currently in native fullscreen, exit before switching to window mode.
    setScreenView((prev) => {
      const nextMode = prev.mode === "full" ? "window" : "full";
      if (nextMode === "window") {
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
      if (!el?.requestFullscreen) return;
      el.requestFullscreen().catch(() => {});
    } catch { /* ignore */ }
  }

  function exitScreenFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
    } catch { /* ignore */ }
  }

  function toggleNativeFullscreen() {
    if (screenIsFullscreen) exitScreenFullscreen();
    else {
      // Native fullscreen should behave like "full" view.
      if (screenView.mode !== "full") setScreenView((p) => ({ ...p, mode: "full" }));
      setTimeout(() => requestScreenFullscreen(), 0);
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

  function openUserCard(userId, ev) {
    const id = String(userId || "");
    if (!id) return;
    setUserCardDmDraft("");
    try {
      setUserVolumePopup({ open: true, userId: id, x: ev?.clientX ?? window.innerWidth / 2, y: ev?.clientY ?? window.innerHeight / 2 });
    } catch {
      setUserVolumePopup({ open: true, userId: id, x: window.innerWidth / 2, y: window.innerHeight / 2 });
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
    try { voiceRef.current?.setAdvancedNoiseSuppression?.(!!audioSettings.advancedNoiseSuppression); } catch { /* ignore */ }
    try {
      voiceRef.current?.setAudioProcessing?.({
        echoCancellation: !!audioSettings.echoCancellation,
        noiseSuppression: !!audioSettings.noiseSuppression,
        autoGainControl: !!audioSettings.autoGainControl,
        advancedNoiseSuppression: !!audioSettings.advancedNoiseSuppression,
        inputSensitivityAuto: !!audioSettings.inputSensitivityAuto,
        inputSensitivity: Number(audioSettings.inputSensitivity) || 55
      });
    } catch { /* ignore */ }
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
      if (host && window.ReactDOM?.createPortal) {
        return window.ReactDOM.createPortal(node, host);
      }
    } catch {
      // ignore
    }
    return node;
  }

  function formatCallDuration(startedAtUtc) {
    try {
      const t0 = Date.parse(startedAtUtc);
      if (!Number.isFinite(t0)) return "";
      const sec = Math.max(0, Math.floor((nowTick - t0) / 1000));
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

  if (!token) {
    return (
      <div className="auth-wrap">
        <div className="auth-card">
          <h1>Sloncord</h1>
          <p className="muted">Веб-клиент в стиле Discord</p>
          <input
            placeholder="Login"
            value={authForm.login}
            onChange={(e) => setAuthForm({ ...authForm, login: e.target.value })}
          />
          <input
            type="password"
            placeholder="Password"
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
            <div
              className={`guild-icon guild-icon--dm ${uiMode === "dm" ? "active" : ""}`}
              title="Личные сообщения"
              onClick={() => {
                setUiMode("dm");
                // Mobile UX: open the DM list first (don't jump into a random chat).
                if (window.matchMedia("(max-width: 900px)").matches) {
                  // Important: prevent effects from treating a server channel id as a DM id.
                  setSelectedChannelId("");
                  setMobileView("list");
                  closeMembersSheet();
                  return;
                }
                // Desktop: keep the previous behavior (open the first DM if any).
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
          +
        </div>
      </aside>

      <aside className="channels">
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
                +
              </button>
            </div>
            <div className="channels-list">
              {dmChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${selectedChannelId === channel.id ? "active" : ""}`}
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
                    className="icon-btn danger dm-close-btn"
                    title="Удалить чат"
                    aria-label="Удалить чат"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      confirmDeleteDmChannel(channel);
                    }}
                  >
                    ✕
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
                    ▾
                  </button>
                </div>
                {selectedServer.description && (
                  <div className="server-top-desc muted">{selectedServer.description}</div>
                )}
              </div>
            )}
            <div className="panel-header panel-header-row">
              <span>Текстовые каналы</span>
              <button type="button" className="icon-btn" title="Создать текстовый канал" onClick={() => setShowCreateTextChannel(true)}>+</button>
            </div>
            <div className="channels-list">
              {textChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${selectedChannelId === channel.id ? "active" : ""}`}
                  onClick={() => selectTextChannel(channel.id, "server")}
                >
                  <span className="chan-name" title={channel.name}># {channel.name}</span>
                  <span className="channel-item-spacer" />
                  {Number(channel.unreadCount) > 0 && (
                    <span className="unread-badge" aria-label="Непрочитанные сообщения">
                      {Number(channel.unreadCount) > 99 ? "99+" : channel.unreadCount}
                    </span>
                  )}
                  {String(channel.ownerUserId) === String(profile?.id) && (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Переименовать канал"
                      aria-label="Переименовать канал"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setRenameChannelForm({ id: String(channel.id), name: channel.name || "" });
                        setShowRenameChannel(true);
                      }}
                    >
                      ✎
                    </button>
                  )}
                  {String(channel.ownerUserId) === String(profile?.id) && (
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="Удалить канал"
                      aria-label="Удалить канал"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        confirmDeleteChannel(channel);
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="panel-header panel-header--sub panel-header-row">
              <span>Голосовые каналы</span>
              <button type="button" className="icon-btn" title="Создать голосовой канал" onClick={() => setShowCreateVoiceChannel(true)}>+</button>
            </div>
            <div className="channels-list">
              {voiceChannels.map((channel) => (
                <div key={channel.id} className="channel-voice-group">
                  <div
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onVoiceChannelRowClick(channel.id);
                      }
                    }}
                    className={`channel-item channel-item--voice ${
                      String(activeVoiceChannelId) === String(channel.id) && (voiceState.connected || voiceState.joining) ? "active" : ""
                    }`}
                    onClick={() => onVoiceChannelRowClick(channel.id)}
                  >
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      🔊 {channel.name}
                    </span>
                    <span className="channel-item-spacer" />
                    {(() => {
                      const p = voicePresenceByChannelId[String(channel.id)];
                      if (!p?.startedAtUtc) return null;
                      if (!Array.isArray(p.userIds) || p.userIds.length === 0) return null;
                      const txt = formatCallDuration(p.startedAtUtc);
                      if (!txt) return null;
                      return <span className="call-timer-pill" title="Длительность звонка">{txt}</span>;
                    })()}
                    {String(channel.ownerUserId) === String(profile?.id) && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="Переименовать канал"
                        aria-label="Переименовать канал"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setRenameChannelForm({ id: String(channel.id), name: channel.name || "" });
                          setShowRenameChannel(true);
                        }}
                      >
                        ✎
                      </button>
                    )}
                    {String(channel.ownerUserId) === String(profile?.id) && (
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Удалить канал"
                        aria-label="Удалить канал"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          confirmDeleteChannel(channel);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {(() => {
                    const isActive = String(activeVoiceChannelId) === String(channel.id);
                    const isConnectedHere = isActive && (voiceState.connected || voiceState.joining);

                    const pid = String(channel.id);
                    const presence = voicePresenceByChannelId[pid];
                    const meId = String(profile?.id || "");
                    const presenceIds = (presence?.userIds || [])
                      .map((x) => String(x))
                      // Presence is server-wide best-effort and can be stale after redeploy/reconnect.
                      // Never show "me" in the passive presence roster when I'm not connected here.
                      .filter((id) => id && id !== meId);
                    const presenceSharers = new Set(
                      (presence?.screenShareUserIds || [])
                        .map((x) => String(x))
                        .filter((id) => id && id !== meId)
                    );

                    // If we're connected to this voice channel, render ONLY local roster (no duplication).
                    if (isConnectedHere) {
                      // When connected, rely on actual active media tracks for screen share.
                      // Presence can be stale (disconnects, missed "screenShare=false") and should not keep "в эфире" stuck.
                      const sharers = new Set((voiceState.screenShareUserIds || []).map((x) => String(x)));
                      const meSpeaking = (voiceState.speakingUserIds || []).some((x) => String(x) === String(profile?.id));
                      const meSharing = sharers.has(String(profile?.id));
                      return (
                        <ul className="voice-members-inline">
                          <li className={`voice-members-inline__me ${meSpeaking ? "is-speaking" : ""}`}>
                            <span className={`voice-member-avatar ${meSpeaking ? "is-speaking" : ""}`}>
                              {userAvatarUrlByUserId[String(profile?.id)] ? (
                                <img alt="" src={userAvatarUrlByUserId[String(profile?.id)]} />
                              ) : (
                                <span className="avatar-fallback">{(profile?.nickname || "?").trim().slice(0, 1).toUpperCase()}</span>
                              )}
                            </span>
                            <span className="voice-member-name">{profile?.nickname}</span>
                            {meSharing && <span className="live-pill">в эфире</span>}
                            {voiceState.muted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                            {voiceState.deafened && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
                          </li>
                          {(voiceState.rosterUserIds || [])
                            .filter((id) => String(id) !== String(profile?.id))
                            .map((id) => {
                              const isSp = (voiceState.speakingUserIds || []).some((x) => String(x) === String(id));
                              const isMuted = (voiceState.mutedUserIds || []).some((x) => String(x) === String(id));
                              const isDeaf = (voiceState.deafenedUserIds || []).some((x) => String(x) === String(id));
                              return (
                              <li
                                key={`vm-${id}`}
                                className={isSp ? "is-speaking" : ""}
                              >
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
                                    openUserCard(id, e);
                                  }}
                                  title="Настроить громкость пользователя"
                                  style={{ cursor: "pointer" }}
                                >
                                  {voicePeerNames[String(id)] || "…"}
                                </span>
                                {sharers.has(String(id)) && <span className="live-pill">в эфире</span>}
                                {isMuted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                                {isDeaf && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
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
                                    ⛶
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      );
                    }

                    // Not connected: render presence list always, if there is any.
                    if (!presenceIds.length) {
                      return null;
                    }
                    return (
                      <ul className="voice-members-inline voice-members-inline--presence">
                        {presenceIds.map((id) => {
                          const isSp = (voiceState.speakingUserIds || []).some((x) => String(x) === String(id));
                          const isMuted = (presence?.mutedUserIds || []).some((x) => String(x) === String(id));
                          const isDeaf = (presence?.deafenedUserIds || []).some((x) => String(x) === String(id));
                          return (
                          <li key={`vp-${pid}-${id}`} className={isSp ? "is-speaking" : ""}>
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
                                openUserCard(id, e);
                              }}
                              title="Настроить громкость пользователя"
                              style={{ cursor: "pointer" }}
                            >
                              {voicePeerNames[String(id)] || "…"}
                            </span>
                            {presenceSharers.has(String(id)) && <span className="live-pill">в эфире</span>}
                            {isMuted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                            {isDeaf && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
                            {presenceSharers.has(String(id)) && (
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
                                ⛶
                              </button>
                            )}
                          </li>
                          );
                        })}
                      </ul>
                    );
                  })()}
                </div>
              ))}
            </div>
          </div>
        )}

        {(voiceState.connected || voiceState.joining) && activeVoiceChannelId && (
          <div className="voice-connection-panel" role="region" aria-label="Голосовая связь">
            <div className="voice-connection-row">
              <div className={`voice-connection-dot ${voiceState.connected ? "" : "is-joining"}`} aria-hidden />
              <div className="voice-connection-titles">
                <div className="voice-connection-title">{voiceState.connected ? "Голосовая связь" : "Подключение…"}</div>
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
                🎤
              </button>
              <button
                type="button"
                className={`user-voice-btn ${voiceState.deafened ? "is-off" : ""}`}
                onClick={toggleDeafen}
                title={voiceState.deafened ? "Включить звук" : "Режим без звука"}
                aria-pressed={voiceState.deafened}
              >
                🎧
              </button>
              <button
                type="button"
                className={`user-voice-btn ${voiceState.sharingScreen ? "is-off" : ""}`}
                onClick={toggleScreenShare}
                title={voiceState.sharingScreen ? "Остановить демонстрацию" : "Демонстрация экрана"}
                aria-pressed={!!voiceState.sharingScreen}
              >
                🖥️
              </button>
              <button
                type="button"
                className="user-voice-btn"
                onClick={() => {
                  setAudioSettingsOpen(true);
                  refreshAudioDevicesAndApply().catch((e) => setError(e.message || String(e)));
                }}
                title="Ввод/вывод"
                aria-label="Ввод/вывод"
              >
                ⚙️
              </button>
              <button type="button" className="voice-connection-hangup" onClick={leaveVoice} title="Отключиться" aria-label="Отключиться">
                ⏏
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
              aria-label="Ввод/вывод"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sheet-header">
                <div className="sheet-title">Ввод/вывод</div>
                <button type="button" className="sheet-close" onClick={() => setAudioSettingsOpen(false)} aria-label="Закрыть">×</button>
              </div>
              <div className="sheet-body">
                <div className="panel-header--sub">Устройства ввода</div>
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
                  <option value="">По умолчанию</option>
                  {(audioDevices.outputs || []).map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Вывод (${d.deviceId.slice(0, 6)})`}</option>
                  ))}
                </select>
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

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Обработка аудио</div>

                <div style={{ display: "grid", gap: "10px" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!audioSettings.echoCancellation}
                      onChange={(e) => {
                        const v = !!e.target.checked;
                        setAudioSettings((p) => ({ ...p, echoCancellation: v }));
                        try { localStorage.setItem("sloncord_audio_ec", v ? "1" : "0"); } catch { /* ignore */ }
                        try { voiceRef.current?.setAudioProcessing?.({ ...audioSettings, echoCancellation: v }); } catch { /* ignore */ }
                      }}
                    />
                    <span>Эхоподавление</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!audioSettings.noiseSuppression}
                      onChange={(e) => {
                        const v = !!e.target.checked;
                        setAudioSettings((p) => ({ ...p, noiseSuppression: v }));
                        try { localStorage.setItem("sloncord_audio_ns", v ? "1" : "0"); } catch { /* ignore */ }
                        try { voiceRef.current?.setAudioProcessing?.({ ...audioSettings, noiseSuppression: v }); } catch { /* ignore */ }
                      }}
                    />
                    <span>Шумоподавление</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!audioSettings.autoGainControl}
                      onChange={(e) => {
                        const v = !!e.target.checked;
                        setAudioSettings((p) => ({ ...p, autoGainControl: v }));
                        try { localStorage.setItem("sloncord_audio_agc", v ? "1" : "0"); } catch { /* ignore */ }
                        try { voiceRef.current?.setAudioProcessing?.({ ...audioSettings, autoGainControl: v }); } catch { /* ignore */ }
                      }}
                    />
                    <span>Автоматическая регулировка усиления</span>
                  </label>

                  <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={!!audioSettings.advancedNoiseSuppression}
                      onChange={(e) => {
                        const v = !!e.target.checked;
                        setAudioSettings((p) => ({ ...p, advancedNoiseSuppression: v }));
                        try { localStorage.setItem("sloncord_audio_advanced_ns", v ? "1" : "0"); } catch { /* ignore */ }
                        try { voiceRef.current?.setAudioProcessing?.({ ...audioSettings, advancedNoiseSuppression: v }); } catch { /* ignore */ }
                      }}
                    />
                    <span>Продвинутое шумоподавление (Chromium)</span>
                  </label>
                </div>

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Чувствительность ввода</div>
                <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={!!audioSettings.inputSensitivityAuto}
                    onChange={(e) => {
                      const v = !!e.target.checked;
                      setAudioSettings((p) => ({ ...p, inputSensitivityAuto: v }));
                      try { localStorage.setItem("sloncord_audio_sens_auto", v ? "1" : "0"); } catch { /* ignore */ }
                      try { voiceRef.current?.setAudioProcessing?.({ inputSensitivityAuto: v }); } catch { /* ignore */ }
                    }}
                  />
                  <span>Авто‑определение</span>
                </label>

                {!audioSettings.inputSensitivityAuto && (
                  <div className="row" style={{ alignItems: "center" }}>
                    <div style={{ minWidth: "140px" }}>Порог</div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={audioSettings.inputSensitivity}
                      onChange={(e) => {
                        const v = Number(e.target.value) || 0;
                        setAudioSettings((p) => ({ ...p, inputSensitivity: v }));
                        try { localStorage.setItem("sloncord_audio_sens", String(v)); } catch { /* ignore */ }
                        try { voiceRef.current?.setAudioProcessing?.({ inputSensitivity: v }); } catch { /* ignore */ }
                      }}
                      style={{ flex: 1 }}
                    />
                    <div style={{ width: "54px", textAlign: "right" }}>{audioSettings.inputSensitivity}</div>
                  </div>
                )}

                {audioSettings.inputSensitivityAuto && (
                  <div className="muted" style={{ marginTop: "6px" }}>
                    Авто: порог подстраивается под шум в комнате.
                  </div>
                )}

                <div className="panel-header--sub" style={{ marginTop: "14px" }}>Проверка микрофона</div>
                <div style={{ display: "grid", gap: "8px" }}>
                  <div style={{ height: "10px", borderRadius: "999px", overflow: "hidden", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(0, Math.min(100, Math.round((inputMeter.rms / 0.12) * 100)))}%`,
                        background: inputMeter.open ? "rgba(35,165,89,0.95)" : "rgba(88,101,242,0.85)",
                        transition: "width 70ms linear"
                      }}
                    />
                  </div>
                  <div className="muted" style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
                    <span>Уровень: {(inputMeter.rms || 0).toFixed(3)}</span>
                    <span>Порог: {(inputMeter.threshold || 0.03).toFixed(3)}</span>
                    <span>Говорю: {inputMeter.open ? "да" : "нет"}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {userVolumePopup.open && (
          <div
            style={{
              position: "fixed",
              left: Math.max(10, Math.min(window.innerWidth - 260, userVolumePopup.x)),
              top: Math.max(10, Math.min(window.innerHeight - 120, userVolumePopup.y)),
              width: "250px",
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "12px",
              padding: "10px",
              zIndex: 9999
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "flex-start" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "center", minWidth: 0 }}>
                <div style={{ width: "112px", height: "112px", borderRadius: "999px", overflow: "hidden", background: "rgba(0,0,0,0.18)", border: "1px solid var(--border)", flex: "0 0 auto" }}>
                  {userAvatarUrlByUserId[String(userVolumePopup.userId)] ? (
                    <img alt="" src={userAvatarUrlByUserId[String(userVolumePopup.userId)]} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                  ) : (
                    <div style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", fontWeight: 800 }}>
                      {(String(voicePeerNames[String(userVolumePopup.userId)] || userProfiles[String(userVolumePopup.userId)]?.nickname || "?").trim().slice(0, 1) || "?").toUpperCase()}
                    </div>
                  )}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 900, lineHeight: 1.1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {userProfiles[String(userVolumePopup.userId)]?.nickname || voicePeerNames[String(userVolumePopup.userId)] || "…"}
                  </div>
                  {String(userProfiles[String(userVolumePopup.userId)]?.bio || "").trim() ? (
                    <div className="muted" style={{ fontSize: "12px", lineHeight: 1.2, marginTop: "4px" }}>
                      {String(userProfiles[String(userVolumePopup.userId)]?.bio || "").trim()}
                    </div>
                  ) : (
                    <span />
                  )}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setUserVolumePopup({ open: false, userId: "", x: 0, y: 0 })} aria-label="Закрыть">×</button>
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
                      setUserVolumePopup({ open: false, userId: "", x: 0, y: 0 });
                    }
                  } catch (err) {
                    setError(err?.message || String(err));
                  }
                })();
              }}
              style={{ marginTop: "10px" }}
            />

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
                  // re-render
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
              <div><b>{profile?.nickname}</b></div>
              <div className="muted">{profile?.login}</div>
            </div>
          </div>
          <div className="toolbar" style={{ marginTop: "8px", flexWrap: "wrap" }}>
            <button className="small-btn" onClick={() => setShowEditProfile(true)}>Профиль</button>
            <button
              className="small-btn"
              onClick={() => enablePushNotifications()}
              title="Разрешить браузерные уведомления"
            >
              Уведомления
            </button>
            <button className="small-btn" style={{ background: "var(--danger)" }} onClick={logout}>Выйти</button>
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
                ←
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
                📞
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
                  return off ? "🔕" : (partial ? "🔕" : "🔔");
                })()}
              </button>
            )}
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
              const ids = (isConnectedHere ? (voiceState.rosterUserIds || []) : (presence?.userIds || []))
                .map((x) => String(x))
                .filter(Boolean);
              const presenceIds = (presence?.userIds || [])
                .map((x) => String(x))
                .filter((id) => id && id !== meId);
              if (isConnectedHere ? !ids.length : !presenceIds.length) return null;

              const sharers = new Set(
                (isConnectedHere ? (voiceState.screenShareUserIds || []) : (presence?.screenShareUserIds || []))
                  .map((x) => String(x))
                  .filter(Boolean)
              );
              const others = (isConnectedHere ? ids : presenceIds).filter((x) => x && x !== meId);
              const meSpeaking = (voiceState.speakingUserIds || []).some((x) => String(x) === meId);
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
                        {voiceState.muted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                        {voiceState.deafened && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
                      </li>
                    )}
                    {others.map((id) => {
                      const isSp = (voiceState.speakingUserIds || []).some((x) => String(x) === String(id));
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
                          {isMuted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                          {isDeaf && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
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
                              ⛶
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
                <React.Fragment key={msg.id}>
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
                    className={`message${isSystemMsg ? " message--system" : ""}${isSystemMissedCall ? " message--system-missed-call" : ""}${isUnread ? " message--unread" : ""}${(isNarrow && String(swipeReplyUi.msgId) === String(msg.id) && swipeReplyUi.progress > 0) ? " is-swipe-active" : ""}`}
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
                        setReplyDraft({
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
                        ↩
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
                      <span className="msg-author">{msg.senderNickname}</span>
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
                        onClick={() => {
                          setReplyDraft({
                            id: String(msg.id),
                            senderNickname: String(msg.senderNickname || ""),
                            text: String(msg.text || ""),
                            firstAttachment: (Array.isArray(msg.attachments) && msg.attachments.length > 0) ? msg.attachments[0] : (msg.file || null)
                          });
                        }}
                      >
                        ↩
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
                        ↪
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
                    onClick={() => {
                      const rid = String(msg?.replyTo?.id || "");
                      if (!rid) return;
                      const el = document.getElementById(`msg-${rid}`);
                      if (!el) return;
                      try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* ignore */ }
                    }}
                    title="Перейти к сообщению"
                  >
                    <span className="message-reply__bar" aria-hidden="true" />
                    <span className="message-reply__meta">
                      <span className="message-reply__label">ответ</span>
                      <span className="message-reply__who">{String(msg.replyTo.senderNickname || "…")}</span>
                      <span className="message-reply__text">
                        {String(msg.replyTo.text || "").trim()
                          ? String(msg.replyTo.text).trim()
                          : (msg.replyTo.firstAttachment ? "📎 Вложение" : "…")}
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
                    {isSystemMissedCall && <span className="system-call-icon" aria-hidden>📞</span>}
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
                  // Optimistic local upload message: render local attachments with progress.
                  if (Array.isArray(msg?.clientAttachments) && msg.clientAttachments.length > 0) {
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
                                    <span className="pending-attachment__play" aria-hidden>▶</span>
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
                  const list = Array.isArray(msg.attachments) && msg.attachments.length > 0
                    ? msg.attachments
                    : (msg.file ? [msg.file] : []);
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
                                ×
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
                </React.Fragment>
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
            ↓
          </button>
        )}

        <footer className="composer">
          {replyDraft?.id && (
            <div className="composer-reply">
              <div className="composer-reply__meta">
                <div className="composer-reply__title">Ответ пользователю <b>{String(replyDraft.senderNickname || "…")}</b></div>
                <div className="composer-reply__text">
                  {String(replyDraft.text || "").trim()
                    ? String(replyDraft.text).trim()
                    : (replyDraft.firstAttachment ? "📎 Вложение" : "…")}
                </div>
              </div>
              <button
                type="button"
                className="composer-reply__close"
                aria-label="Отменить ответ"
                title="Отменить ответ"
                onClick={() => setReplyDraft(null)}
              >
                ×
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
                            <span className="pending-attachment__play" aria-hidden>▶</span>
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
                      ×
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
              +
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
          <div className="composer-input-wrap" onPaste={handleComposerPaste}>
            <input
              ref={composerInputRef}
              type="text"
              placeholder={selectedChannel ? "Написать сообщение…" : "Сначала выберите чат"}
              value={newMessage}
              onChange={(e) => {
                setNewMessage(e.target.value);
                emitTypingSoon();
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  // Discord-like: edit last message when composer is empty
                  startEditLastOwnMessage();
                  return;
                }
                if (e.key === "Enter") sendChatMessage();
                else emitTypingSoon();
              }}
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
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2v7z"/>
            </svg>
          </button>
          </div>
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
            return <div className="composer-typing" aria-live="polite">{text}</div>;
          })()}
        </footer>
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
              const ids = (isConnectedHere ? (voiceState.rosterUserIds || []) : (presence?.userIds || []))
                .map((x) => String(x))
                .filter(Boolean);
              const presenceIds = (presence?.userIds || [])
                .map((x) => String(x))
                .filter((id) => id && id !== meId);
              if (isConnectedHere ? !ids.length : !presenceIds.length) return null;

              const sharers = new Set(
                (isConnectedHere ? (voiceState.screenShareUserIds || []) : (presence?.screenShareUserIds || []))
                  .map((x) => String(x))
                  .filter(Boolean)
              );
              const others = (isConnectedHere ? ids : presenceIds).filter((x) => x && x !== meId);
              const meSpeaking = (voiceState.speakingUserIds || []).some((x) => String(x) === meId);
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
                        {voiceState.muted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                        {voiceState.deafened && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
                      </li>
                    )}
                    {others.map((id) => {
                      const isSp = (voiceState.speakingUserIds || []).some((x) => String(x) === String(id));
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
                              openUserCard(id, e);
                            }}
                            title="Настроить громкость пользователя"
                            style={{ cursor: "pointer" }}
                          >
                            {voicePeerNames[String(id)] || "…"}
                          </span>
                          {sharers.has(String(id)) && <span className="live-pill">в эфире</span>}
                          {isMuted && <span className="voice-flag" title="Микрофон выключен" aria-label="Микрофон выключен">🎤×</span>}
                          {isDeaf && <span className="voice-flag" title="Наушники выключены" aria-label="Наушники выключены">🎧×</span>}
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
                              ⛶
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
                      <b style={{ lineHeight: 1.1 }}>{m.nickname}</b>
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
                  <b style={{ lineHeight: 1.1 }}>{m.nickname}</b>
                  <span className="muted presence-line" style={{ fontSize: "12px" }}>
                    <span className="presence-dot presence-dot--online" aria-hidden />
                    Online
                  </span>
                </div>
                <span className="channel-item-spacer" />
                {uiMode === "server"
                  && selectedServer
                  && String(selectedServer.ownerUserId) === String(profile?.id)
                  && String(m.id) !== String(selectedServer.ownerUserId)
                  && String(m.id) !== String(profile?.id) && (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Удалить участника"
                    aria-label="Удалить участника"
                    onClick={() => confirmKickMember(m)}
                  >
                    ✕
                  </button>
                )}
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
                <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <b style={{ lineHeight: 1.1 }}>{m.nickname}</b>
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
                <span className="channel-item-spacer" />
                {uiMode === "server"
                  && selectedServer
                  && String(selectedServer.ownerUserId) === String(profile?.id)
                  && String(m.id) !== String(selectedServer.ownerUserId)
                  && String(m.id) !== String(profile?.id) && (
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Удалить участника"
                    aria-label="Удалить участника"
                    onClick={() => confirmKickMember(m)}
                  >
                    ✕
                  </button>
                )}
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
          <button type="button" className="server-menu-item" onClick={() => { copyServerInvite(); setServerMenuOpen(false); }}>
            Ссылка-приглашение
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
          {String(selectedServer.ownerUserId) === String(profile?.id) ? (
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

    {showRenameServer && (
      <div className="sheet-backdrop sheet-backdrop--center" onClick={() => setShowRenameServer(false)} role="presentation">
        <div className="sheet-panel sheet-panel--center" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-header">
            <span>Сервер</span>
            <button type="button" className="sheet-close" onClick={() => setShowRenameServer(false)} aria-label="Закрыть">×</button>
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
            <button type="button" className="sheet-close" onClick={() => setShowRenameChannel(false)} aria-label="Закрыть">×</button>
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
            <button type="button" className="sheet-close" onClick={() => setNotifSettingsModal((p) => ({ ...(p || {}), open: false }))} aria-label="Закрыть">×</button>
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
            setReplyDraft({
              id: String(messageMenuMsg.id),
              senderNickname: String(messageMenuMsg.senderNickname || ""),
              text: String(messageMenuMsg.text || ""),
              firstAttachment: (Array.isArray(messageMenuMsg.attachments) && messageMenuMsg.attachments.length > 0) ? messageMenuMsg.attachments[0] : (messageMenuMsg.file || null)
            });
          }}
        >
          <span className="message-menu__label">Ответить</span>
          <span className="message-menu__icon" aria-hidden>↩</span>
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
          <span className="message-menu__icon" aria-hidden>↪</span>
        </button>

        {String(messageMenuMsg.senderUserId) === String(profile?.id) && (
          <>
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
              <span className="message-menu__icon" aria-hidden>🗑</span>
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
        onClick={() => setMediaLightbox((s) => ({ ...s, open: false }))}
      >
        <div className="media-lightbox__inner" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="media-lightbox__close"
            onClick={() => setMediaLightbox((s) => ({ ...s, open: false }))}
            aria-label="Закрыть"
          >
            ×
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
            <video src={mediaLightbox.dataUrl} className="media-lightbox__media" controls autoPlay playsInline />
          ) : (
            <img src={mediaLightbox.dataUrl} alt="" className="media-lightbox__media" />
          )}
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
              ×
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
              ×
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
              ×
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
                ×
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
                    <div><b>{m.nickname}</b></div>
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
                    <div><b>{m.nickname}</b></div>
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
          className={`screen-overlay ${screenView.mode === "window" ? "screen-overlay--window" : "screen-overlay--full"}`}
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
                🎤
              </button>
              <button
                type="button"
                className={`user-voice-btn ${voiceState.deafened ? "is-off" : ""}`}
                onClick={toggleDeafen}
                title={voiceState.deafened ? "Включить звук" : "Режим без звука"}
                aria-pressed={voiceState.deafened}
              >
                🎧
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
                onClick={toggleNativeFullscreen}
                title={screenIsFullscreen ? "Выйти из полноэкранного режима" : "Полноэкранный режим браузера"}
                aria-label={screenIsFullscreen ? "Выйти из полноэкранного режима" : "Полноэкранный режим браузера"}
              >
                {screenIsFullscreen ? "⤫" : "⛶"}
              </button>
              <button
                type="button"
                className="user-voice-btn"
                onClick={toggleScreenViewMode}
                title={screenView.mode === "full" ? "Свернуть в окно" : "На весь экран"}
                aria-label={screenView.mode === "full" ? "Свернуть в окно" : "На весь экран"}
              >
                {screenView.mode === "full" ? "▢" : "⤢"}
              </button>
              <button
                type="button"
                className="voice-connection-hangup"
                onClick={closeScreenView}
                title="Отключиться от демонстрации"
                aria-label="Отключиться от демонстрации"
              >
                ✕
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
                ×
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
              <button type="button" className="sheet-close" onClick={() => setShowCreateTextChannel(false)} aria-label="Закрыть">×</button>
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
              <div className="row">
                <button type="button" className="small-btn" onClick={() => createChannel(newChannelName)}>Создать</button>
                <button type="button" className="small-btn" style={{ background: "#4a4f57" }} onClick={() => setShowCreateTextChannel(false)}>Отмена</button>
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
              <button type="button" className="sheet-close" onClick={() => setShowCreateVoiceChannel(false)} aria-label="Закрыть">×</button>
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

function createVoiceSession({ token, roomId, selfUserId, remoteAudioHost, remoteVideoHost, onState, iceServers }) {
  const servers = Array.isArray(iceServers) && iceServers.length
    ? iceServers
    : [{ urls: "stun:stun.l.google.com:19302" }];
  const peers = new Map();
  let lastRoster = [];
  let onJoinServerAck = null;
  let screenStream = null;
  let screenTrack = null;
  let audioCtx = null;
  let speakingTimer = null;

  let ws = null;
  let localStream = null;
  let destroyed = false;
  const LS_MIC = "sloncord_voice_mic_enabled";
  const LS_DEAF = "sloncord_voice_deafened";
  let micEnabledWanted = true;
  let deafened = false;
  try {
    const v = localStorage.getItem(LS_MIC);
    if (v === "0") micEnabledWanted = false;
    if (v === "1") micEnabledWanted = true;
  } catch { /* ignore */ }
  try {
    deafened = (localStorage.getItem(LS_DEAF) || "0") === "1";
  } catch { deafened = false; }

  function persistVoicePrefs() {
    try { localStorage.setItem(LS_MIC, micEnabledWanted ? "1" : "0"); } catch { /* ignore */ }
    try { localStorage.setItem(LS_DEAF, deafened ? "1" : "0"); } catch { /* ignore */ }
  }

  function effectiveMuted() {
    return deafened || !micEnabledWanted;
  }

  function applyLocalMuteDeafen() {
    const mutedNow = effectiveMuted();
    try {
      if (localStream) {
        localStream.getAudioTracks().forEach((t) => { t.enabled = !mutedNow; });
      }
    } catch { /* ignore */ }
    applyDeafenToAllAudio();
    setState({ deafened, muted: mutedNow });
    persistVoicePrefs();
    publishLocalFlags(mutedNow, deafened);
  }
  let pingTimer = null;
  let reconnectTimer = null;
  let reconnectFailures = 0;
  let keepAliveAudio = null;
  let visHandler = null;
  let gestureHandler = null;
  let healTimer = null;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";

  function hasTurnServer() {
    try {
      for (const s of servers || []) {
        const u = s?.urls;
        const list = Array.isArray(u) ? u : [u];
        for (const x of list) {
          const v = String(x || "");
          if (v.startsWith("turn:") || v.startsWith("turns:")) return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  function getPcConfig() {
    // Force all voice traffic via TURN (relay) when TURN is configured.
    // This maximizes compatibility/stability across networks/browsers at the cost of extra latency/server load.
    const forceRelay = hasTurnServer();
    return {
      iceServers: servers,
      iceTransportPolicy: forceRelay ? "relay" : "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 2
    };
  }

  function startKeepAliveAudio() {
    if (keepAliveAudio) return;
    // iOS Safari may suspend WebRTC/audio when screen locks. A silent looping audio
    // started from a user gesture (join) increases chances the audio session stays active.
    const a = document.createElement("audio");
    a.autoplay = true;
    a.loop = true;
    a.muted = false;
    a.volume = 0.0001;
    a.playsInline = true;
    a.setAttribute("playsinline", "true");
    // 1s silence WAV (tiny). Keeps media pipeline alive without audible sound.
    a.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
    keepAliveAudio = a;
    try {
      a.play?.().catch(() => {});
    } catch {
      // ignore
    }
  }

  function stopKeepAliveAudio() {
    const a = keepAliveAudio;
    keepAliveAudio = null;
    if (!a) return;
    try { a.pause?.(); } catch { /* ignore */ }
    try { a.src = ""; } catch { /* ignore */ }
  }

  function tryPlayAllRemoteMedia() {
    try {
      remoteAudioHost?.querySelectorAll?.("audio")?.forEach((el) => {
        try {
          el.muted = deafened;
          el.play?.().catch(() => {});
        } catch {
          // ignore
        }
      });
      (remoteVideoHost || document.querySelector(".voice-video-stage"))?.querySelectorAll?.("video")?.forEach((el) => {
        try {
          el.play?.().catch(() => {});
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }

  function installGestureMediaUnlock() {
    if (gestureHandler) return;
    gestureHandler = () => {
      if (destroyed) return;
      try {
        audioCtx?.resume?.().catch(() => {});
      } catch {
        // ignore
      }
      tryPlayAllRemoteMedia();
    };
    window.addEventListener("pointerdown", gestureHandler, { passive: true });
    window.addEventListener("keydown", gestureHandler, { passive: true });
  }

  function uninstallGestureMediaUnlock() {
    if (!gestureHandler) return;
    try { window.removeEventListener("pointerdown", gestureHandler); } catch { /* ignore */ }
    try { window.removeEventListener("keydown", gestureHandler); } catch { /* ignore */ }
    gestureHandler = null;
  }

  function installVisibilityRecovery() {
    if (visHandler) return;
    visHandler = () => {
      if (destroyed) return;
      if (!document.hidden) {
        // On unlock/resume: try to resume audio + restart ICE
        try { keepAliveAudio?.play?.().catch(() => {}); } catch { /* ignore */ }
        try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
        tryPlayAllRemoteMedia();
        try { renegotiateAllPeers(); } catch { /* ignore */ }
        try {
          peers.forEach((p, pid) => {
            try { p.pc.restartIce?.(); } catch { /* ignore */ }
            if (String(selfUserId) < String(pid)) negotiateCaller(String(pid)).catch(() => {});
          });
        } catch {
          // ignore
        }
      }
    };
    document.addEventListener("visibilitychange", visHandler, { passive: true });
    window.addEventListener("pageshow", visHandler, { passive: true });
  }

  function uninstallVisibilityRecovery() {
    if (!visHandler) return;
    try { document.removeEventListener("visibilitychange", visHandler); } catch { /* ignore */ }
    try { window.removeEventListener("pageshow", visHandler); } catch { /* ignore */ }
    visHandler = null;
  }
  const wsUrl = `${protocol}://${window.location.host}/ws/voice?token=${encodeURIComponent(token)}`;
  // If peerJoined arrives before we have mic access, buffer it and process after localStream is ready.
  const pendingPeerJoins = new Set();
  // If signaling arrives before we have mic access, buffer and replay after localStream is ready.
  const pendingSignals = [];

  function setState(patch) {
    onState((prev) => (typeof patch === "function" ? patch(prev) : { ...prev, ...patch }));
  }

  function countPeers() {
    let n = 0;
    peers.forEach((p) => {
      if (p.pc.connectionState !== "closed") n += 1;
    });
    return n;
  }

  function applyDeafenToAllAudio() {
    peers.forEach((p) => {
      if (p.audioEl) p.audioEl.muted = deafened;
    });
    if (remoteAudioHost) {
      remoteAudioHost.querySelectorAll("audio").forEach((el) => {
        el.muted = deafened;
      });
    }
  }

  function updatePeerMetrics() {
    setState((prev) => ({
      ...prev,
      peers: countPeers(),
      remotePeerUserIds: Array.from(peers.keys(), (k) => String(k))
    }));
    recomputeLinkReady();
  }

  function startHealLoop() {
    if (healTimer) return;
    healTimer = setInterval(() => {
      try {
        if (destroyed) return;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!localStream) return;
        if (!Array.isArray(lastRoster) || lastRoster.length === 0) return;
        tryPlayAllRemoteMedia();
        reconcilePeersWithRoster(lastRoster).catch(() => {});
      } catch {
        // ignore
      }
    }, 3000);
  }

  function recomputeLinkReady() {
    if (selfUserId == null) {
      return;
    }
    if (!lastRoster.length) {
      setState({ mediaLinkReady: false });
      return;
    }
    const me = String(selfUserId);
    const others = lastRoster.filter((id) => String(id) !== me);
    if (others.length === 0) {
      setState({ mediaLinkReady: true });
      return;
    }
    for (const oid of others) {
      const p = peers.get(String(oid));
      if (!p) {
        setState({ mediaLinkReady: false });
        return;
      }
      if (!["connected", "completed"].includes(p.pc.iceConnectionState)) {
        setState({ mediaLinkReady: false });
        return;
      }
    }
    setState({ mediaLinkReady: true });
  }

  async function reconcilePeersWithRoster(ids) {
    if (selfUserId == null) return;
    if (!Array.isArray(ids) || ids.length === 0) return;
    // Ensure we have a peer connection object for every other user in the roster
    // and (if we're the deterministic offerer) start negotiation when needed.
    const me = String(selfUserId);
    for (const rid of ids) {
      const other = String(rid);
      if (!other || other === me) continue;
      try {
        ensurePeer(other);
      } catch {
        // ignore
      }
      // Only one side offers, to avoid SDP glare.
      if (me < other) {
        const p = peers.get(String(other));
        const pc = p?.pc;
        const iceBad = pc && (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected");
        const notReady = pc && (pc.connectionState !== "connected" || !pc.remoteDescription);
        if (pc && pc.signalingState === "stable" && (notReady || iceBad)) {
          if (iceBad) {
            try { pc.restartIce?.(); } catch { /* ignore */ }
          }
          try {
            await negotiateCaller(other);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  function ensureAudioElement(peerId) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const id = `remote-audio-${pid}`;
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("audio");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.setAttribute("playsinline", "true");
    if (deafened) el.muted = true;
    remoteAudioHost.appendChild(el);
    return el;
  }

  function ensureVideoElement(peerId) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const id = `remote-video-${pid}`;
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("video");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.muted = true; // remote video shouldn't echo; audio is separate
    el.setAttribute("playsinline", "true");
    (remoteVideoHost || document.querySelector(".voice-video-stage"))?.appendChild(el);
    return el;
  }

  function removeVideoElement(peerId) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const el = document.getElementById(`remote-video-${pid}`);
    if (el) el.remove();
  }

  function removeAudioElement(peerId) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const el = document.getElementById(`remote-audio-${pid}`);
    if (el) el.remove();
  }

  function clearVoiceTimers() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (speakingTimer) {
      clearInterval(speakingTimer);
      speakingTimer = null;
    }
    if (healTimer) {
      clearInterval(healTimer);
      healTimer = null;
    }
  }

  function startVoicePing() {
    if (pingTimer) {
      clearInterval(pingTimer);
    }
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          sendWs({ type: "ping" });
        } catch {
          // ignore
        }
      }
    }, 20000);
  }

  function scheduleVoiceReconnect() {
    if (destroyed) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectFailures += 1;
    if (reconnectFailures > 18) {
      setState((prev) => ({
        ...prev,
        connected: false,
        joining: false,
        mediaLinkReady: false,
        room: "",
        peers: 0,
        remotePeerUserIds: [],
        rosterUserIds: []
      }));
      return;
    }
    const base = 400;
    const cap = 20000;
    const exp = Math.min(16, Math.max(0, reconnectFailures - 1));
    const delay = Math.min(cap, base * Math.pow(1.6, exp));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      (async () => {
        if (destroyed) return;
        if (!localStream) return;
        try {
          try {
            destroyAllPeers();
          } catch {
            // ignore
          }
          await openWebSocketAndJoin();
          setState((prev) => ({ ...prev, connected: true, room: roomId, peers: countPeers() }));
          reconnectFailures = 0;
        } catch {
          scheduleVoiceReconnect();
        }
      })();
    }, delay);
  }

  async function openWebSocketAndJoin() {
    if (destroyed) {
      return;
    }
    return new Promise((resolve, reject) => {
      let openTimer = null;
      const s = new WebSocket(wsUrl);
      openTimer = setTimeout(() => {
        try {
          s.close();
        } catch {
          // ignore
        }
        reject(new Error("Таймаут подключения WebSocket (голос)"));
      }, 6000);
      s.onopen = () => {
        if (openTimer) {
          clearTimeout(openTimer);
          openTimer = null;
        }
        if (destroyed) {
          try {
            s.close();
          } catch {
            // ignore
          }
          reject(new Error("Отменено"));
          return;
        }
        ws = s;
        s.onmessage = (ev) => onMessage(ev);
        s.onclose = () => {
          if (destroyed) {
            return;
          }
          if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
          }
          try {
            destroyAllPeers();
          } catch {
            // ignore
          }
          setState((prev) => ({ ...prev, connected: false, joining: false, mediaLinkReady: false, room: roomId, peers: 0, remotePeerUserIds: [] }));
          scheduleVoiceReconnect();
        };
        s.onerror = () => {
          // onclose will fire and schedule reconnect
        };
        try {
          sendWs({ type: "joinRoom", roomId });
        } catch (e) {
          reject(e);
          return;
        }
        startVoicePing();
        startHealLoop();
        resolve();
      };
      s.onerror = () => {
        if (openTimer) {
          clearTimeout(openTimer);
          openTimer = null;
        }
        try {
          s.close();
        } catch {
          // ignore
        }
        reject(new Error("Не удалось подключить WebSocket"));
      };
    });
  }

  function publishLocalFlags(mutedNow = effectiveMuted(), deafNow = deafened) {
    try {
      sendWs({ type: "setUserFlags", roomId, muted: !!mutedNow, deafened: !!deafNow });
    } catch {
      // ignore
    }
  }

  function sendWs(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket не подключен");
    }
    ws.send(JSON.stringify(obj));
  }

  function wirePeerConnection(peerId, pc) {
    pc.onicecandidate = async (ev) => {
      if (!ev.candidate) return;
      try {
        await sendWs({
          type: "signal",
          targetUserId: peerId,
          signalType: "ice",
          payload: JSON.stringify(ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate)
        });
      } catch {
        // ignore
      }
    };

    pc.ontrack = (ev) => {
      const p = peers.get(peerId);
      if (!p) return;
      const stream = ev.streams[0] || (ev.track ? new MediaStream([ev.track]) : null);
      if (stream) {
        if (ev.track && ev.track.kind === "video") {
          if (p.videoEl) {
            p.videoEl.srcObject = stream;
            p.videoEl.play?.().catch(() => {});
          }
          p.hasVideo = true;
          setState((prev) => ({
            ...prev,
            screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(peerId)]))
          }));
        } else {
          p.audioEl.srcObject = stream;
          p.audioEl.muted = deafened;
          p.audioEl.play?.().catch(() => {});
          p.audioStream = stream;
          if (ev.track) {
            ev.track.onunmute = () => {
              tryPlayAllRemoteMedia();
            };
            ev.track.onended = () => {
              try {
                pc.restartIce?.();
                if (String(selfUserId) < String(peerId)) negotiateCaller(peerId).catch(() => {});
              } catch {
                /* ignore */
              }
            };
          }
          tryStartSpeakingMeter();
          // Some browsers (notably iOS) require a gesture AFTER the track arrives to actually play audio.
          tryPlayAllRemoteMedia();
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      recomputeLinkReady();
      if (pc.iceConnectionState === "disconnected") {
        // Mobile networks often flap briefly; try ICE restart before tearing down.
        setTimeout(() => {
          try {
            if (destroyed) return;
            if (pc.iceConnectionState !== "disconnected") return;
            pc.restartIce?.();
            if (String(selfUserId) < String(peerId)) negotiateCaller(peerId).catch(() => {});
          } catch {
            // ignore
          }
        }, 1200);
      } else if (pc.iceConnectionState === "failed") {
        try {
          pc.restartIce?.();
          if (String(selfUserId) < String(peerId)) negotiateCaller(peerId).catch(() => {});
        } catch {
          // ignore
        }
      } else if (pc.iceConnectionState === "closed") {
        cleanupPeer(peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      recomputeLinkReady();
      if (pc.connectionState === "failed") {
        try {
          pc.restartIce?.();
          if (String(selfUserId) < String(peerId)) negotiateCaller(peerId).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    };
  }

  function ensurePeer(peerId) {
    const key = String(peerId);
    if (peers.has(key)) return peers.get(key);

    const audioEl = ensureAudioElement(key);
    const videoEl = ensureVideoElement(key);
    const pc = new RTCPeerConnection(getPcConfig());
    // Safari/iOS and some Chromium builds behave better when transceivers exist up-front.
    // This also helps screen-share negotiation (video) be established reliably.
    try {
      pc.addTransceiver?.("audio", { direction: "sendrecv" });
    } catch {
      // ignore
    }
    try {
      pc.addTransceiver?.("video", { direction: "recvonly" });
    } catch {
      // ignore
    }
    wirePeerConnection(key, pc);

    peers.set(key, { pc, audioEl, videoEl, pendingIce: [] });
    return peers.get(key);
  }

  async function flushPendingIce(peerId) {
    const key = String(peerId);
    const p = peers.get(key);
    if (!p || !p.pendingIce?.length) {
      return;
    }
    const { pc } = p;
    const list = p.pendingIce;
    p.pendingIce = [];
    for (const c of list) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        // ignore
      }
    }
  }

  function addLocalTracks(peerId) {
    if (!localStream) return;
    const p = ensurePeer(peerId);
    const { pc } = p;

    const hasAudioSender = pc.getSenders().some((s) => s.track && s.track.kind === "audio");
    if (hasAudioSender) return;

    localStream.getAudioTracks().forEach((t) => {
      try {
        pc.addTrack(t, localStream);
      } catch {
        // ignore
      }
    });
  }

  async function negotiateCaller(peerId) {
    addLocalTracks(peerId);
    const p = ensurePeer(peerId);
    const { pc } = p;

    if (pc.signalingState !== "stable") return;

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    await sendWs({ type: "signal", targetUserId: peerId, signalType: "offer", payload: JSON.stringify(pc.localDescription) });
    await flushPendingIce(peerId);
  }

  function cleanupPeer(peerId) {
    const key = String(peerId);
    const p = peers.get(key);
    if (!p) return;
    try {
      p.pc.onicecandidate = null;
      p.pc.ontrack = null;
      p.pc.oniceconnectionstatechange = null;
      p.pc.onconnectionstatechange = null;
      p.pc.close();
    } catch {
      // ignore
    }
    removeAudioElement(key);
    removeVideoElement(key);
    peers.delete(key);
    setState((prev) => ({
      ...prev,
      screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== String(key))
    }));
    updatePeerMetrics();
  }

  function destroyAllPeers() {
    Array.from(peers.keys()).forEach((id) => cleanupPeer(id));
  }

  function tryStartSpeakingMeter() {
    if (speakingTimer) return;
    // Start meter only after we have at least one audio stream (local or remote).
    const lastAbove = new Map(); // userId -> ms
    const holdMs = 420;
    speakingTimer = setInterval(() => {
      if (destroyed) return;
      const now = Date.now();
      const speakingSet = new Set();
      try {
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === "suspended") {
          // Resume in case browser suspended it; join() is user gesture so usually ok.
          audioCtx.resume?.().catch(() => {});
        }
      } catch {
        return;
      }

      const threshold = 0.03; // tuned for speech vs noise

      // local speaking
      try {
        if (localStream) {
          if (!peers._localAnalyser) {
            const src = audioCtx.createMediaStreamSource(localStream);
            const an = audioCtx.createAnalyser();
            an.fftSize = 512;
            src.connect(an);
            peers._localAnalyser = an;
          }
          const an = peers._localAnalyser;
          if (an) {
            const data = new Uint8Array(an.fftSize);
            an.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            if (rms > threshold) lastAbove.set(String(selfUserId), now);
          }
        }
      } catch {
        // ignore
      }

      // remote speaking
      peers.forEach((p, pid) => {
        try {
          if (!p.audioStream) return;
          if (!p.analyser) {
            const src = audioCtx.createMediaStreamSource(p.audioStream);
            const an = audioCtx.createAnalyser();
            an.fftSize = 512;
            src.connect(an);
            p.analyser = an;
          }
          const an = p.analyser;
          const data = new Uint8Array(an.fftSize);
          an.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          if (rms > threshold) lastAbove.set(String(pid), now);
        } catch {
          // ignore
        }
      });

      // Apply hold to avoid flicker.
      for (const [uid, t] of lastAbove.entries()) {
        if (now - t <= holdMs) speakingSet.add(String(uid));
      }

      setState((prev) => {
        const prevIds = (prev.speakingUserIds || []).map((x) => String(x));
        const nextIds = Array.from(speakingSet)
          .filter((x) => x && x !== "null" && x !== "undefined")
          .map((x) => String(x));
        if (prevIds.length === nextIds.length && prevIds.every((x, i) => x === nextIds[i])) {
          return prev;
        }
        return { ...prev, speakingUserIds: nextIds };
      });
    }, 140);
  }

  function isOffererFor(otherUserId) {
    if (selfUserId == null) return false;
    return String(selfUserId) < String(otherUserId);
  }

  async function renegotiateAllPeers() {
    for (const pid of Array.from(peers.keys())) {
      if (isOffererFor(pid)) {
        try {
          await negotiateCaller(pid);
        } catch {
          // ignore
        }
      }
    }
  }

  async function startScreenShare() {
    if (screenTrack) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== "function") {
      throw new Error("Демонстрация экрана не поддерживается в этом браузере/устройстве (часто так на мобильных).");
    }
    const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenStream = ds;
    screenTrack = ds.getVideoTracks()?.[0] || null;
    if (!screenTrack) {
      try { ds.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      screenStream = null;
      throw new Error("Не удалось получить видеопоток экрана");
    }

    screenTrack.onended = () => {
      stopScreenShare().catch(() => {});
    };

    // Attach to each peer; negotiation happens in background.
    peers.forEach((p) => {
      try {
        p.pc.addTrack(screenTrack, screenStream);
      } catch {
        // ignore
      }
    });

    setState((prev) => ({
      ...prev,
      sharingScreen: true,
      screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(selfUserId)]))
    }));
    try {
      await sendWs({ type: "screenShare", roomId, enabled: true });
    } catch {
      // ignore
    }
    await renegotiateAllPeers();
  }

  async function stopScreenShare() {
    if (!screenTrack) {
      setState((prev) => ({
        ...prev,
        sharingScreen: false,
        screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== String(selfUserId))
      }));
      return;
    }
    const tr = screenTrack;
    screenTrack = null;
    const ss = screenStream;
    screenStream = null;

    peers.forEach((p) => {
      try {
        const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender) {
          try { p.pc.removeTrack(sender); } catch { /* ignore */ }
        }
      } catch {
        // ignore
      }
    });

    try {
      tr.stop();
    } catch {
      // ignore
    }
    try {
      ss?.getTracks?.().forEach((t) => t.stop());
    } catch {
      // ignore
    }

    setState((prev) => ({
      ...prev,
      sharingScreen: false,
      screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== String(selfUserId))
    }));
    try {
      await sendWs({ type: "screenShare", roomId, enabled: false });
    } catch {
      // ignore
    }
    await renegotiateAllPeers();
  }

  async function handleSignal(msg) {
    const from = String(msg.fromUserId);
    if (!from) return;

    const raw = JSON.parse(msg.payload);

    if (msg.signalType === "offer") {
      addLocalTracks(from);
      const p = ensurePeer(from);
      const { pc } = p;
      // Glare handling (Perfect Negotiation-lite):
      // deterministic offerer is the lower userId; the higher one is "polite".
      const polite = selfUserId != null && String(selfUserId) > String(from);
      if (pc.signalingState !== "stable") {
        if (!polite) {
          return; // ignore offer if we're not polite
        }
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {
          // ignore
        }
      }

      await pc.setRemoteDescription(raw);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendWs({ type: "signal", targetUserId: from, signalType: "answer", payload: JSON.stringify(pc.localDescription) });
      await flushPendingIce(from);
    } else if (msg.signalType === "answer") {
      const p = ensurePeer(from);
      const { pc } = p;
      // Ignore duplicate/out-of-order answers (can happen with retries/buffering).
      if (pc.signalingState !== "have-local-offer") {
        return;
      }
      await pc.setRemoteDescription(raw);
      await flushPendingIce(from);
    } else if (msg.signalType === "ice") {
      const p = ensurePeer(from);
      const { pc } = p;
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(raw);
        } catch {
          // ignore
        }
      } else {
        if (!p.pendingIce) p.pendingIce = [];
        p.pendingIce.push(raw);
      }
    }

    updatePeerMetrics();
  }

  async function onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "pong") {
      return;
    }

    if (msg.type === "joinedRoom" && String(msg.roomId) === String(roomId)) {
      if (onJoinServerAck) {
        const c = onJoinServerAck;
        onJoinServerAck = null;
        c();
      }
    }

    if (msg.type === "roomRoster" && String(msg.roomId) === String(roomId)) {
      const ids = (msg.userIds || []).map((x) => String(x));
      lastRoster = ids;
      const mutedIds = (msg.mutedUserIds || []).map((x) => String(x));
      const deafIds = (msg.deafenedUserIds || []).map((x) => String(x));
      setState((prev) => ({ ...prev, rosterUserIds: ids, mutedUserIds: mutedIds, deafenedUserIds: deafIds }));
      if (onJoinServerAck) {
        const c = onJoinServerAck;
        onJoinServerAck = null;
        c();
      }
      // Reconcile peers based on roster to support 3+ participants reliably.
      // If mic isn't ready yet, buffer via pendingPeerJoins/pendingSignals and renegotiate after getUserMedia.
      if (localStream) {
        reconcilePeersWithRoster(ids).catch(() => {});
      } else {
        ids
          .filter((id) => String(id) !== String(selfUserId))
          .forEach((id) => pendingPeerJoins.add(String(id)));
      }
      recomputeLinkReady();
      return;
    }

    if (msg.type === "peerJoined") {
      if (selfUserId == null) return;
      const other = String(msg.fromUserId);
      if (other === String(selfUserId)) return;

      if (!localStream) {
        pendingPeerJoins.add(other);
        return;
      }

      // Only one side creates the offer, otherwise two simultaneous offers (SDP "glare") and audio fails.
      if (String(selfUserId) < other) {
        await negotiateCaller(other);
      }
      updatePeerMetrics();
    }

    if (msg.type === "peerLeft") {
      if (msg.fromUserId != null) cleanupPeer(String(msg.fromUserId));
    }

    if (msg.type === "signal") {
      if (!localStream) {
        pendingSignals.push(msg);
        return;
      }
      await handleSignal(msg);
    }

    if (msg.type === "error") {
      console.warn("voice error:", msg.payload);
    }
  }

  return {
    async join() {
      reconnectFailures = 0;
      const maxAttempts = 3;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // ensure clean state between attempts
          onJoinServerAck = null;
          try { ws?.close?.(); } catch { /* ignore */ }
          ws = null;

          // Do mic permission and ws join in parallel: mic prompt can take a while.
          const micPromise = (async () => {
            if (localStream) return localStream;
            const s = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
              },
              video: false
            });
            s.getAudioTracks().forEach((t) => {
              t.enabled = !effectiveMuted();
            });
            localStream = s;

            // process buffered joins after mic is ready
            try {
              if (selfUserId != null && pendingPeerJoins.size) {
                const ids = Array.from(pendingPeerJoins);
                pendingPeerJoins.clear();
                for (const other of ids) {
                  if (String(other) === String(selfUserId)) continue;
                  if (String(selfUserId) < String(other)) {
                    try {
                      await negotiateCaller(String(other));
                    } catch {
                      // ignore
                    }
                  }
                }
              }
            } catch {
              // ignore
            }

            // replay buffered signaling that may include the initial offer/ice
            try {
              if (pendingSignals.length) {
                const list = pendingSignals.splice(0, pendingSignals.length);
                for (const m of list) {
                  try {
                    await handleSignal(m);
                  } catch {
                    // ignore
                  }
                }
              }
            } catch {
              // ignore
            }

            // Ensure tracks are attached and renegotiate if we joined before mic was ready.
            try {
              await renegotiateAllPeers();
            } catch {
              // ignore
            }

            return s;
          })();

          let joinTimer;
          const joinPromise = new Promise((resolve, reject) => {
            joinTimer = setTimeout(() => {
              onJoinServerAck = null;
              reject(new Error("Сервер не подтвердил вход в голосовой канал. Повторите попытку."));
            }, 12000);
            onJoinServerAck = () => {
              clearTimeout(joinTimer);
              onJoinServerAck = null;
              resolve();
            };
            openWebSocketAndJoin().catch((e) => {
              clearTimeout(joinTimer);
              onJoinServerAck = null;
              reject(e);
            });
          });

          await Promise.all([micPromise, joinPromise]);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // small backoff before retrying; avoids immediate reconnect storms on flaky networks
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 600 * attempt));
          }
        }
      }
      if (lastErr) throw lastErr;

      // publish initial mute/deafen state to server so roster shows icons
      applyLocalMuteDeafen();

      startKeepAliveAudio();
      installGestureMediaUnlock();
      installVisibilityRecovery();

      // Start local speaking meter even if we're alone (no remote tracks yet).
      try {
        tryStartSpeakingMeter();
      } catch {
        // ignore
      }

      setState({
        connected: true,
        joining: false,
        room: roomId,
        peers: countPeers(),
        muted: effectiveMuted(),
        remotePeerUserIds: Array.from(peers.keys(), (k) => String(k)),
        deafened
      });
      recomputeLinkReady();
    },

    toggleMute() {
      micEnabledWanted = !micEnabledWanted;
      applyLocalMuteDeafen();
    },

    toggleDeafen() {
      deafened = !deafened;
      applyLocalMuteDeafen();
    },

    async toggleScreenShare() {
      if (screenTrack) {
        await stopScreenShare();
      } else {
        await startScreenShare();
      }
    },

    // Used by UI (screen view) to speed up getting the remote video track.
    ensurePeerFor(peerId) {
      const other = String(peerId);
      if (!other || selfUserId == null) return;
      ensurePeer(other);
      if (String(selfUserId) < other) {
        negotiateCaller(other).catch(() => {});
      }
    },

    renegotiateAll() {
      return renegotiateAllPeers();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      deafened = false;
      onJoinServerAck = null;
      lastRoster = [];
      screenTrack = null;
      try { screenStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
      screenStream = null;
      try {
        if (audioCtx && audioCtx.state !== "closed") audioCtx.close?.();
      } catch {
        // ignore
      }
      audioCtx = null;
      clearVoiceTimers();
      reconnectFailures = 0;
      uninstallVisibilityRecovery();
      uninstallGestureMediaUnlock();
      stopKeepAliveAudio();

      try {
        sendWs({ type: "leaveRoom" });
      } catch {
        // ignore
      }

      try {
        ws?.close();
      } catch {
        // ignore
      }

      ws = null;

      try {
        localStream?.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
      localStream = null;

      destroyAllPeers();
      setState({
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
    }
  };
}

let _mediasoupClientPromise = null;
async function loadMediasoupClient() {
  if (_mediasoupClientPromise) return _mediasoupClientPromise;
  _mediasoupClientPromise = (async () => {
    // mediasoup-client ships as CJS/TS library; we bundle it for browser via deploy/install.sh
    // and serve as same-origin script to avoid blocked CDNs.
    if (window.mediasoupClient) return window.mediasoupClient;

    await new Promise((resolve, reject) => {
      const id = "sloncord-mediasoup-client-bundle";
      const existing = document.getElementById(id);
      if (existing) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.id = id;
      s.async = true;
      s.src = "/mediasoup-client.bundle.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Не удалось загрузить mediasoup-client (bundle)"));
      document.head.appendChild(s);
    });

    if (!window.mediasoupClient) throw new Error("mediasoupClient не найден после загрузки bundle");
    return window.mediasoupClient;
  })();
  return _mediasoupClientPromise;
}

function createSfuVoiceSession({ token, roomId, selfUserId, remoteAudioHost, remoteVideoHost, onState, sfuUrl, sfuToken }) {
  let destroyed = false;

  // Presence WS (reuse existing backend voice server, but in SFU mode).
  let presenceWs = null;
  let presencePing = null;
  let presenceScreenHeartbeat = null;
  let presenceReconnectTimer = null;
  let presenceReconnectFailures = 0;
  const LS_MIC = "sloncord_voice_mic_enabled";
  const LS_DEAF = "sloncord_voice_deafened";
  let micEnabledWanted = true;
  let deafened = false;
  try {
    const v = localStorage.getItem(LS_MIC);
    if (v === "0") micEnabledWanted = false;
    if (v === "1") micEnabledWanted = true;
  } catch { /* ignore */ }
  try {
    deafened = (localStorage.getItem(LS_DEAF) || "0") === "1";
  } catch { deafened = false; }
  let lastRoster = [];

  // SFU media.
  let sfuWs = null;
  let device = null;
  let sendTransport = null;
  let recvTransport = null;
  let localMicStream = null;
  let camStream = null;
  let screenStream = null;
  let micProducer = null;
  let camProducer = null;
  let screenProducer = null;
  let screenAudioProducer = null;
  const consumers = new Map(); // consumerId -> consumer
  const producerMetaById = new Map(); // producerId -> { userId, source }
  const consumedProducerIds = new Set(); // producerId -> consumed
  let audioCtx = null;
  let speakingTimer = null;
  const speakingAnalysers = new Map(); // userId -> { analyser }
  const audioElByUserId = new Map(); // key(userId:source) -> HTMLAudioElement
  const audioPipeByUserId = new Map(); // userId -> { gainNode, srcNode, destNode, originalStream }
  const userVolumePctByUserId = new Map(); // userId -> 0..300 (runtime cache)
  const directStreamByUserId = new Map(); // userId -> MediaStream (latest direct consumer stream)
  const screenAudioPctByUserId = new Map(); // userId -> 0..300 (local-only, for screenAudio)
  let gestureHandler = null;
  let playbackHealTimer = null;
  let sfuVisibilityHandler = null;
  let recvTransportRecoveryTimer = null;

  function teardownUserPipe(uid) {
    const pipe = audioPipeByUserId.get(uid);
    if (!pipe) return;
    try { pipe.srcNode?.disconnect?.(); } catch { /* ignore */ }
    try { pipe.gainNode?.disconnect?.(); } catch { /* ignore */ }
    audioPipeByUserId.delete(uid);
  }

  function tryPlayAllRemoteMedia() {
    try {
      audioElByUserId.forEach((el) => {
        try {
          if (!el) return;
          // Ensure deafen is the only reason for muting.
          el.muted = !!deafened;
          if (!deafened && el.muted) el.muted = false;
          // Re-apply volume/gain before playing (covers cases where volume got stuck at 0).
          try {
            const key = String(el.id || "").replace("sfu-remote-audio-", "");
            const [uid, src] = key.split(":");
            applyUserVolume(String(uid || ""), String(src || "mic"));
          } catch { /* ignore */ }
          el.play?.().catch(() => {});
        } catch {
          // ignore
        }
      });
      remoteAudioHost?.querySelectorAll?.("audio")?.forEach?.((el) => {
        try {
          el.muted = !!deafened;
          if (!deafened && el.muted) el.muted = false;
          try {
            const key = String(el.id || "").replace("sfu-remote-audio-", "");
            const [uid, src] = key.split(":");
            applyUserVolume(String(uid || ""), String(src || "mic"));
          } catch { /* ignore */ }
          el.play?.().catch(() => {});
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }

  function startPlaybackHeal() {
    if (playbackHealTimer) return;
    playbackHealTimer = setInterval(() => {
      if (destroyed) return;
      if (deafened) return;
      tryPlayAllRemoteMedia();
      try {
        audioElByUserId.forEach((el) => {
          try {
            if (!el) return;
            if (!deafened && el.muted) el.muted = false;
            try {
              const key = String(el.id || "").replace("sfu-remote-audio-", "");
              const [uid, src] = key.split(":");
              applyUserVolume(String(uid || ""), String(src || "mic"));
            } catch { /* ignore */ }
            if (el.srcObject && el.paused) el.play?.().catch(() => {});
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }

      try {
        const hasAnyAudio = Array.from(audioElByUserId.values()).some((el) => {
          try {
            const so = el?.srcObject;
            return !!(so && so instanceof MediaStream && (so.getAudioTracks?.() || []).length);
          } catch {
            return false;
          }
        });
        if (!hasAnyAudio && (lastRoster || []).length > 1) {
          resyncRemoteProducers("heal-no-audio");
        }
      } catch {
        /* ignore */
      }
    }, 2200);
  }

  function stopPlaybackHeal() {
    if (!playbackHealTimer) return;
    try { clearInterval(playbackHealTimer); } catch { /* ignore */ }
    playbackHealTimer = null;
  }

  function installGestureMediaUnlock() {
    if (gestureHandler) return;
    gestureHandler = () => {
      if (destroyed) return;
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      tryPlayAllRemoteMedia();
    };
    try { window.addEventListener("pointerdown", gestureHandler, { passive: true }); } catch { /* ignore */ }
    try { window.addEventListener("keydown", gestureHandler, { passive: true }); } catch { /* ignore */ }
  }

  function uninstallGestureMediaUnlock() {
    if (!gestureHandler) return;
    try { window.removeEventListener("pointerdown", gestureHandler); } catch { /* ignore */ }
    try { window.removeEventListener("keydown", gestureHandler); } catch { /* ignore */ }
    gestureHandler = null;
  }

  function installSfuVisibilityRecovery() {
    if (sfuVisibilityHandler) return;
    sfuVisibilityHandler = () => {
      if (destroyed || document.hidden) return;
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      tryPlayAllRemoteMedia();
      resyncRemoteProducers("visibility").catch(() => {});
    };
    try { document.addEventListener("visibilitychange", sfuVisibilityHandler, { passive: true }); } catch { /* ignore */ }
    try { window.addEventListener("pageshow", sfuVisibilityHandler, { passive: true }); } catch { /* ignore */ }
  }

  function uninstallSfuVisibilityRecovery() {
    if (!sfuVisibilityHandler) return;
    try { document.removeEventListener("visibilitychange", sfuVisibilityHandler); } catch { /* ignore */ }
    try { window.removeEventListener("pageshow", sfuVisibilityHandler); } catch { /* ignore */ }
    sfuVisibilityHandler = null;
  }

  function ensureUserPipe(uid, el) {
    const ctx = ensureAudioCtx();
    if (!ctx || !el) return false;
    const existing = audioPipeByUserId.get(uid);
    if (existing?.gainNode && existing?.destNode?.stream) {
      // Keep audio element on the pipe output.
      try { if (el.srcObject !== existing.destNode.stream) el.srcObject = existing.destNode.stream; } catch { /* ignore */ }
      return true;
    }
    try {
      const so = el.srcObject;
      const srcStream = (so && so instanceof MediaStream) ? so : (directStreamByUserId.get(uid) || null);
      if (!srcStream) return false;
      const srcNode = ctx.createMediaStreamSource(srcStream);
      const gainNode = ctx.createGain();
      const destNode = ctx.createMediaStreamDestination();
      srcNode.connect(gainNode);
      gainNode.connect(destNode);
      el.srcObject = destNode.stream;
      audioPipeByUserId.set(uid, { gainNode, srcNode, destNode, originalStream: srcStream });
      trySetSink(el).catch(() => {});
      el.play?.().catch(() => {});
      return true;
    } catch {
      teardownUserPipe(uid);
      return false;
    }
  }

  function updateUserPipeSource(uid, newDirectStream, el) {
    const pipe = audioPipeByUserId.get(uid);
    if (!pipe) return false;
    const ctx = ensureAudioCtx();
    if (!ctx) return false;
    try {
      // Rebuild source node to follow new incoming track/stream.
      try { pipe.srcNode?.disconnect?.(); } catch { /* ignore */ }
      const srcNode = ctx.createMediaStreamSource(newDirectStream);
      srcNode.connect(pipe.gainNode);
      pipe.srcNode = srcNode;
      pipe.originalStream = newDirectStream;
      if (pipe.destNode?.stream && el && el.srcObject !== pipe.destNode.stream) {
        el.srcObject = pipe.destNode.stream;
      }
      el?.play?.().catch(() => {});
      return true;
    } catch {
      teardownUserPipe(uid);
      return false;
    }
  }
  let speakerGain = 1.0; // 0..1
  let micGain = 1.0; // 0..1
  let micGainNode = null;
  let outputDeviceId = "";
  let advancedNs = false;
  let echoCancellation = true;
  let noiseSuppression = true;
  let autoGainControl = true;
  let inputSensitivityAuto = true;
  let inputSensitivity = 55; // 0..100 (higher => less sensitive)
  let currentInputDeviceId = "";
  let micProducedTrack = null;
  let localNoiseFloor = 0.02;
  let lastLocalRms = 0;
  let lastLocalEffectiveRms = 0;
  let lastLocalMeterRms = 0;
  let lastMeterAtMs = 0;
  let lastLocalThreshold = 0.03;
  let lastLocalGateOpen = false;
  let peakHoldUntilMs = 0;
  let peakRms = 0;

  function buildAudioConstraints(deviceId) {
    const base = {
      echoCancellation: !!echoCancellation,
      noiseSuppression: !!noiseSuppression,
      autoGainControl: !!autoGainControl
    };
    if (advancedNs) {
      // Non-standard constraints used by Chromium; ignored elsewhere.
      base.googNoiseSuppression = true;
      base.googHighpassFilter = true;
      base.googEchoCancellation = true;
      base.googAutoGainControl = true;
      base.googTypingNoiseDetection = true;
    }
    if (deviceId) {
      base.deviceId = { exact: String(deviceId) };
    }
    return base;
  }

  function sensitivityToRmsThreshold(v01) {
    // v01: 0..1 where 0 is very sensitive, 1 is strict.
    return 0.003 + v01 * 0.045; // ~0.003..0.048
  }

  const pending = new Map(); // requestId -> {resolve,reject}
  let reqSeq = 1;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const presenceUrl = `${protocol}://${window.location.host}/ws/voice?token=${encodeURIComponent(token)}`;

  function setState(patch) {
    onState((prev) => (typeof patch === "function" ? patch(prev) : { ...prev, ...patch }));
  }

  // Best-effort: unlock AudioContext on user gesture (prevents silent gain-pipeline).
  try {
    const unlock = () => {
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
  } catch {
    // ignore
  }

  function tryStartSpeakingMeter() {
    if (speakingTimer) return;
    if (!window.AudioContext && !window.webkitAudioContext) return;
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        audioCtx = null;
        return;
      }
    }
    const lastAbove = new Map();
    const holdMs = 420;
    speakingTimer = setInterval(() => {
      if (destroyed) return;
      const now = Date.now();
      const speakingSet = new Set();
      const threshold = 0.03;

      // local speaking (mic) + optional input sensitivity gate
      try {
        if (localMicStream) {
          const trackId = localMicStream.getAudioTracks?.()[0]?.id || "";
          const streamKey = `${localMicStream.id}:${trackId}`;
          let entry = speakingAnalysers.get(String(selfUserId));
          if (!entry || entry.streamKey !== streamKey) {
            try { entry?.src?.disconnect?.(); } catch { /* ignore */ }
            const src = audioCtx.createMediaStreamSource(localMicStream);
            const an = audioCtx.createAnalyser();
            an.fftSize = 512;
            src.connect(an);
            entry = { analyser: an, streamKey, src };
            speakingAnalysers.set(String(selfUserId), entry);
          }
          const an = entry.analyser;
          const data = new Uint8Array(an.fftSize);
          an.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length);
          // Auto sensitivity: keep a stable noise floor estimate (fast down, slow up).
          if (inputSensitivityAuto) {
            const downK = 0.18;
            const upK = 0.03;
            const k = rms < localNoiseFloor ? downK : upK;
            localNoiseFloor = localNoiseFloor * (1 - k) + rms * k;
            localNoiseFloor = Math.max(0.002, Math.min(0.08, localNoiseFloor));
          }

          // Discord-like: higher slider value => more sensitive (lower threshold).
          const inv = 1 - Math.max(0, Math.min(1, (Number(inputSensitivity) || 55) / 100));
          const manualThr = sensitivityToRmsThreshold(inv);
          const thr = inputSensitivityAuto ? Math.max(0.008, localNoiseFloor * 2.2) : manualThr;

          // Peak-hold to avoid false "нет" during short syllables.
          if (rms > peakRms) peakRms = rms;
          if (rms > thr) peakHoldUntilMs = now + 220;
          if (now > peakHoldUntilMs) peakRms *= 0.84; // decay when no recent peaks
          peakRms = Math.max(0, Math.min(0.25, peakRms));
          const effectiveRms = Math.max(rms, peakRms);

          const isAbove = effectiveRms > Math.min(0.2, thr);
          if (isAbove) lastAbove.set(String(selfUserId), now);

          // IMPORTANT: do NOT gate/disable the mic track based on sensitivity.
          // This is only for UI ("говорю") — gating can cause real audio dropouts.
          lastLocalGateOpen = !effectiveMuted() && isAbove;

          lastLocalRms = rms;
          lastLocalEffectiveRms = effectiveRms;
          lastLocalThreshold = thr;

          // Meter smoothing: rise fast, decay over ~3 seconds.
          const prevAt = lastMeterAtMs || now;
          const dt = Math.max(1, now - prevAt);
          lastMeterAtMs = now;
          const tauMs = 3000;
          const decay = Math.exp(-dt / tauMs);
          lastLocalMeterRms = Math.max(effectiveRms, lastLocalMeterRms * decay);
        }
      } catch {
        // ignore
      }

      // remote speaking: analyse each audio element's stream if possible
      try {
        remoteAudioHost?.querySelectorAll?.("audio")?.forEach?.((el) => {
          try {
            const so = el.srcObject;
            if (!so || !(so instanceof MediaStream)) return;
            const key = String(el.id || "").replace("sfu-remote-audio-", "");
            const uid = String(key.split(":")[0] || "");
            if (!uid) return;
            let entry = speakingAnalysers.get(uid);
            const streamKey = `${so.id}:${(so.getAudioTracks?.()[0]?.id || "")}`;
            if (!entry || entry.streamKey !== streamKey) {
              try { entry?.src?.disconnect?.(); } catch { /* ignore */ }
              const src = audioCtx.createMediaStreamSource(so);
              const an = audioCtx.createAnalyser();
              an.fftSize = 512;
              src.connect(an);
              entry = { analyser: an, streamKey, src };
              speakingAnalysers.set(uid, entry);
            }
            const an = entry.analyser;
            const data = new Uint8Array(an.fftSize);
            an.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) {
              const v = (data[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / data.length);
            if (rms > threshold) lastAbove.set(String(uid), now);
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }

      for (const [uid, t] of lastAbove.entries()) {
        if (now - t <= holdMs) speakingSet.add(String(uid));
      }

      setState((prev) => ({ ...prev, speakingUserIds: Array.from(speakingSet) }));
    }, 140);
  }

  function sendPresence(obj) {
    if (!presenceWs || presenceWs.readyState !== WebSocket.OPEN) return;
    try {
      presenceWs.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  function persistVoicePrefs() {
    try { localStorage.setItem(LS_MIC, micEnabledWanted ? "1" : "0"); } catch { /* ignore */ }
    try { localStorage.setItem(LS_DEAF, deafened ? "1" : "0"); } catch { /* ignore */ }
  }

  function effectiveMuted() {
    return deafened || !micEnabledWanted;
  }

  function applyLocalMuteDeafen() {
    const mutedNow = effectiveMuted();
    try {
      localMicStream?.getAudioTracks?.().forEach((t) => { t.enabled = !mutedNow; });
      micProducedTrack && (micProducedTrack.enabled = !mutedNow);
    } catch { /* ignore */ }
    try {
      if (micProducer) {
        if (mutedNow) micProducer.pause?.();
        else micProducer.resume?.();
      }
    } catch { /* ignore */ }
    try { remoteAudioHost?.querySelectorAll?.("audio")?.forEach((el) => { el.muted = deafened; }); } catch { /* ignore */ }
    setState({ muted: mutedNow, deafened });
    persistVoicePrefs();
    sendPresence({ type: "setUserFlags", roomId, muted: mutedNow, deafened });
  }

  function startPresencePing() {
    if (presencePing) clearInterval(presencePing);
    presencePing = setInterval(() => {
      sendPresence({ type: "ping" });
    }, 20000);
  }

  function stopPresencePing() {
    if (presencePing) clearInterval(presencePing);
    presencePing = null;
  }

  function stopPresenceReconnect() {
    if (presenceReconnectTimer) clearTimeout(presenceReconnectTimer);
    presenceReconnectTimer = null;
  }

  function schedulePresenceReconnect() {
    if (destroyed) return;
    stopPresenceReconnect();
    presenceReconnectFailures += 1;
    const exp = Math.min(10, Math.max(0, presenceReconnectFailures - 1));
    const base = Math.round(800 * (2 ** exp));
    const jitter = Math.round(Math.random() * 450);
    const waitMs = Math.min(15000, base + jitter);
    presenceReconnectTimer = setTimeout(() => {
      presenceReconnectTimer = null;
      if (destroyed) return;
      connectPresence()
        .then(() => {
          presenceReconnectFailures = 0;
          // Presence reconnect can miss SFU producer events; resync is cheap and fixes “пропал звук/ростер”.
          resyncRemoteProducers("presence-reconnect").catch(() => {});
          tryPlayAllRemoteMedia();
        })
        .catch(() => schedulePresenceReconnect());
    }, waitMs);
  }

  function startPresenceScreenHeartbeat() {
    if (presenceScreenHeartbeat) clearInterval(presenceScreenHeartbeat);
    // Periodically re-assert screen share state to avoid stale "в эфире"
    // if `screenShare=false` was missed during reconnects / track end.
    presenceScreenHeartbeat = setInterval(() => {
      try {
        if (destroyed) return;
        sendPresence({ type: "screenShare", roomId, enabled: !!screenProducer });
      } catch {
        // ignore
      }
    }, 4000);
  }

  function stopPresenceScreenHeartbeat() {
    if (presenceScreenHeartbeat) clearInterval(presenceScreenHeartbeat);
    presenceScreenHeartbeat = null;
  }

  function makeAudioEl(peerId, source) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    const src = String(source || "mic").replace(/[^a-z0-9_-]/gi, "x");
    const id = `sfu-remote-audio-${pid}:${src}`;
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("audio");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.setAttribute("playsinline", "true");
    el.muted = deafened;
    remoteAudioHost.appendChild(el);
    return el;
  }

  async function trySetSink(el) {
    if (!el) return;
    if (!outputDeviceId) return;
    try {
      if (typeof el.setSinkId === "function") {
        await el.setSinkId(outputDeviceId);
      }
    } catch {
      // ignore (unsupported or denied)
    }
  }

  function ensureAudioCtx() {
    if (audioCtx) {
      try { audioCtx.resume?.().catch(() => {}); } catch { /* ignore */ }
      // Only use it for gain processing if it's actually running.
      if (audioCtx.state && audioCtx.state !== "running") return null;
      return audioCtx;
    }
    if (!window.AudioContext && !window.webkitAudioContext) return null;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      try { audioCtx.resume?.().catch(() => {}); } catch { /* ignore */ }
      if (audioCtx.state && audioCtx.state !== "running") return null;
      return audioCtx;
    } catch {
      audioCtx = null;
      return null;
    }
  }

  function getUserVolumeMultiplier(userId) {
    try {
      const raw = localStorage.getItem("sloncord_voice_user_volumes") || "{}";
      const m = JSON.parse(raw) || {};
      const v = Number(m[String(userId)] ?? 100);
      const clamped = Math.max(0, Math.min(300, Number.isFinite(v) ? v : 100));
      return clamped / 100;
    } catch {
      return 1.0;
    }
  }

  function makeVideoEl(peerId, source) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    // IMPORTANT: screen viewer UI expects `remote-video-${peerId}`.
    // Keep this id for screen share so existing `openScreenView()` works.
    // For camera/other video sources, use a suffix to avoid collisions.
    const src = String(source || "");
    const suf = (src && src !== "screen") ? `-${src.replace(/[^a-z0-9_-]/gi, "x")}` : "";
    const id = `remote-video-${pid}${suf}`;
    let el = document.getElementById(id);
    if (el) return el;
    el = document.createElement("video");
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.controls = false;
    el.muted = true;
    el.setAttribute("playsinline", "true");
    (remoteVideoHost || document.querySelector(".voice-video-stage"))?.appendChild(el);
    return el;
  }

  function removeMediaEls(peerId) {
    const pid = String(peerId).replace(/[^a-f0-9-]/gi, "x");
    try {
      document.querySelectorAll?.(`[id^="sfu-remote-audio-${pid}:"]`)?.forEach?.((x) => x.remove());
    } catch { /* ignore */ }
    try {
      document.querySelectorAll?.(`[id^="remote-video-${pid}"]`)?.forEach?.((x) => x.remove());
    } catch {
      // ignore
    }
  }

  function removeRemoteAudioByUserAndSource(userId, source) {
    const pid = String(userId).replace(/[^a-f0-9-]/gi, "x");
    const src = String(source || "mic").replace(/[^a-z0-9_-]/gi, "x");
    const id = `sfu-remote-audio-${pid}:${src}`;
    try { document.getElementById(id)?.remove?.(); } catch { /* ignore */ }
    try { audioElByUserId.delete(`${String(userId)}:${String(source || "mic")}`); } catch { /* ignore */ }
  }

  function sfuSend(obj) {
    if (!sfuWs || sfuWs.readyState !== WebSocket.OPEN) throw new Error("SFU WebSocket не подключен");
    sfuWs.send(JSON.stringify(obj));
  }

  function sfuRequest(type, payload = {}) {
    const requestId = String(reqSeq++);
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      try {
        sfuSend({ type, requestId, ...payload });
      } catch (e) {
        pending.delete(requestId);
        reject(e);
      }
      setTimeout(() => {
        const p = pending.get(requestId);
        if (!p) return;
        pending.delete(requestId);
        reject(new Error(`SFU timeout (${type})`));
      }, 8000);
    });
  }

  function getUserVolumePct(userId) {
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

  function volumePctToGain(pct) {
    const p = Math.max(0, Math.min(300, Number(pct) || 0));
    if (p <= 100) return p / 100;
    // Make 300% ~3x louder than before:
    // old: gain = 3.0 at 300%. new: gain = 9.0 at 300%.
    // Keep continuity at 100% (gain=1.0).
    const t = (p - 100) / 200; // 0..1
    return 1 + t * 8; // 1..9
  }

  function applyUserVolume(userId, source) {
    const uid = String(userId || "");
    const src = String(source || "mic");
    const el = audioElByUserId.get(`${uid}:${src}`);
    if (!el) return;
    const pct = getUserVolumePct(uid);
    const mult = volumePctToGain(pct) * speakerGain;
    const screenMult = src === "screenAudio"
      ? (Math.max(0, Math.min(300, Number(screenAudioPctByUserId.get(uid) ?? 100))) / 100)
      : 1.0;
    const pipe = audioPipeByUserId.get(uid);
    if (pipe?.gainNode) {
      // If stream got replaced externally, try to recover (re-attach pipe output).
      try {
        if (pipe.destNode?.stream && el.srcObject !== pipe.destNode.stream) el.srcObject = pipe.destNode.stream;
        pipe.gainNode.gain.value = mult * screenMult;
        return;
      } catch {
        teardownUserPipe(uid);
      }
    }
    // Default stable path: HTMLAudioElement volume (0..1).
    // Only enable WebAudio when we actually need boost > 100%.
    if (mult > 1.0) {
      if (ensureUserPipe(uid, el)) {
        const p2 = audioPipeByUserId.get(uid);
        if (p2?.gainNode) {
          try { p2.gainNode.gain.value = mult * screenMult; } catch { /* ignore */ }
          return;
        }
      }
      // If WebAudio isn't available, clamp at 1.0 (can't boost).
      try { el.volume = 1.0; } catch { /* ignore */ }
      return;
    }
    try { el.volume = Math.max(0, Math.min(1, mult * screenMult)); } catch { /* ignore */ }
  }

  async function sfuConsumeProducer(producerId) {
    if (!device || !recvTransport) return;
    const pid0 = String(producerId || "");
    if (!pid0) return;
    if (consumedProducerIds.has(pid0)) return;
    const res = await sfuRequest("consume", {
      transportId: recvTransport.id,
      producerId: pid0,
      rtpCapabilities: device.rtpCapabilities
    });
    const cp = res.consumerParameters;
    const consumer = await recvTransport.consume(cp);
    consumers.set(consumer.id, consumer);
    consumedProducerIds.add(pid0);

    const remoteUserId = String(cp?.appData?.remoteUserId || "");
    const source = cp?.appData?.source ? String(cp.appData.source) : "";
    if (producerId && remoteUserId) producerMetaById.set(String(producerId), { userId: remoteUserId, source });

    if (consumer.track?.kind === "audio") {
      const uid = String(remoteUserId);
      const src = source || "mic";
      const el = makeAudioEl(remoteUserId || "unknown", src);
      audioElByUserId.set(`${uid}:${src}`, el);
      // Default behavior (stable): attach track directly.
      const directStream = new MediaStream([consumer.track]);
      directStreamByUserId.set(uid, directStream);

      // If this user already uses WebAudio pipe, keep pipe and update its source.
      if (!updateUserPipeSource(uid, directStream, el)) {
        el.srcObject = directStream;
      }
      el.muted = !!deafened;
      if (!deafened && el.muted) el.muted = false;
      trySetSink(el).catch(() => {});
      applyUserVolume(uid, src);
      el.play?.().catch(() => {});
      tryStartSpeakingMeter();

      consumer.track.onunmute = () => {
        tryPlayAllRemoteMedia();
      };
      consumer.track.onended = () => {
        try {
          teardownUserPipe(uid);
          removeRemoteAudioByUserAndSource(uid, src);
          try {
            const ds = directStreamByUserId.get(uid);
            const tr = ds?.getAudioTracks?.()?.[0];
            if (tr && consumer.track && tr.id === consumer.track.id) {
              directStreamByUserId.delete(uid);
            }
          } catch {
            /* ignore */
          }
          consumedProducerIds.delete(pid0);
          consumers.delete(consumer.id);
          try { producerMetaById.delete(pid0); } catch { /* ignore */ }
          try { consumer.close?.(); } catch { /* ignore */ }
        } catch {
          /* ignore */
        }
        resyncRemoteProducers("consumer-track-ended").catch(() => {});
      };
    } else if (consumer.track?.kind === "video") {
      const el = makeVideoEl(remoteUserId || "unknown", source || "video");
      el.srcObject = new MediaStream([consumer.track]);
      el.play?.().catch(() => {});
      if (source === "screen") {
        setState((prev) => ({
          ...prev,
          screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(remoteUserId)]))
        }));
      }
    }

    await sfuRequest("resumeConsumer", { consumerId: consumer.id });
  }

  async function resyncRemoteProducers(reason) {
    try {
      if (destroyed) return;
      if (!sfuWs || sfuWs.readyState !== WebSocket.OPEN) return;
      if (!device || !recvTransport) return;
      const prod = await sfuRequest("getProducers");
      for (const it of prod.items || []) {
        const pid = String(it.producerId || "");
        if (!pid) continue;
        if (consumedProducerIds.has(pid)) continue;
        sfuConsumeProducer(pid).catch(() => {});
      }
      // After resync, try to play media (autoplay unlock may still be needed).
      tryPlayAllRemoteMedia();
    } catch {
      // ignore
    }
  }

  async function startMicIfNeeded() {
    if (localMicStream) return localMicStream;
    // Keep currentInputDeviceId in sync even for default device.
    if (currentInputDeviceId == null) currentInputDeviceId = "";
    localMicStream = await navigator.mediaDevices.getUserMedia({
      audio: buildAudioConstraints(currentInputDeviceId || "")
    });
    tryStartSpeakingMeter();
    return localMicStream;
  }

  async function startCamera() {
    if (camProducer) return;
    camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const track = camStream.getVideoTracks()[0];
    if (!track) return;
    camProducer = await sendTransport.produce({ track, appData: { source: "camera" } });
  }

  async function stopCamera() {
    try {
      if (camProducer?.id) {
        await sfuRequest("closeProducer", { producerId: String(camProducer.id) });
      }
    } catch {
      // ignore
    }
    try { camProducer?.close?.(); } catch { /* ignore */ }
    camProducer = null;
    try { camStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    camStream = null;
  }

  async function startScreen() {
    if (screenProducer) return;
    if (!navigator.mediaDevices.getDisplayMedia) throw new Error("Демонстрация экрана не поддерживается на этом устройстве");
    // Try to capture system/window audio when available (Chrome/Edge typically support it).
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const vtrack = screenStream.getVideoTracks()[0];
    if (!vtrack) return;
    vtrack.onended = () => {
      stopScreen().catch(() => {});
    };
    screenProducer = await sendTransport.produce({ track: vtrack, appData: { source: "screen" } });
    try {
      const atrack = screenStream.getAudioTracks?.()[0];
      if (atrack) {
        screenAudioProducer = await sendTransport.produce({ track: atrack, appData: { source: "screenAudio" } });
      }
    } catch {
      // ignore (audio capture not supported/denied)
    }
    sendPresence({ type: "screenShare", roomId, enabled: true });
    setState((prev) => ({
      ...prev,
      sharingScreen: true,
      screenShareUserIds: Array.from(new Set([...(prev.screenShareUserIds || []), String(selfUserId)]))
    }));
  }

  async function stopScreen() {
    try {
      if (screenProducer?.id) {
        await sfuRequest("closeProducer", { producerId: String(screenProducer.id) });
      }
    } catch {
      // ignore
    }
    try {
      if (screenAudioProducer?.id) {
        await sfuRequest("closeProducer", { producerId: String(screenAudioProducer.id) });
      }
    } catch {
      // ignore
    }
    try { screenProducer?.close?.(); } catch { /* ignore */ }
    screenProducer = null;
    try { screenAudioProducer?.close?.(); } catch { /* ignore */ }
    screenAudioProducer = null;
    try { screenStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
    screenStream = null;
    sendPresence({ type: "screenShare", roomId, enabled: false });
    setState((prev) => ({
      ...prev,
      sharingScreen: false,
      screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== String(selfUserId))
    }));
  }

  async function connectPresence() {
    if (destroyed) return;
    return new Promise((resolve, reject) => {
      const s = new WebSocket(presenceUrl);
      const timer = setTimeout(() => {
        try { s.close(); } catch { /* ignore */ }
        reject(new Error("Presence WS timeout"));
      }, 6000);
      s.onopen = () => {
        clearTimeout(timer);
        presenceWs = s;
        s.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === "roomRoster" && String(msg.roomId) === String(roomId)) {
            const ids = (msg.userIds || []).map((x) => String(x));
            lastRoster = ids;
            const mutedIds = (msg.mutedUserIds || []).map((x) => String(x));
            const deafIds = (msg.deafenedUserIds || []).map((x) => String(x));
            const sharers = (msg.screenShareUserIds || []).map((x) => String(x)).filter(Boolean);
            setState((prev) => ({ ...prev, rosterUserIds: ids, mutedUserIds: mutedIds, deafenedUserIds: deafIds, screenShareUserIds: sharers }));
            // If roster changed but media seems stale, quickly reconcile via resync.
            if (ids.length > 1) {
              setTimeout(() => resyncRemoteProducers("roster-update").catch(() => {}), 250);
            }
          }
        };
        s.onclose = () => {
          stopPresencePing();
          stopPresenceScreenHeartbeat();
          try { presenceWs = null; } catch { /* ignore */ }
          schedulePresenceReconnect();
        };
        sendPresence({ type: "joinRoom", roomId, mode: "sfu" });
        startPresencePing();
        startPresenceScreenHeartbeat();
        resolve();
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Presence WS error"));
      };
    });
  }

  async function connectSfu() {
    if (!sfuUrl || !sfuToken) throw new Error("SFU параметры не получены");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(sfuUrl, []);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("SFU WS timeout"));
      }, 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        sfuWs = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("SFU WS error"));
      };
    });
  }

  async function startSfuClient() {
    const ms = await loadMediasoupClient();

    // Recreate WS with Authorization header is not possible in browser; use token query param as fallback.
    // If sfuUrl doesn't already contain token, append it.
    let finalUrl = String(sfuUrl || "");
    if (!/token=/.test(finalUrl)) {
      const sep = finalUrl.includes("?") ? "&" : "?";
      finalUrl = `${finalUrl}${sep}token=${encodeURIComponent(String(sfuToken || ""))}`;
    }

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(finalUrl);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("SFU WS timeout"));
      }, 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        sfuWs = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("SFU WS error"));
      };
    });

    sfuWs.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.requestId && pending.has(String(msg.requestId))) {
        const p = pending.get(String(msg.requestId));
        pending.delete(String(msg.requestId));
        if (msg.type === "error") p.reject(new Error(msg.code || "SFU error"));
        else p.resolve(msg);
        return;
      }

      if (msg.type === "newProducer") {
        sfuConsumeProducer(String(msg.producerId)).catch(() => {});
        return;
      }
      if (msg.type === "producerClosed") {
        const pid = String(msg.producerId || "");
        const uid = String(msg.userId || producerMetaById.get(pid)?.userId || "");
        const src = String(msg?.appData?.source || producerMetaById.get(pid)?.source || "");
        producerMetaById.delete(pid);
        if (uid && (src === "screen" || src === "screenAudio")) {
          // Remove stale "live" badge immediately even if presence didn't update.
          if (src === "screen") {
            setState((prev) => ({
              ...prev,
              screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== uid)
            }));
          } else {
            // Stop screen audio immediately when producer closes.
            removeRemoteAudioByUserAndSource(uid, "screenAudio");
            tryStartSpeakingMeter();
          }
        }
        return;
      }
      if (msg.type === "consumerClosed") {
        const pid = String(msg.producerId || "");
        const uid = String(msg?.appData?.remoteUserId || producerMetaById.get(pid)?.userId || "");
        const src = String(msg?.appData?.source || producerMetaById.get(pid)?.source || "");
        if (uid && (src === "screen" || src === "screenAudio")) {
          if (src === "screen") {
            setState((prev) => ({
              ...prev,
              screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== uid)
            }));
          } else {
            removeRemoteAudioByUserAndSource(uid, "screenAudio");
            tryStartSpeakingMeter();
          }
        }
        return;
      }
      if (msg.type === "peerLeft") {
        removeMediaEls(String(msg.userId));
        try { speakingAnalysers.delete(String(msg.userId)); } catch { /* ignore */ }
        setState((prev) => ({
          ...prev,
          screenShareUserIds: (prev.screenShareUserIds || []).filter((x) => String(x) !== String(msg.userId))
        }));
      }
    };

    const caps = await sfuRequest("getRouterRtpCapabilities");
    device = new ms.Device();
    await device.load({ routerRtpCapabilities: caps.rtpCapabilities });

    const sendT = await sfuRequest("createWebRtcTransport", { direction: "send" });
    sendTransport = device.createSendTransport(sendT.transportOptions);
    sendTransport.on("connect", ({ dtlsParameters }, cb, eb) => {
      sfuRequest("connectWebRtcTransport", { transportId: sendTransport.id, dtlsParameters })
        .then(() => cb())
        .catch((e) => eb(e));
    });
    sendTransport.on("produce", ({ kind, rtpParameters, appData }, cb, eb) => {
      sfuRequest("produce", { transportId: sendTransport.id, kind, rtpParameters, appData })
        .then((r) => cb({ id: r.producerId }))
        .catch((e) => eb(e));
    });

    const recvT = await sfuRequest("createWebRtcTransport", { direction: "recv" });
    recvTransport = device.createRecvTransport(recvT.transportOptions);
    recvTransport.on("connect", ({ dtlsParameters }, cb, eb) => {
      sfuRequest("connectWebRtcTransport", { transportId: recvTransport.id, dtlsParameters })
        .then(() => cb())
        .catch((e) => eb(e));
    });
    recvTransport.on("connectionstatechange", (state) => {
      if (state !== "failed" && state !== "disconnected") return;
      if (recvTransportRecoveryTimer) clearTimeout(recvTransportRecoveryTimer);
      recvTransportRecoveryTimer = setTimeout(() => {
        recvTransportRecoveryTimer = null;
        if (destroyed) return;
        tryPlayAllRemoteMedia();
        resyncRemoteProducers(`recvTransport-${state}`).catch(() => {});
      }, state === "failed" ? 0 : 600);
    });

    // Produce mic first (fast join).
    await startMicIfNeeded();
    const rawMicTrack = localMicStream.getAudioTracks()[0];
    let micTrack = rawMicTrack;
    // Apply mic gain via WebAudio if available.
    const ctx = ensureAudioCtx();
    if (ctx && rawMicTrack) {
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([rawMicTrack]));
        micGainNode = ctx.createGain();
        micGainNode.gain.value = micGain;
        const dest = ctx.createMediaStreamDestination();
        src.connect(micGainNode);
        micGainNode.connect(dest);
        micTrack = dest.stream.getAudioTracks()[0] || rawMicTrack;
      } catch {
        micTrack = rawMicTrack;
      }
    }
    micTrack.enabled = !effectiveMuted();
    micProducer = await sendTransport.produce({ track: micTrack, appData: { source: "mic" } });
    micProducedTrack = micTrack;

    // Consume existing producers.
    const prod = await sfuRequest("getProducers");
    for (const it of prod.items || []) {
      sfuConsumeProducer(String(it.producerId)).catch(() => {});
    }

    // Autoplay may be blocked after reload until a user gesture.
    // Install unlock handler and attempt play immediately.
    installGestureMediaUnlock();
    installSfuVisibilityRecovery();
    tryPlayAllRemoteMedia();
    startPlaybackHeal();

    // If we are connected but accidentally missed remote producers, resync a few times.
    try {
      setTimeout(() => resyncRemoteProducers("post-join-2s"), 2000);
      setTimeout(() => resyncRemoteProducers("post-join-5s"), 5000);
      setTimeout(() => resyncRemoteProducers("post-join-9s"), 9000);
    } catch {
      // ignore
    }
  }

  return {
    async join() {
      setState({ joining: true, connected: false, room: roomId });
      await Promise.all([connectPresence(), startSfuClient()]);
      setState({ joining: false, connected: true, room: roomId, peers: Math.max(0, (lastRoster || []).length - 1) });
      // Apply persisted prefs immediately after join.
      try { applyLocalMuteDeafen(); } catch { /* ignore */ }
    },

    toggleMute() {
      micEnabledWanted = !micEnabledWanted;
      applyLocalMuteDeafen();
    },

    toggleDeafen() {
      deafened = !deafened;
      applyLocalMuteDeafen();
    },

    async toggleScreenShare() {
      if (screenProducer) await stopScreen();
      else await startScreen();
    },

    async toggleCamera() {
      if (camProducer) await stopCamera();
      else await startCamera();
    },

    async setInputDevice(deviceId) {
      try {
        const did = String(deviceId || "");
        currentInputDeviceId = did;
        const s = await navigator.mediaDevices.getUserMedia({
          audio: buildAudioConstraints(did),
          video: false
        });
        const rawMicTrack = s.getAudioTracks()[0];
        if (!rawMicTrack) return;
        try { localMicStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
        localMicStream = s;
        tryStartSpeakingMeter();

        let nextTrack = rawMicTrack;
        const ctx = ensureAudioCtx();
        if (ctx) {
          try {
            const src = ctx.createMediaStreamSource(new MediaStream([rawMicTrack]));
            if (!micGainNode) micGainNode = ctx.createGain();
            micGainNode.gain.value = micGain;
            const dest = ctx.createMediaStreamDestination();
            src.connect(micGainNode);
            micGainNode.connect(dest);
            nextTrack = dest.stream.getAudioTracks()[0] || rawMicTrack;
          } catch {
            nextTrack = rawMicTrack;
          }
        }

        nextTrack.enabled = !effectiveMuted();
        await micProducer?.replaceTrack?.({ track: nextTrack });
        micProducedTrack = nextTrack;
      } catch {
        // ignore
      }
    },

    async setOutputDevice(deviceId) {
      outputDeviceId = String(deviceId || "");
      try {
        remoteAudioHost?.querySelectorAll?.("audio")?.forEach?.((el) => {
          trySetSink(el).catch(() => {});
        });
      } catch {
        // ignore
      }
    },

    setMicGain(v) {
      const x = Math.max(0, Math.min(100, Number(v) || 0));
      micGain = x / 100;
      try {
        if (micGainNode) micGainNode.gain.value = micGain;
      } catch {
        // ignore
      }
    },

    async setAdvancedNoiseSuppression(enabled) {
      advancedNs = !!enabled;
      // Re-acquire mic and replace track best-effort (only if we already have producer).
      try {
        if (!micProducer) return;
        await this.setInputDevice(currentInputDeviceId || "");
      } catch {
        // ignore
      }
    },

    setAudioProcessing(opts) {
      echoCancellation = opts?.echoCancellation != null ? !!opts.echoCancellation : echoCancellation;
      noiseSuppression = opts?.noiseSuppression != null ? !!opts.noiseSuppression : noiseSuppression;
      autoGainControl = opts?.autoGainControl != null ? !!opts.autoGainControl : autoGainControl;
      advancedNs = opts?.advancedNoiseSuppression != null ? !!opts.advancedNoiseSuppression : advancedNs;
      inputSensitivityAuto = opts?.inputSensitivityAuto != null ? !!opts.inputSensitivityAuto : inputSensitivityAuto;
      inputSensitivity = Number(opts?.inputSensitivity) || inputSensitivity;
      // Best-effort: restart mic to apply constraints (needs user gesture in some browsers).
      try {
        // Force mic track refresh whenever processing toggles change.
        if (micProducer) this.setInputDevice(currentInputDeviceId || "").catch(() => {});
      } catch {
        // ignore
      }
    },

    getInputMeter() {
      return {
        rms: Number(lastLocalMeterRms) || Number(lastLocalEffectiveRms) || Number(lastLocalRms) || 0,
        threshold: Number(lastLocalThreshold) || 0.03,
        open: !!lastLocalGateOpen,
        auto: !!inputSensitivityAuto
      };
    },

    ensurePlayback() {
      tryPlayAllRemoteMedia();
      try { audioCtx?.resume?.().catch(() => {}); } catch { /* ignore */ }
      startPlaybackHeal();
    },

    setSpeakerGain(v) {
      const x = Math.max(0, Math.min(100, Number(v) || 0));
      speakerGain = x / 100;
      try {
        audioElByUserId.forEach((_, key) => {
          const [uid, src] = String(key).split(":");
          applyUserVolume(uid, src || "mic");
        });
      } catch { /* ignore */ }
    },

    setUserVolume(userId, v) {
      const uid = String(userId || "");
      const x = Math.max(0, Math.min(300, Number(v) || 0));
      userVolumePctByUserId.set(uid, x);
      // If boost > 100%, switch this user to WebAudio pipe (requires running AudioContext).
      // apply to all sources for this user
      const keys = Array.from(audioElByUserId.keys()).filter((k) => String(k).startsWith(`${uid}:`));
      if (!keys.length) return;
      const el = audioElByUserId.get(keys[0]);
      if (!el) return;
      const mult = volumePctToGain(x) * speakerGain;
      // Only create WebAudio pipe when boost is required.
      // If a pipe already exists (was created earlier), we keep it and just change gain.
      if (mult > 1.0) ensureUserPipe(uid, el);
      keys.forEach((k) => {
        const [_uid, src] = String(k).split(":");
        applyUserVolume(_uid, src || "mic");
      });
    },

    setScreenAudioVolume(userId, v) {
      const uid = String(userId || "");
      const x = Math.max(0, Math.min(300, Number(v) || 0));
      screenAudioPctByUserId.set(uid, x);
      applyUserVolume(uid, "screenAudio");
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;

      // Mobile Safari: aggressively stop and remove media elements to avoid audio artifacts after leaving voice.
      try {
        remoteAudioHost?.querySelectorAll?.("audio")?.forEach?.((el) => {
          try { el.pause?.(); } catch { /* ignore */ }
          try { el.srcObject = null; } catch { /* ignore */ }
          try { el.remove?.(); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      try {
        (remoteVideoHost || document.querySelector(".voice-video-stage"))?.querySelectorAll?.("video")?.forEach?.((el) => {
          try { el.pause?.(); } catch { /* ignore */ }
          try { el.srcObject = null; } catch { /* ignore */ }
          try { el.remove?.(); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }

      stopPresencePing();
      stopPresenceScreenHeartbeat();
      try { sendPresence({ type: "leaveRoom" }); } catch { /* ignore */ }
      try { presenceWs?.close?.(); } catch { /* ignore */ }
      presenceWs = null;

      try {
        if (micProducer?.id) {
          sfuRequest("closeProducer", { producerId: String(micProducer.id) }).catch(() => {});
        }
      } catch {
        // ignore
      }
      try { micProducer?.close?.(); } catch { /* ignore */ }
      micProducer = null;
      stopCamera().catch(() => {});
      stopScreen().catch(() => {});

      try { sendTransport?.close?.(); } catch { /* ignore */ }
      try { recvTransport?.close?.(); } catch { /* ignore */ }
      sendTransport = null;
      recvTransport = null;

      for (const c of consumers.values()) {
        try { c.close?.(); } catch { /* ignore */ }
      }
      consumers.clear();
      consumedProducerIds.clear();
      audioElByUserId.clear();
      try {
        audioPipeByUserId.forEach((p) => {
          try { p?.srcNode?.disconnect?.(); } catch { /* ignore */ }
          try { p?.gainNode?.disconnect?.(); } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
      audioPipeByUserId.clear();
      directStreamByUserId.clear();
      userVolumePctByUserId.clear();

      try { localMicStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
      localMicStream = null;

      try { sfuWs?.close?.(); } catch { /* ignore */ }
      sfuWs = null;

      if (speakingTimer) {
        clearInterval(speakingTimer);
        speakingTimer = null;
      }
      try {
        if (audioCtx && audioCtx.state !== "closed") audioCtx.close?.();
      } catch {
        // ignore
      }
      audioCtx = null;
      speakingAnalysers.clear();
      uninstallGestureMediaUnlock();
      uninstallSfuVisibilityRecovery();
      if (recvTransportRecoveryTimer) {
        clearTimeout(recvTransportRecoveryTimer);
        recvTransportRecoveryTimer = null;
      }
      stopPlaybackHeal();

      setState({
        connected: false,
        joining: false,
        mediaLinkReady: true,
        room: "",
        peers: 0,
        muted: false,
        deafened: false,
        remotePeerUserIds: [],
        rosterUserIds: []
      });
    }
  };
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

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
