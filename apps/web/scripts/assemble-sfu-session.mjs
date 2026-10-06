import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/voice");
const header = `import { buildBackendWsUrl } from "../config/apiBase";
import { getLastNativeScreenAudioStartError, startNativeScreenAudioTrack, stopNativeScreenAudioTrack } from "../audio/nativeScreenAudioTrack";
import { loadMediasoupClient } from "./mediasoupLoader";
import {
  applyDisplayCaptureProfileToTrack,
  bitrateForScreenShareProfile,
  buildScreenAudioConstraints,
  screenVolumePctToGain,
  type DisplayCaptureProfile,
} from "./screenShare";

`;

let body = fs.readFileSync(path.join(dir, "sfuSession.body.ts"), "utf8");
body = body.replace(/^function createSfuVoiceSession/, "export function createSfuVoiceSession");
fs.writeFileSync(path.join(dir, "sfuSession.ts"), header + body, "utf8");
console.log("sfuSession.ts written");
