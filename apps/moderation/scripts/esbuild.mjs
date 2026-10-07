import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(root, "..", "..");

function loadEsbuild() {
  const candidateRefs = [
    import.meta.url,
    pathToFileURL(path.join(root, "package.json")).href,
    pathToFileURL(path.join(monorepoRoot, "package.json")).href,
  ];
  for (const ref of candidateRefs) {
    try {
      return createRequire(ref)("esbuild");
    } catch {
      /* next */
    }
  }
  throw new Error("esbuild not found — run npm install in repo root");
}

const esbuild = loadEsbuild();

const sharedOriginCandidates = [
  path.join(root, "shared", "defaultServerOrigin.mjs"),
  path.join(monorepoRoot, "shared", "defaultServerOrigin.mjs"),
];
const sharedOriginPath = sharedOriginCandidates.find((p) => fs.existsSync(p));
if (!sharedOriginPath) throw new Error("defaultServerOrigin.mjs not found");
const { DEFAULT_SLONCORD_SERVER_ORIGIN } = await import(pathToFileURL(sharedOriginPath).href);

const externalElectron = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: false,
  external: ["electron"],
  // electron-store бандлим в main.cjs — без production npm install в electron-builder.
};

const embeddedApiBaseRaw = process.env.SLONMOD_EMBEDDED_API_BASE?.trim();
const embeddedApiBase =
  embeddedApiBaseRaw && embeddedApiBaseRaw.length > 0
    ? embeddedApiBaseRaw.replace(/\/$/, "")
    : DEFAULT_SLONCORD_SERVER_ORIGIN;

await esbuild.build({
  ...externalElectron,
  format: "cjs",
  entryPoints: [path.join(root, "electron", "main.ts")],
  outfile: path.join(root, "dist-electron", "main.cjs"),
  define: {
    SLONMOD_EMBEDDED_API_BASE: JSON.stringify(embeddedApiBase),
    SLONMOD_GITHUB_REPO: JSON.stringify(
      String(process.env.SLONMOD_GITHUB_REPO || "anex-tim/sloncord-moderation").trim()
    ),
  },
});

await esbuild.build({
  ...externalElectron,
  format: "cjs",
  entryPoints: [path.join(root, "electron", "preload.ts")],
  outfile: path.join(root, "dist-electron", "preload.cjs"),
});

console.log("Compiled moderation electron → dist-electron/");
