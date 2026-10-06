import { createNativePcmNode } from "./nativePcmWorklet";

/** Совпадает с preload / Electron pendingDisplaySelection. */
export type NativeDisplaySelection = {
  tab: "screen" | "window";
  sourceId: string;
  withSystemAudio: boolean;
};

type NativeScreenAudioState = {
  ctx: AudioContext;
  node: AudioWorkletNode;
  dest: MediaStreamAudioDestinationNode;
  unsub: (() => void) | null;
  track: MediaStreamTrack;
};

let active: NativeScreenAudioState | null = null;
let captureWorkletNode: AudioWorkletNode | null = null;
let lastStartError: string | null = null;
let silenceCheckTimer: ReturnType<typeof setTimeout> | null = null;

function clearSilenceCheckTimer(): void {
  if (silenceCheckTimer != null) {
    try {
      clearTimeout(silenceCheckTimer);
    } catch {
      /* ignore */
    }
    silenceCheckTimer = null;
  }
}

/** Быстрая проверка: есть ли ненулевые PCM16 сэмплы в чанке. */
function chunkMayHaveAudioSignal(ab: ArrayBuffer): boolean {
  try {
    if (!ab || ab.byteLength < 4) return false;
    const dv = new DataView(ab);
    const maxBytes = Math.min(dv.byteLength, 24000);
    for (let off = 0; off + 1 < maxBytes; off += 128) {
      const v = Math.abs(dv.getInt16(off, true));
      if (v > 24) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function getNativeScreenCapturePort(): MessagePort | null {
  return captureWorkletNode?.port ?? null;
}

export function isNativeScreenAudioActive(): boolean {
  return !!(active?.track && captureWorkletNode);
}

/**
 * Захват системного звука экрана через Electron main → WASAPI helper → PCM → AudioWorklet track.
 * Одновременно допускается один активный native screen audio (одна демонстрация).
 */
export async function startNativeScreenAudioTrack(
  selection?: NativeDisplaySelection | null
): Promise<MediaStreamTrack | null> {
  try {
    lastStartError = null;
    clearSilenceCheckTimer();
    if (typeof window === "undefined") {
      lastStartError = "Нет window (native screen audio недоступен).";
      return null;
    }
    if (typeof window.sloncord?.startNativeScreenAudio !== "function") {
      lastStartError = "Нет IPC startNativeScreenAudio (не Electron или устаревший preload).";
      return null;
    }
    if (typeof window.sloncord?.onNativeScreenAudio !== "function") {
      lastStartError = "Нет IPC onNativeScreenAudio (не Electron или устаревший preload).";
      return null;
    }
    if (typeof window.sloncord?.stopNativeScreenAudio !== "function") {
      lastStartError = "Нет IPC stopNativeScreenAudio (не Electron или устаревший preload).";
      return null;
    }

    await stopNativeScreenAudioTrack();

    const res = await window.sloncord.startNativeScreenAudio(
      selection === undefined ? undefined : selection === null ? undefined : selection
    );
    if (!res?.ok) {
      lastStartError = res?.error ? String(res.error) : "Не удалось запустить native screen audio.";
      return null;
    }

    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume().catch(() => {});
    const node = await createNativePcmNode(ctx);
    captureWorkletNode = node;
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    const track = dest.stream.getAudioTracks?.()?.[0] || null;
    if (!track) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
      try {
        await window.sloncord.stopNativeScreenAudio();
      } catch {
        /* ignore */
      }
      return null;
    }

    let sawNonSilentChunk = false;
    const unsub = window.sloncord.onNativeScreenAudio((ab) => {
      try {
        if (!sawNonSilentChunk && chunkMayHaveAudioSignal(ab)) sawNonSilentChunk = true;
      } catch {
        /* ignore */
      }
      try {
        node.port.postMessage(ab, [ab]);
      } catch {
        try {
          node.port.postMessage(ab);
        } catch {
          /* ignore */
        }
      }
    }) as (() => void) | void;

    clearSilenceCheckTimer();
    const captureMode =
      res?.captureMode === "dual-subtract"
        ? "dual-subtract"
        : res?.captureMode === "subtract-fallback"
          ? "subtract-fallback"
          : "exclude-tree";
    if (captureMode !== "exclude-tree") {
      try {
        window.dispatchEvent(
          new CustomEvent("sloncord:native-screen-audio-capture-mode", {
            detail: {
              captureMode,
              message:
                captureMode === "dual-subtract"
                  ? "Захват звука: резервный режим (полный микс минус Sloncord). Голос команды слышен у вас; если зрители слышат себя — используйте наушники."
                  : "Захват звука: устаревший резервный режим. При эхе голоса в демонстрации используйте наушники или обновите Windows.",
            },
          })
        );
      } catch {
        /* ignore */
      }
    }
    silenceCheckTimer = setTimeout(() => {
      silenceCheckTimer = null;
      if (!active?.track) return;
      if (sawNonSilentChunk) return;
      try {
        window.dispatchEvent(
          new CustomEvent("sloncord:native-screen-audio-silence", {
            detail: {
              message:
                captureMode === "exclude-tree"
                  ? "Системный звук не захватывается: на устройстве вывода по умолчанию в Windows сейчас тишина, либо играет только Sloncord (его звук намеренно исключён). Запустите музыку/игру на основном устройстве вывода или перезапустите демонстрацию."
                  : "Захват системного звука не получает сигнал. Проверьте громкость и устройство вывода по умолчанию в Windows, затем перезапустите демонстрацию."
            }
          })
        );
      } catch {
        /* ignore */
      }
    }, 8000);

    active = {
      ctx,
      node,
      dest,
      unsub: typeof unsub === "function" ? unsub : null,
      track
    };
    return track;
  } catch {
    lastStartError = lastStartError || "Не удалось запустить native screen audio.";
    return null;
  }
}

export function getLastNativeScreenAudioStartError(): string | null {
  return lastStartError;
}

export async function stopNativeScreenAudioTrack(): Promise<void> {
  clearSilenceCheckTimer();
  captureWorkletNode = null;
  const cur = active;
  active = null;
  try {
    cur?.unsub?.();
  } catch {
    /* ignore */
  }
  try {
    cur?.node?.disconnect();
  } catch {
    /* ignore */
  }
  try {
    cur?.track?.stop?.();
  } catch {
    /* ignore */
  }
  try {
    await cur?.ctx?.close?.();
  } catch {
    /* ignore */
  }
  try {
    await window.sloncord?.stopNativeScreenAudio?.();
  } catch {
    /* ignore */
  }
}
