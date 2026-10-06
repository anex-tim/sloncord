import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/App.tsx");
let lines = fs.readFileSync(p, "utf8").split(/\r?\n/);

// Delete createVoiceSession + loadMediasoup + createSfuVoiceSession (1-based 9763..14099)
const start = 9762;
const end = 14098;
lines = lines.slice(0, start).concat(lines.slice(end + 1));

const out = [];
for (const line of lines) {
  if (line.includes("nativeScreenAudioTrack")) continue;
  out.push(line);
  if (line.includes('from "./ElectronUpdateOverlay"')) {
    out.push('import { createSfuVoiceSession } from "./voice/sfuSession";');
  }
}

const filtered = [];
let skip = false;
for (const line of out) {
  if (line.startsWith("type DisplayCaptureProfile")) {
    skip = true;
    continue;
  }
  if (line.startsWith("function buildScreenAudioConstraints")) {
    skip = true;
    continue;
  }
  if (skip && line.trim() === "};" && !line.includes("return")) {
    // end of buildScreenAudioConstraints only - fragile
  }
  if (line.startsWith("/** Битрейт VP8")) {
    skip = true;
    continue;
  }
  if (line.startsWith("function fileKindByName")) {
    skip = false;
    filtered.push(line);
    continue;
  }
  if (skip) continue;
  filtered.push(line);
}

fs.writeFileSync(p, filtered.join("\n"), "utf8");
console.log("App.tsx pruned to", filtered.length, "lines");
