import { SLONCORD_GITHUB_REPO } from "@sloncord/github-config";

export type DesktopReleaseMeta = {
  version?: string;
  downloadUrl?: string;
  available?: boolean;
  size?: number;
};

function repoFromEnv(): string {
  const env = import.meta.env.VITE_SLONCORD_GITHUB_REPO as string | undefined;
  const t = String(env || SLONCORD_GITHUB_REPO || "").trim();
  return t.replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "");
}

function normalizeVersion(tag: string): string {
  return String(tag || "")
    .trim()
    .replace(/^v/i, "");
}

/** Последний релиз клиента с GitHub (API → fallback manifest). */
export async function fetchDesktopReleaseFromGithub(
  signal?: AbortSignal
): Promise<DesktopReleaseMeta | null> {
  const repo = repoFromEnv();
  if (!repo || !repo.includes("/")) return null;

  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  try {
    const res = await fetch(apiUrl, {
      signal,
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const data = (await res.json()) as {
        tag_name?: string;
        assets?: { name?: string; browser_download_url?: string; size?: number }[];
      };
      const version = normalizeVersion(String(data?.tag_name || ""));
      const asset = (data?.assets || []).find(
        (a) => String(a?.name || "").toLowerCase() === "sloncord-setup-x64.exe"
      );
      const downloadUrl = String(asset?.browser_download_url || "").trim();
      if (version && downloadUrl) {
        return {
          version,
          downloadUrl,
          available: true,
          size: typeof asset?.size === "number" ? asset.size : undefined,
        };
      }
    }
  } catch {
    /* try manifest */
  }

  const manifestUrl = `https://raw.githubusercontent.com/${repo}/main/releases/desktop-release.json?t=${Date.now()}`;
  try {
    const res = await fetch(manifestUrl, { signal, cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as DesktopReleaseMeta;
    const version = normalizeVersion(String(data?.version || ""));
    const downloadUrl = String(data?.downloadUrl || "").trim();
    if (!version || !downloadUrl || data?.available === false) return null;
    return { ...data, version, downloadUrl, available: true };
  } catch {
    return null;
  }
}

export function githubReleasesPageUrl(): string {
  const repo = repoFromEnv();
  return repo ? `https://github.com/${repo}/releases/latest` : "";
}
