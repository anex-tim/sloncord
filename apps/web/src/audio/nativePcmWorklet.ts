let addedToContext = new WeakSet<AudioContext>();

function makeModuleSource(): string {
  return `
class SloncordNativePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._bufL = new Float32Array(48000);
    this._bufR = new Float32Array(48000);
    this._w = 0;
    this._r = 0;
    this._size = 48000;
    this._available = 0;

    this._refL = new Float32Array(96000);
    this._refR = new Float32Array(96000);
    this._refW = 0;
    this._refSize = 96000;
    this._refAvail = 0;
    this._refDelay = 9600;
    this._subtractGain = 1.12;
    this._subtractEnabled = false;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d instanceof ArrayBuffer) {
        this._pushCapture(d);
        return;
      }
      if (!d || typeof d !== 'object') return;
      if (d.type === 'ref' && d.ab instanceof ArrayBuffer) {
        this._pushRef(d.ab);
        return;
      }
      if (d.type === 'subtract') {
        this._subtractEnabled = !!d.enabled;
        if (Number.isFinite(d.delay)) this._refDelay = Math.max(0, Math.min(48000, d.delay | 0));
        if (Number.isFinite(d.gain)) this._subtractGain = Math.max(0, Math.min(2, d.gain));
      }
    };
  }
  _pushCapture(ab) {
    const view = new DataView(ab);
    const frames = Math.floor(view.byteLength / 4);
    for (let i = 0; i < frames; i++) {
      const off = i * 4;
      this._bufL[this._w] = view.getInt16(off, true) / 32768;
      this._bufR[this._w] = view.getInt16(off + 2, true) / 32768;
      this._w = (this._w + 1) % this._size;
      if (this._available < this._size) this._available++;
      else this._r = (this._r + 1) % this._size;
    }
  }
  _pushRef(ab) {
    const f = new Float32Array(ab);
    const frames = Math.floor(f.length / 2);
    for (let i = 0; i < frames; i++) {
      this._refL[this._refW] = f[i * 2];
      this._refR[this._refW] = f[i * 2 + 1];
      this._refW = (this._refW + 1) % this._refSize;
      if (this._refAvail < this._refSize) this._refAvail++;
    }
  }
  _readRef(offset) {
    if (this._refAvail <= offset) return { l: 0, r: 0 };
    const idx = (this._refW - 1 - offset + this._refSize * 2) % this._refSize;
    return { l: this._refL[idx], r: this._refR[idx] };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const L = out[0];
    const R = out[1];
    const n = L.length;
    for (let i = 0; i < n; i++) {
      let capL = 0;
      let capR = 0;
      if (this._available > 0) {
        capL = this._bufL[this._r];
        capR = this._bufR[this._r];
        this._r = (this._r + 1) % this._size;
        this._available--;
      }
      if (this._subtractEnabled && this._refAvail > this._refDelay) {
        const ref = this._readRef(this._refDelay);
        capL -= ref.l * this._subtractGain;
        capR -= ref.r * this._subtractGain;
      }
      if (capL > 1) capL = 1;
      else if (capL < -1) capL = -1;
      if (capR > 1) capR = 1;
      else if (capR < -1) capR = -1;
      L[i] = capL;
      R[i] = capR;
    }
    return true;
  }
}
registerProcessor('sloncord-native-pcm', SloncordNativePcmProcessor);
`;
}

export async function ensureNativePcmWorklet(ctx: AudioContext): Promise<void> {
  if (addedToContext.has(ctx)) return;
  const src = makeModuleSource();
  const blob = new Blob([src], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
    addedToContext.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createNativePcmNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  await ensureNativePcmWorklet(ctx);
  return new AudioWorkletNode(ctx, "sloncord-native-pcm", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
}
