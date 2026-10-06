/**
 * Сборка Windows-клиента и публикация на GitHub Releases.
 *
 * Требуется: git, gh (GitHub CLI), авторизация `gh auth login`.
 *
 *   SLONCORD_GITHUB_REPO=owner/sloncord node scripts/publish-desktop-github.mjs
 *   npm run publish:desktop
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const { SLONCORD_GITHUB_REPO, SLONCORD_DESKTOP_INSTALLER_NAME } = await import(
  "../shared/sloncordGithub.mjs"
);

const pkg = JSON.parse(
  readFileSync(path.join(root, "apps", "desktop", "package.json"), "utf8")
);
const version = String(pkg.version || "").trim();
if (!version) {
  console.error("Не задана version в apps/desktop/package.json");
  process.exit(1);
}

const repo = String(process.env.SLONCORD_GITHUB_REPO || SLONCORD_GITHUB_REPO).trim();
if (!repo.includes("/")) {
  console.error("Задайте SLONCORD_GITHUB_REPO=owner/repo");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`→ Сборка Sloncord Desktop ${version}…`);
run("npm", ["run", "build:desktop-installer"]);

const installerPath = path.join(root, "apps", "web", "public", "downloads", SLONCORD_DESKTOP_INSTALLER_NAME);
if (!existsSync(installerPath)) {
  console.error(`Не найден ${installerPath}`);
  process.exit(1);
}

const tag = version.startsWith("v") ? version : `v${version}`;
const releasesDir = path.join(root, "releases");
const manifestPath = path.join(releasesDir, "desktop-release.json");
const st = readFileSync(installerPath);
const meta = {
  version,
  available: true,
  fileName: SLONCORD_DESKTOP_INSTALLER_NAME,
  downloadUrl: `https://github.com/${repo}/releases/download/${tag}/${SLONCORD_DESKTOP_INSTALLER_NAME}`,
  size: st.length,
  releasedAt: new Date().toISOString(),
  githubRepo: repo,
};
writeFileSync(manifestPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

console.log(`→ GitHub Release ${tag} (${repo})…`);
const viewOk = spawnSync("gh", ["release", "view", tag, "--repo", repo], {
  cwd: root,
  stdio: "pipe",
  shell: true,
});
if (viewOk.status !== 0) {
  run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    repo,
    "--title",
    `Sloncord ${version}`,
    "--notes",
    `Windows installer (${SLONCORD_DESKTOP_INSTALLER_NAME}).`,
  ]);
} else {
  console.log(`Релиз ${tag} уже существует — загружаю asset заново.`);
}

run("gh", [
  "release",
  "upload",
  tag,
  installerPath,
  "--repo",
  repo,
  "--clobber",
]);

console.log(`\nГотово: https://github.com/${repo}/releases/tag/${tag}`);
console.log("Не забудьте закоммитить releases/desktop-release.json и запушить в main.");
