/**
 * Во время демонстрации с системным звуком: воспроизводит голос команды через WebAudio
 * и отдаёт reference-сигнал в worklet захвата экрана для вычитания эха Sloncord из loopback.
 */
export type VoiceRefEntry = {
  key: string;
  track: MediaStreamTrack;
  gain: number;
};

let refTapAdded = new WeakSet<AudioContext>();

function refTapModuleSource(): string {
  return `
class SloncordEchoRefTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp[0] || inp[0].length === 0) return true;
    const L = inp[0];
    const R = inp[1] && inp[1].length === L.length ? inp[1] : L;
    const n = L.length;
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      out[i * 2] = L[i];
      out[i * 2 + 1] = R[i];
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor('sloncord-echo-ref-tap', SloncordEchoRefTapProcessor);
`;
}

async function ensureRefTapWorklet(ctx: AudioContext): Promise<void> {
  if (refTapAdded.has(ctx)) return;
  const blob = new Blob([refTapModuleSource()], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
    refTapAdded.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type SourceSlot = {
  cloneTrack: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
};

export class ScreenAudioVoiceRef {
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private tapNode: AudioWorkletNode | null = null;
  private slots = new Map<string, SourceSlot>();
  private capturePort: MessagePort | null = null;
  private outputDeviceId = "";

  async start(capturePort: MessagePort, outputDeviceId = ""): Promise<void> {
    await this.stop();
    this.capturePort = capturePort;
    this.outputDeviceId = String(outputDeviceId || "");
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume().catch(() => {});
    await ensureRefTapWorklet(ctx);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    const tap = new AudioWorkletNode(ctx, "sloncord-echo-ref-tap", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
    });
    const silent = ctx.createGain();
    silent.gain.value = 0;
    bus.connect(tap);
    tap.connect(silent);
    silent.connect(ctx.destination);
    bus.connect(ctx.destination);
    tap.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      try {
        const ab = ev.data;
        if (!ab || !(ab instanceof ArrayBuffer)) return;
        capturePort.postMessage({ type: "ref", ab }, [ab]);
      } catch {
        /* ignore */
      }
    };
    try {
      capturePort.postMessage({ type: "subtract", enabled: true, delay: 9600, gain: 1.12 });
    } catch {
      /* ignore */
    }
    await this.applyOutputDevice(ctx);
    this.ctx = ctx;
    this.bus = bus;
    this.tapNode = tap;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = String(deviceId || "");
    if (this.ctx) await this.applyOutputDevice(this.ctx);
  }

  private async applyOutputDevice(ctx: AudioContext): Promise<void> {
    if (!this.outputDeviceId) return;
    try {
      if (typeof (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId === "function") {
        await (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(this.outputDeviceId);
      }
    } catch {
      /* ignore */
    }
  }

  sync(entries: VoiceRefEntry[]): Promise<void> {
    const ctx = this.ctx;
    const bus = this.bus;
    if (!ctx || !bus) return Promise.resolve();

    const want = new Set<string>();
    for (const e of entries) {
      const key = String(e.key || "");
      const track = e.track;
      if (!key || !track || track.readyState === "ended") continue;
      want.add(key);
      const g = Math.max(0, Math.min(3, Number(e.gain) || 0));
      let slot = this.slots.get(key);
      if (slot && slot.cloneTrack.id !== track.id) {
        try {
          slot.source.disconnect();
        } catch {
          /* ignore */
        }
        try {
          slot.gain.disconnect();
        } catch {
          /* ignore */
        }
        try {
          slot.cloneTrack.stop();
        } catch {
          /* ignore */
        }
        this.slots.delete(key);
        slot = undefined;
      }
      if (!slot) {
        let cloneTrack = track;
        try {
          if (typeof track.clone === "function") cloneTrack = track.clone();
        } catch {
          /* use original */
        }
        const stream = new MediaStream([cloneTrack]);
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(bus);
        slot = { cloneTrack, source, gain };
        this.slots.set(key, slot);
      }
      try {
        slot.gain.gain.value = g;
      } catch {
        /* ignore */
      }
    }

    for (const [key, slot] of [...this.slots.entries()]) {
      if (want.has(key)) continue;
      try {
        slot.source.disconnect();
      } catch {
        /* ignore */
      }
      try {
        slot.gain.disconnect();
      } catch {
        /* ignore */
      }
      try {
        slot.cloneTrack.stop();
      } catch {
        /* ignore */
      }
      this.slots.delete(key);
    }
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    for (const slot of this.slots.values()) {
      try {
        slot.source.disconnect();
      } catch {
        /* ignore */
      }
      try {
        slot.gain.disconnect();
      } catch {
        /* ignore */
      }
      try {
        slot.cloneTrack.stop();
      } catch {
        /* ignore */
      }
    }
    this.slots.clear();
    try {
      this.tapNode?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      this.bus?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (this.capturePort) {
        this.capturePort.postMessage({ type: "subtract", enabled: false });
      }
    } catch {
      /* ignore */
    }
    this.tapNode = null;
    this.bus = null;
    this.capturePort = null;
    const ctx = this.ctx;
    this.ctx = null;
    try {
      await ctx?.close?.();
    } catch {
      /* ignore */
    }
  }
}
