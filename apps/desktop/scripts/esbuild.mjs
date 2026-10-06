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
  for (const base of [monorepoRoot, root]) {
    const pkgJson = path.join(base, "node_modules", "esbuild", "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        return createRequire(pathToFileURL(pkgJson).href)("esbuild");
      } catch {
        /* next */
      }
    }
  }
  throw new Error(
    "Не найден пакет esbuild. В корне репозитория Sloncord выполните: npm install"
  );
}

const esbuild = loadEsbuild();

const { DEFAULT_SLONCORD_SERVER_ORIGIN } = await import("../../../shared/defaultServerOrigin.mjs");

const externalElectron = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: false,
  external: ["electron"],
};

/** Базовый URL API, вшивается в exe при сборке (переопределение: SLONCORD_EMBEDDED_API_BASE в env). */
const embeddedApiBaseRaw = process.env.SLONCORD_EMBEDDED_API_BASE?.trim();
const embeddedApiBase =
  embeddedApiBaseRaw && embeddedApiBaseRaw.length > 0
    ? embeddedApiBaseRaw.replace(/\/$/, "")
    : DEFAULT_SLONCORD_SERVER_ORIGIN;

await esbuild.build({
  ...externalElectron,
  format: "cjs",
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist-electron", "main.cjs"),
  define: {
    SLONCORD_EMBEDDED_API_BASE: JSON.stringify(embeddedApiBase),
  },
});

await esbuild.build({
  ...externalElectron,
  format: "cjs",
  entryPoints: [path.join(root, "src", "preload.ts")],
  outfile: path.join(root, "dist-electron", "preload.cjs"),
});

await esbuild.build({
  ...externalElectron,
  format: "cjs",
  entryPoints: [path.join(root, "src", "picker-preload.ts")],
  outfile: path.join(root, "dist-electron", "picker-preload.cjs"),
});

console.log("esbuild: main.cjs + preload.cjs + picker-preload.cjs");
