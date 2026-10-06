/**
 * Запускает electron-builder с уникальным directories.output (release/pkg-<time>).
 *
 * Использование: node scripts/electron-builder-win.mjs --win
 *                node scripts/electron-builder-win.mjs --win --dir
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(__dirname, "..");
const monorepoRoot = path.join(appRoot, "..", "..");
const require = createRequire(import.meta.url);

function resolveElectronBuilderCli() {
  return require.resolve("electron-builder/cli.js", { paths: [appRoot, monorepoRoot] });
}

const packId = `pkg-${Date.now()}`;
const outputDir = path.join(appRoot, "release", packId);
fs.mkdirSync(outputDir, { recursive: true });

const releaseRoot = path.join(appRoot, "release");
fs.mkdirSync(releaseRoot, { recursive: true });
fs.writeFileSync(
  path.join(releaseRoot, ".slonmod-last-pack-dir"),
  `${path.resolve(outputDir)}\n`,
  "utf8"
);

const userArgs = process.argv.slice(2);
if (userArgs.length === 0) {
  console.error("slonmod: укажите аргументы electron-builder, например --win или --win --dir");
  process.exit(2);
}

const configArg = `--config.directories.output=${outputDir}`;
const cli = resolveElectronBuilderCli();
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
};

console.log(`slonmod: electron-builder output → ${outputDir}`);

const r = spawnSync(process.execPath, [cli, configArg, ...userArgs], {
  cwd: appRoot,
  stdio: "inherit",
  env,
  windowsHide: true,
});

process.exit(r.status === null ? 1 : r.status);
