/**
 * GitHub: исходники + релизы Windows-клиента.
 * Переопределение: SLONCORD_GITHUB_REPO=owner/repo (сборка, CI, publish-desktop-github.mjs).
 */
export const SLONCORD_GITHUB_REPO = String(
  process.env.SLONCORD_GITHUB_REPO || "anex-tim/sloncord"
)
  .trim()
  .replace(/^https?:\/\/github\.com\//i, "")
  .replace(/\/$/, "");

export const SLONCORD_DESKTOP_INSTALLER_NAME = "Sloncord-Setup-x64.exe";

/** @param {string} [repo] */
export function githubLatestReleaseApiUrl(repo = SLONCORD_GITHUB_REPO) {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** @param {string} [repo] */
export function githubDesktopReleaseManifestUrl(repo = SLONCORD_GITHUB_REPO, ref = "main") {
  return `https://raw.githubusercontent.com/${repo}/${ref}/releases/desktop-release.json`;
}

/** @param {string} host */
export function isTrustedUpdateDownloadHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  if (h === "github.com" || h.endsWith(".github.com")) return true;
  if (h === "githubusercontent.com" || h.endsWith(".githubusercontent.com")) return true;
  return false;
}
