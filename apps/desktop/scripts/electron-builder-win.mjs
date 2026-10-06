/**
 * Запускает electron-builder с уникальным directories.output (release/pkg-<time>),
 * чтобы можно было собирать, не закрывая уже запущенный Sloncord из предыдущей сборки.
 *
 * Путь записывается в release/.sloncord-last-pack-dir для publish-to-web.mjs.
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
const desktopRoot = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

function resolveElectronBuilderCli() {
  return require.resolve("electron-builder/cli.js", { paths: [desktopRoot, path.join(desktopRoot, "..", "..")] });
}

const packId = `pkg-${Date.now()}`;
const outputDir = path.join(desktopRoot, "release", packId);
fs.mkdirSync(outputDir, { recursive: true });

const releaseRoot = path.join(desktopRoot, "release");
fs.mkdirSync(releaseRoot, { recursive: true });
const marker = path.join(releaseRoot, ".sloncord-last-pack-dir");
fs.writeFileSync(marker, `${path.resolve(outputDir)}\n`, "utf8");

const userArgs = process.argv.slice(2);
if (userArgs.length === 0) {
  // eslint-disable-next-line no-console
  console.error("sloncord: укажите аргументы electron-builder, например --win или --win --dir");
  process.exit(2);
}

const configArg = `--config.directories.output=${outputDir}`;
const cli = resolveElectronBuilderCli();
const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? "false",
};

// eslint-disable-next-line no-console
console.log(`sloncord: electron-builder output → ${outputDir}`);

const r = spawnSync(process.execPath, [cli, configArg, ...userArgs], {
  cwd: desktopRoot,
  stdio: "inherit",
  env,
  windowsHide: true,
});

process.exit(r.status === null ? 1 : r.status);
