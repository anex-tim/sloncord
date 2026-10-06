/**
 * Одноразовая настройка GitHub: repo, push, релиз desktop 3.x.
 * Требуется: gh auth login (или GH_TOKEN).
 *
 *   node scripts/github-bootstrap.mjs
 *   SLONCORD_GITHUB_REPO=owner/sloncord node scripts/github-bootstrap.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: "utf8", shell: true });
}

const st = runCapture("gh", ["auth", "status"]);
if (st.status !== 0) {
  console.error("Сначала выполните: gh auth login -h github.com -p https -w");
  process.exit(1);
}

const login = runCapture("gh", ["api", "user", "--jq", ".login"]).stdout.trim();
if (!login) {
  console.error("Не удалось получить GitHub login через gh api user");
  process.exit(1);
}

let repo = String(process.env.SLONCORD_GITHUB_REPO || "").trim();
if (!repo.includes("/")) repo = `${login}/sloncord`;

console.log(`→ Репозиторий: ${repo}`);

function patchRepoInFile(relPath, replacer) {
  const p = path.join(root, relPath);
  if (!existsSync(p)) return;
  const before = readFileSync(p, "utf8");
  const after = replacer(before);
  if (after !== before) writeFileSync(p, after, "utf8");
}

patchRepoInFile("shared/sloncordGithub.mjs", (s) =>
  s.replace(/"sloncord-app\/sloncord"/, `"${repo}"`)
);
patchRepoInFile("releases/desktop-release.json", (s) =>
  s.replace(/sloncord-app\/sloncord/g, repo)
);

const view = runCapture("gh", ["repo", "view", repo]);
if (view.status !== 0) {
  console.log("→ Создаю репозиторий на GitHub…");
  run("gh", ["repo", "create", repo, "--public", "--source=.", "--remote=origin", "--push"]);
} else {
  const rem = runCapture("git", ["remote", "get-url", "origin"]);
  if (rem.status !== 0) {
    run("git", ["remote", "add", "origin", `https://github.com/${repo}.git`]);
  }
  run("git", ["push", "-u", "origin", "main"]);
}

const dirty = runCapture("git", ["status", "--porcelain"]);
if (dirty.stdout.trim()) {
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", `chore: point desktop updates to ${repo}`]);
  run("git", ["push", "origin", "main"]);
}

console.log("→ Публикация Windows-клиента (сборка + GitHub Release)…");
run("node", ["scripts/publish-desktop-github.mjs"], {
  env: { ...process.env, SLONCORD_GITHUB_REPO: repo },
});

const dirty2 = runCapture("git", ["status", "--porcelain"]);
if (dirty2.stdout.trim()) {
  run("git", ["add", "releases/desktop-release.json"]);
  run("git", ["commit", "-m", "chore: update desktop-release.json"]);
  run("git", ["push", "origin", "main"]);
}

console.log(`\nГотово:\n  https://github.com/${repo}\n  https://github.com/${repo}/releases/latest`);
