export type ModerationReleaseMeta = {
  version?: string;
  downloadUrl?: string;
  available?: boolean;
  size?: number;
};

const INSTALLER_NAME = "sloncord-moderation-setup-x64.exe";
const DEFAULT_REPO = "anex-tim/sloncord-moderation";

const GITHUB_FETCH_HEADERS: HeadersInit = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Sloncord-Moderation",
};

function normalizeRepo(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/$/, "");
}

function reposToTry(): string[] {
  const env = import.meta.env.VITE_SLONMOD_GITHUB_REPO as string | undefined;
  const out: string[] = [];
  for (const r of [env, DEFAULT_REPO]) {
    const t = normalizeRepo(String(r || ""));
    if (t.includes("/") && !out.includes(t)) out.push(t);
  }
  return out;
}

function normalizeVersion(tag: string): string {
  return String(tag || "")
    .trim()
    .replace(/^v/i, "");
}

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
}): ModerationReleaseMeta | null {
  const version = normalizeVersion(String(data?.tag_name || ""));
  const asset = (data?.assets || []).find(
    (item) => String(item?.name || "").toLowerCase() === INSTALLER_NAME
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

export function pickNewestModerationRelease(
  candidates: ModerationReleaseMeta[]
): ModerationReleaseMeta | null {
  let best: ModerationReleaseMeta | null = null;
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

function withTimeout(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  parent?.addEventListener("abort", onAbort, { once: true });
  ctrl.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
    { once: true }
  );
  return ctrl.signal;
}

async function fetchLatest(repo: string, signal?: AbortSignal): Promise<ModerationReleaseMeta | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    signal: withTimeout(signal, 5000),
    headers: GITHUB_FETCH_HEADERS,
  });
  if (!res.ok) return null;
  return metaFromReleaseJson(await res.json());
}

async function fetchList(repo: string, signal?: AbortSignal): Promise<ModerationReleaseMeta | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    signal: withTimeout(signal, 5000),
    headers: GITHUB_FETCH_HEADERS,
  });
  if (!res.ok) return null;
  const list = (await res.json()) as {
    tag_name?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  }[];
  if (!Array.isArray(list)) return null;
  return pickNewestModerationRelease(
    list.map((item) => metaFromReleaseJson(item)).filter((x): x is ModerationReleaseMeta => !!x)
  );
}

async function fetchManifest(repo: string, signal?: AbortSignal): Promise<ModerationReleaseMeta | null> {
  const res = await fetch(
    `https://raw.githubusercontent.com/${repo}/main/releases/moderation-release.json?t=${Date.now()}`,
    { signal: withTimeout(signal, 5000), headers: { "User-Agent": "Sloncord-Moderation" } }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as ModerationReleaseMeta;
  const version = normalizeVersion(String(data?.version || ""));
  const downloadUrl = String(data?.downloadUrl || "").trim();
  if (!version || !downloadUrl || data?.available === false) return null;
  return { ...data, version, downloadUrl, available: true };
}

export async function fetchModerationReleaseFromGithub(
  signal?: AbortSignal
): Promise<ModerationReleaseMeta | null> {
  for (const repo of reposToTry()) {
    const [fromManifest, fromLatest, fromList] = await Promise.all([
      fetchManifest(repo, signal).catch(() => null),
      fetchLatest(repo, signal).catch(() => null),
      fetchList(repo, signal).catch(() => null),
    ]);
    const candidates: ModerationReleaseMeta[] = [];
    if (fromManifest) candidates.push(fromManifest);
    if (fromLatest) candidates.push(fromLatest);
    if (fromList) candidates.push(fromList);
    const best = pickNewestModerationRelease(candidates);
    if (best) return best;
  }
  return null;
}
