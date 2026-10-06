export type DisplayCaptureProfile = {
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
};

export function buildScreenAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
}

export function screenVolumePctToGain(pct: number): number {
  const v = Math.max(0, Math.min(300, Number(pct) || 0));
  if (v <= 0) return 0;
  const norm = v / 300;
  const db = -50 + norm * 66;
  return Math.pow(10, db / 20);
}

export function bitrateForScreenShareProfile(p: DisplayCaptureProfile): number {
  const table: Record<number, Partial<Record<number, number>>> = {
    480: { 15: 600_000, 30: 1_000_000, 60: 1_900_000 },
    720: { 15: 1_200_000, 30: 3_200_000, 60: 7_500_000 },
    1080: { 15: 2_500_000, 30: 6_500_000, 60: 15_000_000 },
    1440: { 15: 4_000_000, 30: 9_500_000, 60: 18_000_000 },
  };
  const row = table[p.maxHeight] ?? table[1080];
  const b = row[p.frameRate] ?? row[30];
  return Math.min(18_000_000, b ?? 6_000_000);
}

export async function applyDisplayCaptureProfileToTrack(
  vtrack: MediaStreamTrack,
  profile: DisplayCaptureProfile | null
): Promise<void> {
  if (!profile) return;
  const h = profile.maxHeight;
  const fr = profile.frameRate;
  try {
    await vtrack.applyConstraints({
      height: { ideal: h, max: h },
      frameRate: { ideal: fr, max: fr },
    });
  } catch {
    try {
      await vtrack.applyConstraints({
        height: { ideal: h },
        frameRate: { ideal: fr, max: fr },
      });
    } catch {
      try {
        await vtrack.applyConstraints({ frameRate: { ideal: fr, max: fr } });
      } catch {
        /* ignore */
      }
    }
  }
}
