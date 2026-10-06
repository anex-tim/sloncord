import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(appRoot, "..", "..");
const require = createRequire(path.join(monorepoRoot, "package.json"));

const appBuilderExe = path.join(
  monorepoRoot,
  "node_modules",
  "app-builder-bin",
  "win",
  "x64",
  "app-builder.exe"
);

if (!fs.existsSync(appBuilderExe)) {
  console.error(
    "Не найден app-builder.exe. В корне репозитория выполните:\n  npm install\n"
  );
  process.exit(1);
}

try {
  require.resolve("electron-builder/cli.js", { paths: [appRoot, monorepoRoot] });
} catch {
  console.error(
    "Не найден electron-builder. В корне репозитория выполните:\n  npm install\n"
  );
  process.exit(1);
}
