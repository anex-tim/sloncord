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

const INSTALLER_NAME = "sloncord-setup-x64.exe";

function compareSemver(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map((x) => parseInt(x, 10));
  const pb = normalizeVersion(b).split(".").map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function metaFromReleaseJson(data: {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string; size?: number }[];
}): DesktopReleaseMeta | null {
  const version = normalizeVersion(String(data?.tag_name || ""));
  const asset = (data?.assets || []).find(
    (a) => String(a?.name || "").toLowerCase() === INSTALLER_NAME
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

export function pickNewestDesktopRelease(candidates: DesktopReleaseMeta[]): DesktopReleaseMeta | null {
  let best: DesktopReleaseMeta | null = null;
  for (const c of candidates) {
    const v = normalizeVersion(String(c.version || ""));
    const du = String(c.downloadUrl || "").trim();
    if (!v || !du || c.available === false) continue;
    if (!best || compareSemver(v, String(best.version || "")) > 0) {
      best = { ...c, version: v, downloadUrl: du, available: true };
    }
  }
  return best;
}

/** /releases/latest — может отставать от более нового тега без флага Latest. */
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
  return metaFromReleaseJson(data);
}

/** Все недавние релизы — берём максимальный semver с installer. */
async function fetchFromGithubReleaseList(
  repo: string,
  signal?: AbortSignal
): Promise<DesktopReleaseMeta | null> {
  const apiUrl = `https://api.github.com/repos/${repo}/releases?per_page=30`;
  const res = await fetch(apiUrl, {
    signal,
    cache: "no-store",
    headers: GITHUB_FETCH_HEADERS,
  });
  if (!res.ok) return null;
  const list = (await res.json()) as {
    tag_name?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  }[];
  const candidates: DesktopReleaseMeta[] = [];
  for (const item of list || []) {
    const m = metaFromReleaseJson(item);
    if (m) candidates.push(m);
  }
  return pickNewestDesktopRelease(candidates);
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
    const candidates: DesktopReleaseMeta[] = [];
    try {
      const fromLatest = await fetchLatestFromGithubApi(repo, signal);
      if (fromLatest) candidates.push(fromLatest);
    } catch {
      /* ignore */
    }
    try {
      const fromList = await fetchFromGithubReleaseList(repo, signal);
      if (fromList) candidates.push(fromList);
    } catch {
      /* ignore */
    }
    try {
      const fromManifest = await fetchFromManifest(repo, signal);
      if (fromManifest) candidates.push(fromManifest);
    } catch {
      /* ignore */
    }
    const best = pickNewestDesktopRelease(candidates);
    if (best) return best;
  }
  return null;
}

export function githubReleasesPageUrl(): string {
  const repos = reposToTry();
  const repo = repos[0] || "";
  return repo ? `https://github.com/${repo}/releases/latest` : "";
}
