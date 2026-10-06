import { SLONCORD_GITHUB_REPO } from "@sloncord/github-config";

export type DesktopReleaseMeta = {
  version?: string;
  downloadUrl?: string;
  available?: boolean;
  size?: number;
};

function normalizeRepo(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/$/, "");
}

/** Репозитории по очереди (старые сборки могли смотреть на placeholder). */
function reposToTry(): string[] {
  const env = import.meta.env.VITE_SLONCORD_GITHUB_REPO as string | undefined;
  const primary = normalizeRepo(String(env || SLONCORD_GITHUB_REPO || ""));
  const out: string[] = [];
  for (const r of [primary, "anex-tim/sloncord"]) {
    const t = normalizeRepo(r);
    if (t.includes("/") && !out.includes(t)) out.push(t);
  }
  return out;
}

const GITHUB_FETCH_HEADERS: HeadersInit = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Sloncord-Desktop",
};

function normalizeVersion(tag: string): string {
  return String(tag || "")
    .trim()
    .replace(/^v/i, "");
}

/** Последний релиз клиента с GitHub (API → fallback manifest). */
async function fetchLatestFromGithubApi(
  repo: string,
  signal?: AbortSignal
): Promise<DesktopReleaseMeta | null> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(apiUrl, {
    signal,
    cache: "no-store",
    headers: GITHUB_FETCH_HEADERS,
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    tag_name?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  };
  const version = normalizeVersion(String(data?.tag_name || ""));
  const asset = (data?.assets || []).find(
    (a) => String(a?.name || "").toLowerCase() === "sloncord-setup-x64.exe"
  );
  const downloadUrl = String(asset?.browser_download_url || "").trim();
  if (!version || !downloadUrl) return null;
  return {
    version,
    downloadUrl,
    available: true,
    size: typeof asset?.size === "number" ? asset.size : undefined,
  };
}

async function fetchFromManifest(
  repo: string,
  signal?: AbortSignal
): Promise<DesktopReleaseMeta | null> {
  const manifestUrl = `https://raw.githubusercontent.com/${repo}/main/releases/desktop-release.json?t=${Date.now()}`;
  const res = await fetch(manifestUrl, { signal, cache: "no-store", headers: { "User-Agent": "Sloncord-Desktop" } });
  if (!res.ok) return null;
  const data = (await res.json()) as DesktopReleaseMeta;
  const version = normalizeVersion(String(data?.version || ""));
  const downloadUrl = String(data?.downloadUrl || "").trim();
  if (!version || !downloadUrl || data?.available === false) return null;
  return { ...data, version, downloadUrl, available: true };
}

export async function fetchDesktopReleaseFromGithub(
  signal?: AbortSignal
): Promise<DesktopReleaseMeta | null> {
  const repos = reposToTry();
  if (!repos.length) return null;

  for (const repo of repos) {
    try {
      const fromApi = await fetchLatestFromGithubApi(repo, signal);
      if (fromApi) return fromApi;
    } catch {
      /* next */
    }
    try {
      const fromManifest = await fetchFromManifest(repo, signal);
      if (fromManifest) return fromManifest;
    } catch {
      /* next repo */
    }
  }
  return null;
}

export function githubReleasesPageUrl(): string {
  const repos = reposToTry();
  const repo = repos[0] || "";
  return repo ? `https://github.com/${repo}/releases/latest` : "";
}
