import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(__dirname, "..", "native", "win-voice-client");
const outDir = path.join(projectDir, "publish");
const resourcesDir = path.join(__dirname, "..", "resources");

const dotnet = spawnSync(
  "dotnet",
  ["publish", projectDir, "-c", "Release", "-o", outDir, "-r", "win-x64", "--self-contained", "true", "/p:PublishSingleFile=true"],
  { stdio: "inherit", shell: true }
);
if (dotnet.status !== 0) process.exit(dotnet.status ?? 1);

const exeSrc = path.join(outDir, "SloncordNativeVoice.exe");
const exeDst = path.join(resourcesDir, "SloncordNativeVoice.exe");
fs.mkdirSync(resourcesDir, { recursive: true });
fs.copyFileSync(exeSrc, exeDst);
console.log("Copied", exeDst);
