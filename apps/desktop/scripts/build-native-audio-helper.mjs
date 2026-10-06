import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const nativeDir = path.join(root, "native", "win-audio-helper");
const buildDir = path.join(nativeDir, "build");
const outExe = path.join(buildDir, "Release", "SloncordWinAudioHelper.exe");
const destExe = path.join(root, "resources", "SloncordWinAudioHelper.exe");

if (process.platform !== "win32") {
  console.log("native-audio-helper: skip (not win32)");
  process.exit(0);
}

function hasCmd(cmd) {
  const whereExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe");
  const r = spawnSync(fs.existsSync(whereExe) ? whereExe : "where", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

function findVsCmake() {
  try {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const roots = [
      path.join(pf, "Microsoft Visual Studio", "2022", "BuildTools"),
      path.join(pf, "Microsoft Visual Studio", "2022", "Community"),
      path.join(pf, "Microsoft Visual Studio", "2022", "Professional"),
      path.join(pf, "Microsoft Visual Studio", "2022", "Enterprise"),
      path.join(pf, "Microsoft Visual Studio", "2019", "BuildTools"),
      path.join(pf, "Microsoft Visual Studio", "2019", "Community"),
      path.join(pf, "Microsoft Visual Studio", "2019", "Professional"),
      path.join(pf, "Microsoft Visual Studio", "2019", "Enterprise"),
    ];

    const rels = [
      path.join("Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe"),
      path.join("Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "bin", "cmake.exe"),
    ];

    for (const base of roots) {
      for (const rel of rels) {
        const p = path.join(base, rel);
        if (fs.existsSync(p)) return p;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function findVsWhere() {
  const pf86 =
    process.env["ProgramFiles(x86)"] ||
    process.env["ProgramFiles"] ||
    "C:\\Program Files (x86)";
  const p = path.join(pf86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  return fs.existsSync(p) ? p : null;
}

function findVsInstallPath() {
  try {
    const vswhere = findVsWhere();
    if (!vswhere) return null;
    const r = spawnSync(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.Component.MSBuild",
      "-property",
      "installationPath",
    ], { encoding: "utf8" });
    const base = String(r.stdout || "").trim();
    if (!base) return null;
    if (!fs.existsSync(base)) return null;
    // Require C++ toolchain presence (Desktop development with C++).
    const vcTools = path.join(base, "VC", "Tools", "MSVC");
    if (!fs.existsSync(vcTools)) return null;
    return base;
  } catch {
    return null;
  }
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!hasCmd("cmake")) {
  // Common default install location.
  const cmakeDefault = path.join(process.env["ProgramFiles"] || "C:\\Program Files", "CMake", "bin", "cmake.exe");
  if (fs.existsSync(cmakeDefault)) {
    console.log(`native-audio-helper: using default cmake: ${cmakeDefault}`);
    globalThis.__SLONCORD_CMAKE__ = cmakeDefault;
  } else {
  const vsCmake = findVsCmake();
  if (vsCmake) {
    console.log(`native-audio-helper: using VS cmake: ${vsCmake}`);
    // Replace run() calls below by using this absolute path.
    globalThis.__SLONCORD_CMAKE__ = vsCmake;
  } else {
  if (fs.existsSync(destExe)) {
    console.log(`native-audio-helper: cmake not found, using existing ${destExe}`);
    process.exit(0);
  }
  console.error("native-audio-helper: cmake not found in PATH.");
  console.error("Install CMake (and MSVC Build Tools) or provide apps/desktop/resources/SloncordWinAudioHelper.exe");
  process.exit(1);
  }
  }
}

fs.mkdirSync(buildDir, { recursive: true });

// Configure + build (MSVC generator chosen by CMake on Windows).
const cmakeCmd = globalThis.__SLONCORD_CMAKE__ ? globalThis.__SLONCORD_CMAKE__ : "cmake";
const vsInstall = findVsInstallPath();
if (vsInstall) {
  // Force VS generator so we don't depend on nmake being in PATH.
  try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(buildDir, { recursive: true });
  run(cmakeCmd, ["-S", nativeDir, "-B", buildDir, "-G", "Visual Studio 17 2022", "-A", "x64"]);
  run(cmakeCmd, ["--build", buildDir, "--config", "Release"]);
} else if (hasCmd("ninja") && hasCmd("cl")) {
  // Fallback for environments with MSVC already in PATH.
  try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(buildDir, { recursive: true });
  run(cmakeCmd, ["-S", nativeDir, "-B", buildDir, "-G", "Ninja"]);
  run(cmakeCmd, ["--build", buildDir, "--config", "Release"]);
} else {
  if (fs.existsSync(destExe)) {
    console.log(`native-audio-helper: build tools missing, using existing ${destExe}`);
    process.exit(0);
  }
  console.error("native-audio-helper: MSVC Build Tools not found.");
  console.error("Install Visual Studio Build Tools with 'Desktop development with C++' workload.");
  process.exit(1);
}

if (!fs.existsSync(outExe)) {
  console.error(`native-audio-helper: output not found: ${outExe}`);
  process.exit(2);
}

fs.copyFileSync(outExe, destExe);
console.log(`native-audio-helper: copied -> ${destExe}`);

