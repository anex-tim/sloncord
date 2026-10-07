/**
 * Сборка Sloncord Moderation и публикация на GitHub Releases.
 * Репозиторий отдельный от клиента: anex-tim/sloncord-moderation.
 *
 * Контракт обновления (как у desktop, своё имя файла):
 * asset Sloncord-Moderation-Setup-x64.exe, тег vX.Y.Z, --latest,
 * releases/moderation-release.json: version, available, fileName, downloadUrl, size, githubRepo.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const repo = String(process.env.SLONMOD_GITHUB_REPO || "anex-tim/sloncord-moderation").trim();
const installerName = "Sloncord-Moderation-Setup-x64.exe";

const pkg = JSON.parse(readFileSync(path.join(root, "apps", "moderation", "package.json"), "utf8"));
const version = String(pkg.version || "").trim();
if (!version) {
  console.error("Не задана version в apps/moderation/package.json");
  process.exit(1);
}

function resolveGhBin() {
  if (process.platform !== "win32") return "gh";
  const found = spawnSync("where.exe", ["gh"], { encoding: "utf8", shell: false });
  const lines = String(found.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.find((p) => p.toLowerCase().endsWith("gh.exe")) || lines[0] || "gh";
}

const ghBin = resolveGhBin();

function gh(args) {
  const r = spawnSync(ghBin, args, { cwd: root, stdio: "inherit", shell: false });
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function findBuiltInstaller() {
  const modRoot = path.join(root, "apps", "moderation");
  const marker = path.join(modRoot, "release", ".slonmod-last-pack-dir");
  let dir = "";
  if (existsSync(marker)) {
    const p = readFileSync(marker, "utf8").trim();
    if (p && existsSync(p)) dir = p;
  }
  if (!dir) {
    console.error("Не найден каталог сборки moderation (release/.slonmod-last-pack-dir).");
    process.exit(1);
  }
  const exes = readdirSync(dir).filter(
    (name) => /\.exe$/i.test(name) && !/uninstall/i.test(name) && !/blockmap/i.test(name)
  );
  if (!exes.length) {
    console.error(`В ${dir} нет установщика .exe`);
    process.exit(1);
  }
  exes.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
  const src = path.join(dir, exes[0]);
  const dest = path.join(dir, installerName);
  if (path.resolve(src) !== path.resolve(dest)) copyFileSync(src, dest);
  return dest;
}

console.log(`→ Сборка Sloncord Moderation ${version}…`);
run("npm", ["run", "build", "-w", "@sloncord/moderation"]);

const installerPath = findBuiltInstaller();

const tag = version.startsWith("v") ? version : `v${version}`;
const manifestDir = path.join(root, "apps", "moderation", "releases");
mkdirSync(manifestDir, { recursive: true });
const manifestPath = path.join(manifestDir, "moderation-release.json");
const st = readFileSync(installerPath);
const meta = {
  version,
  available: true,
  fileName: installerName,
  downloadUrl: `https://github.com/${repo}/releases/download/${tag}/${installerName}`,
  size: st.length,
  releasedAt: new Date().toISOString(),
  githubRepo: repo,
};
writeFileSync(manifestPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
const webManifest = path.join(root, "apps", "web", "public", "downloads", "moderation-release.json");
if (existsSync(path.dirname(webManifest))) {
  writeFileSync(webManifest, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

console.log(`→ GitHub Release ${tag} (${repo})…`);
const viewOk = spawnSync(ghBin, ["release", "view", tag, "--repo", repo], {
  cwd: root,
  stdio: "ignore",
  shell: false,
});
if (viewOk.status !== 0) {
  gh([
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--target",
    "main",
    "--latest",
    "--title",
    `Sloncord Moderation ${version}`,
    "--notes",
    `Windows installer (${installerName}).`,
  ]);
} else {
  console.log(`Релиз ${tag} уже существует — помечаю latest и загружаю asset заново.`);
  gh(["release", "edit", tag, "--repo", repo, "--latest"]);
}

gh(["release", "upload", tag, installerPath, "--repo", repo, "--clobber"]);
console.log(`\nГотово: https://github.com/${repo}/releases/tag/${tag}`);
