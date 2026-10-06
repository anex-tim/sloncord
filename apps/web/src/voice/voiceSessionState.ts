export type VoiceLinkState = "idle" | "joining" | "connected" | "degraded" | "recovering";

export type VoiceReconnectEvent = {
  at: string;
  reason: string;
  durationMs?: number;
  outcome: "started" | "completed" | "failed";
};

export type VoiceSessionMetrics = {
  linkState: VoiceLinkState;
  reconnectCount: number;
  lastReconnectReason: string;
  lastRecoveryMs: number | null;
  events: VoiceReconnectEvent[];
};

const MAX_EVENTS = 40;

export function createVoiceSessionState() {
  let linkState: VoiceLinkState = "idle";
  let reconnectCount = 0;
  let lastReconnectReason = "";
  let lastRecoveryMs: number | null = null;
  let recoveringStartedAt = 0;
  const events: VoiceReconnectEvent[] = [];

  function pushEvent(reason: string, outcome: VoiceReconnectEvent["outcome"], durationMs?: number) {
    events.push({
      at: new Date().toISOString(),
      reason: String(reason || ""),
      outcome,
      durationMs,
    });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }

  function transition(next: VoiceLinkState, reason = "") {
    const prev = linkState;
    if (prev === next) return;

    if (prev === "recovering" && recoveringStartedAt > 0) {
      const durationMs = Date.now() - recoveringStartedAt;
      lastRecoveryMs = durationMs;
      pushEvent(lastReconnectReason || reason, "completed", durationMs);
      recoveringStartedAt = 0;
    }

    if (next === "recovering") {
      reconnectCount += 1;
      lastReconnectReason = String(reason || "");
      recoveringStartedAt = Date.now();
      pushEvent(lastReconnectReason, "started");
    }

    if (next === "degraded") {
      pushEvent(reason || "degraded", "started");
    }

    linkState = next;
  }

  function markRecoveryFailed(reason: string) {
    if (linkState !== "recovering") return;
    const durationMs = recoveringStartedAt > 0 ? Date.now() - recoveringStartedAt : undefined;
    pushEvent(reason || lastReconnectReason, "failed", durationMs);
    recoveringStartedAt = 0;
    linkState = "degraded";
  }

  function getMetrics(): VoiceSessionMetrics {
    return {
      linkState,
      reconnectCount,
      lastReconnectReason,
      lastRecoveryMs,
      events: [...events],
    };
  }

  function uiPatch(patch: Record<string, unknown>): Record<string, unknown> {
    const m = getMetrics();
    const mediaReady =
      Object.prototype.hasOwnProperty.call(patch, "mediaLinkReady")
        ? patch.mediaLinkReady
        : m.linkState === "connected";
    const next = {
      ...patch,
      voiceLinkState: m.linkState,
      voiceReconnectCount: m.reconnectCount,
      voiceLastRecoveryMs: m.lastRecoveryMs,
      mediaLinkReady: mediaReady,
    };
    const prev = patch as Record<string, unknown>;
    if (
      prev.voiceLinkState === next.voiceLinkState
      && prev.voiceReconnectCount === next.voiceReconnectCount
      && prev.voiceLastRecoveryMs === next.voiceLastRecoveryMs
      && prev.mediaLinkReady === next.mediaLinkReady
    ) {
      return patch;
    }
    return next;
  }

  return {
    transition,
    markRecoveryFailed,
    getMetrics,
    getLinkState: () => linkState,
    uiPatch,
  };
}

export type VoiceSessionStateApi = ReturnType<typeof createVoiceSessionState>;
