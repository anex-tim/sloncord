/**
 * Сборка и выгрузка на Linux-сервер. Полный `npm run deploy` — apps/web/dist + (опционально) ASP.NET publish в remoteAppRoot
 * + SFU + restartService; `npm run deploy:desktop` (`--desktop-only`) — только downloads/, без API и без restartService.
 *
 * 1) Скопируйте deploy/sloncord-deploy.config.example.json → sloncord-deploy.config.json
 * 2) Укажите host, user, remoteWwwroot. Аутентификация: либо sshKey (файл ключа), либо sshPassword.
 *    Пароль хранится в открытом виде в JSON — только локально, файл в .gitignore. С rsync по паролю не работает (только SFTP).
 * 3) npm run deploy   (в корне репозитория, из Git Bash / PowerShell / cmd)
 *
 * Полный деплой (без --desktop-only): при `deployApi: true` и заданном `remoteAppRoot` выполняется
 * `dotnet publish Server/Server` (RID linux-x64 по умолчанию) и инкрементальная заливка в каталог приложения на сервере
 * (манифест `deploy/.last-api-publish-manifest.json`). Отключить: `"deployApi": false` или `SLONCORD_DEPLOY_SKIP_API=1`.
 * Перезапуск службы — всё ещё команда `restartService` в конце цепочки (после wwwroot, SFU и API).
 *
 * Сборка SloncordWinAudioHelper.exe: автоматически через npm lifecycle script `prebuild`
 * в apps/desktop/package.json перед `npm run build` десктопа и явным `npm run prebuild`
 * в цепочке `build:installer` / `build:dir`. Скрипт deploy-sloncord.cmd в корне только
 * вызывает `npm run deploy` после npm install.
 *
 * По умолчанию (без --with-clients): только `npm run build:web`, без Electron/NSIS;
 * `apps/web/dist/downloads` очищается перед заливкой (клиент — GitHub Releases).
 * С --with-clients: полная сборка desktop + moderation и заливка downloads/ на VPS (legacy).
 *
 * Полный деплой (без --desktop-only) после заливки wwwroot по умолчанию выгружает **Sfu/** на сервер
 * (remoteSfuRoot, см. конфиг), затем при необходимости `npm install --omit=dev` в каталоге SFU и
 * `systemctl restart sloncord-sfu` (restartSfuService). Отключить: `"deploySfu": false`.
 *
 * SFTP по умолчанию: локальный файл deploy/.last-dist-manifest.json (SHA-256 файлов после последнего успешного деплоя).
 * Отправляются только файлы, байты которых изменились с того деплоя (не «смотрим» сервер через stat).
 *
 * --no-build        только залить уже собранный apps/web/dist
 * --desktop-only    только каталог dist/downloads/ (установщик + desktop-release.json): без wipe wwwroot, без
 *                    restartService, сборка: npm run build:installer (NSIS + копия в dist без полного Vite)
 * --rsync           сначала попробовать rsync --delete (если есть в PATH; удобно из Git Bash)
 * --full-sftp       по SFTP отправить все файлы dist заново (игнорировать локальный манифест последнего деплоя)
 *                    (для --desktop-only: полностью залить только dist/downloads/ на сервер)
 *
 * В sloncord-deploy.config.json: restartService — полная shell-команда на сервере (или пусто).
 *   skipInstallerInDeploy: true — не заливать downloads/*.exe по SFTP (см. ниже), если установщик уже на сервере.
 *   deploySfu: false — не выгружать каталог Sfu и не перезапускать sloncord-sfu (по умолчанию SFU выгружается при полном деплое).
 *   remoteSfuRoot — каталог на сервере для SFU (по умолчанию /opt/sloncord/sfu).
 *   restartSfuService — команда перезапуска SFU после npm install (по умолчанию sudo -n systemctl restart sloncord-sfu; пустая строка — не перезапускать).
 *   apiServiceName — имя systemd unit API без .service (по умолчанию sloncord-api или из restartService).
 *   remoteDataDir — каталог данных (uploads), по умолчанию /data/sloncord.
 *   setupSystemdOnDeploy — true: после API/SFU выгрузки пишет unit-файлы, chown www-data, daemon-reload (по умолчанию true).
 *
 * Ускорение SFTP (переменные окружения, необязательно):
 *   SLONCORD_SFTP_PROMISE_LIMIT   — сколько файлов uploadDir шлёт параллельно (по умолчанию 24, было 10 в библиотеке).
 *   SLONCORD_FASTPUT_CONCURRENCY  — параллельные чтения в fastPut на файл (по умолчанию 96).
 *   SLONCORD_FASTPUT_CHUNK        — размер чанка в байтах (по умолчанию 65536).
 *   SLONCORD_SSH_NO_COMPRESS=1   — отключить zlib-сжатие на SSH (часто быстрее на гигабите, меньше CPU).
 *   SLONCORD_SSH_READY_TIMEOUT    — таймаут handshake мс (по умолчанию 45000).
 *   SLONCORD_DEPLOY_SKIP_INSTALLER=1 — то же, что skipInstallerInDeploy (не отправлять .exe из downloads/).
 *   SLONCORD_DEPLOY_SKIP_SFU=1 — не выгружать Sfu и не перезапускать sloncord-sfu при полном деплое.
 *   SLONCORD_DEPLOY_SKIP_API=1 — не собирать и не выгружать ASP.NET API (см. deployApi / remoteAppRoot).
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  createReadStream,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "ssh2";
import SftpClient from "ssh2-sftp-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const configPath = path.join(root, "deploy", "sloncord-deploy.config.json");
const examplePath = path.join(root, "deploy", "sloncord-deploy.config.example.json");

const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const preferRsync = args.includes("--rsync");
const fullSftp = args.includes("--full-sftp");
const desktopOnly = args.includes("--desktop-only");
/** По умолчанию на VPS только бэкенд + веб-UI; .exe — GitHub Releases. */
const withClients = args.includes("--with-clients");
const backendOnly = !desktopOnly && !withClients;

/** Локальный снимок SHA-256 после последнего успешного деплоя (не коммитится). */
const distManifestPath = path.join(root, "deploy", ".last-dist-manifest.json");
/** Манифест для инкрементальной заливки `dotnet publish` ASP.NET (не коммитится). */
const apiManifestPath = path.join(root, "deploy", ".last-api-publish-manifest.json");

/**
 * @param {number} bytes
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KiB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MiB`;
  return `${(mb / 1024).toFixed(1)} GiB`;
}

/**
 * @param {import('ssh2').ConnectConfig} common
 */
function sshEndpointDisplay(common) {
  const host = common.host ?? "?";
  const port = common.port != null ? Number(common.port) : 22;
  const user = common.username ?? "?";
  return `${user}@${host}:${port}`;
}

/**
 * @param {string} name
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getFastPutOptions() {
  return {
    concurrency: envInt("SLONCORD_FASTPUT_CONCURRENCY", 96, 8, 512),
    chunkSize: envInt("SLONCORD_FASTPUT_CHUNK", 65536, 4096, 2 * 1024 * 1024),
  };
}

/**
 * @param {*} sftp
 * @param {string} abs
 * @param {string} remotePath
 * @param {string} rel
 */
async function sftpUploadOneFast(sftp, abs, remotePath, rel) {
  try {
    await sftp.fastPut(abs, remotePath, getFastPutOptions());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.warn(
      `   [SFTP] fastPut недоступен для ${rel} (${msg.slice(0, 140)}) — повтор через put`
    );
    await sftp.put(abs, remotePath);
  }
}

/**
 * Установщик NSIS в каталоге downloads (имя любое, расширение .exe).
 *
 * @param {string} rel
 */
function isDownloadsInstallerExe(rel) {
  const p = String(rel).replace(/\\/g, "/");
  return /^downloads\/[^/]+\.exe$/i.test(p);
}

/** Клиентские артефакты (GitHub), не заливаем на VPS при backend-only деплое. */
function isClientDownloadArtifact(rel) {
  const p = String(rel).replace(/\\/g, "/");
  return p.startsWith("downloads/") && p !== "downloads/.gitkeep";
}

/** То же для путей внутри `dotnet publish` (wwwroot/downloads/…). */
function isApiPublishClientDownload(rel) {
  const p = String(rel).replace(/\\/g, "/");
  return p.startsWith("wwwroot/downloads/") && p !== "wwwroot/downloads/.gitkeep";
}

/**
 * @param {Record<string, unknown>} config
 */
function shouldSkipInstallerDeploy(config) {
  if (
    process.env.SLONCORD_DEPLOY_SKIP_INSTALLER === "1" ||
    process.env.SLONCORD_DEPLOY_SKIP_INSTALLER === "true"
  ) {
    return true;
  }
  return config.skipInstallerInDeploy === true;
}

/**
 * @param {{ abs: string; rel: string; hash: string }[]} entries
 * @param {Record<string, number>} sizeByRel
 */
function sortEntriesBySizeAsc(entries, sizeByRel) {
  return [...entries].sort((a, b) => {
    const sa = sizeByRel[a.rel] ?? 0;
    const sb = sizeByRel[b.rel] ?? 0;
    return sa - sb;
  });
}

/**
 * @param {*} sftp
 * @param {string} abs
 * @param {string} remotePath
 * @param {string} rel
 * @param {number} sz
 */
async function sftpUploadOneFastWithPulse(sftp, abs, remotePath, rel, sz) {
  const large = sz >= 16 * 1024 * 1024;
  if (!large) {
    await sftpUploadOneFast(sftp, abs, remotePath, rel);
    return;
  }
  let iv = null;
  const t0 = Date.now();
  try {
    iv = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      // eslint-disable-next-line no-console
      console.log(
        `   [SFTP] … ещё заливается ${rel} (${formatBytes(sz)}), прошло ${sec} с — это нормально для большого файла`
      );
    }, 12000);
    await sftpUploadOneFast(sftp, abs, remotePath, rel);
  } finally {
    if (iv) clearInterval(iv);
  }
}

function logSftpTuningSummary() {
  const fp = getFastPutOptions();
  const pl = envInt("SLONCORD_SFTP_PROMISE_LIMIT", 24, 1, 64);
  const noCompress =
    process.env.SLONCORD_SSH_NO_COMPRESS === "1" ||
    process.env.SLONCORD_SSH_NO_COMPRESS === "true";
  // eslint-disable-next-line no-console
  console.log(
    `   Параметры скорости: uploadDir параллельных файлов=${pl}, fastPut concurrency=${fp.concurrency}, chunk=${fp.chunkSize} B, SSH compress=${noCompress ? "none" : "negotiated"}`
  );
}

/**
 * @param {string} absPath
 * @returns {Promise<string>}
 */
function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(absPath);
    rs.on("error", reject);
    rs.on("data", (chunk) => {
      hash.update(chunk);
    });
    rs.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

/**
 * @param {string} manifestPath
 * @returns {Record<string, string>}
 */
function loadManifestAt(manifestPath) {
  try {
    if (!existsSync(manifestPath)) return {};
    const j = JSON.parse(readFileSync(manifestPath, "utf8"));
    const files = j?.files;
    if (!files || typeof files !== "object") return {};
    return /** @type {Record<string, string>} */ (files);
  } catch {
    return {};
  }
}

/**
 * @returns {Record<string, string>}
 */
function loadPreviousManifestHashes() {
  return loadManifestAt(distManifestPath);
}

/**
 * @param {string} manifestPath
 * @param {Record<string, string>} files relPosix -> sha256hex
 */
function saveManifestAt(manifestPath, files) {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/**
 * @param {Record<string, string>} files relPosix -> sha256hex
 */
function saveDistManifest(files) {
  saveManifestAt(distManifestPath, files);
}

/**
 * Хеширует текущий dist (параллельно пачками).
 *
 * @param {{ abs: string; rel: string; size: number }[]} fileList
 * @returns {Promise<{ entries: { abs: string; rel: string; hash: string }[]; record: Record<string, string> }>}
 */
async function hashDistFiles(fileList, label = "dist", options = {}) {
  const verbose = options.verbose !== false;
  const total = fileList.length;
  if (total === 0) {
    return { entries: [], record: {} };
  }
  if (verbose) {
    // eslint-disable-next-line no-console
    console.log(`→ SHA-256 (${label}): подсчёт контрольных сумм для ${total} файл(ов)…`);
  }

  const concurrency = 16;
  /** @type {{ abs: string; rel: string; hash: string }[]} */
  const entries = new Array(fileList.length);
  let next = 0;
  let finished = 0;

  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= fileList.length) return;
      const { abs, rel, size } = fileList[i];
      const hash = await sha256File(abs);
      entries[i] = { abs, rel, hash };
      finished += 1;
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log(`   [SHA-256 ${finished}/${total}] ${rel} (${formatBytes(size)})`);
      }
    }
  }

  const n = Math.min(concurrency, Math.max(1, fileList.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  if (verbose) {
    // eslint-disable-next-line no-console
    console.log(`   готово: хеширование завершено (${total} файл(ов))\n`);
  }

  /** @type {Record<string, string>} */
  const record = {};
  for (const e of entries) {
    if (e) record[e.rel] = e.hash;
  }
  return { entries, record };
}

/**
 * После rsync / полной заливки — обновить манифест, чтобы следующий SFTP не пересылал лишнее.
 *
 * @param {string} localDir
 */
async function refreshManifestFromDist(localDir) {
  const files = [];
  collectLocalFiles(localDir, localDir, files);
  // eslint-disable-next-line no-console
  console.log(
    `→ Обновление локального манифеста деплоя (${files.length} файл(ов), без подробного лога SHA)…`
  );
  const { record } = await hashDistFiles(files, "apps/web/dist", { verbose: false });
  saveDistManifest(record);
  // eslint-disable-next-line no-console
  console.log("   манифест записан в deploy/.last-dist-manifest.json\n");
}

/**
 * @param {string} p
 */
function assertRemotePath(p) {
  const t = String(p).trim();
  if (!t.startsWith("/") || t.includes("..") || t.includes("\n")) {
    throw new Error(`remoteWwwroot сомнительный путь, отклоняю: ${p}`);
  }
  if (!t.endsWith("wwwroot") && !t.includes("/wwwroot")) {
    // eslint-disable-next-line no-console
    console.warn("Предупреждение: remoteWwwroot обычно заканчивается на .../wwwroot");
  }
  return t;
}

/**
 * Абсолютный путь на Linux-сервере (SFU и т.п.).
 * @param {string} p
 * @param {string} label — для текста ошибки
 */
function assertSafeRemoteUnixPath(p, label) {
  const t = String(p).trim();
  if (!t.startsWith("/") || t.includes("..") || t.includes("\n")) {
    throw new Error(`${label}: сомнительный путь, отклоняю: ${p}`);
  }
  return t;
}

/**
 * @param {Record<string, unknown>} config
 */
function getPasswordFromConfig(config) {
  const p = config.sshPassword != null ? config.sshPassword : config.password;
  if (p == null) return "";
  return String(p);
}

/**
 * @param {Record<string, unknown>} config
 */
function usesPasswordAuth(config) {
  return getPasswordFromConfig(config).trim().length > 0;
}

/**
 * @param {import('ssh2').ConnectConfig} common
 */
function sshConnectOptions(common) {
  const promiseLimit = envInt("SLONCORD_SFTP_PROMISE_LIMIT", 24, 1, 64);
  const readyTimeout = envInt("SLONCORD_SSH_READY_TIMEOUT", 45000, 5000, 600000);
  const noCompress =
    process.env.SLONCORD_SSH_NO_COMPRESS === "1" ||
    process.env.SLONCORD_SSH_NO_COMPRESS === "true";

  return {
    ...common,
    tryKeyboard: Boolean(common.password),
    readyTimeout,
    promiseLimit,
    ...(noCompress
      ? {
          algorithms: {
            compress: ["none"],
          },
        }
      : {}),
  };
}

function loadConfig() {
  if (!existsSync(configPath)) {
    // eslint-disable-next-line no-console
    console.error(
      `Нет ${configPath}\n` +
        `Скопируйте: ${examplePath} → sloncord-deploy.config.json (файл в .gitignore).`
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

/**
 * @param {string} raw
 */
function looksLikeSshPrivateKeyPath(raw) {
  const t = String(raw).trim();
  if (t.length < 2) return false;
  if (/^~[\\/]/.test(t) || t.startsWith("~/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true; // C:\…
  if (t.includes("/") || t.includes("\\")) return true;
  if (/^id_(rsa|ed25519|ecdsa)$/i.test(t) || /^[\w-]+\.pem$/i.test(t)) return true;
  return false;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function expandUserPath(raw) {
  const t = String(raw).trim();
  if (t === "~" || t === `~${path.sep}`) return homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    return path.join(homedir(), t.slice(2));
  }
  return t;
}

/**
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function resolveSshKeyPath(config) {
  const raw = expandUserPath(String(config.sshKey ?? "").trim());
  if (!raw) {
    throw new Error(
      "Укажите в deploy/sloncord-deploy.config.json либо sshPassword (пароль SSH), " +
        "либо sshKey — путь к файлу приватного ключа (например C:\\\\Users\\\\Вы\\\\.ssh\\\\id_ed25519)."
    );
  }
  const keyPath = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  if (existsSync(keyPath)) {
    return keyPath;
  }
  if (!looksLikeSshPrivateKeyPath(String(config.sshKey).trim())) {
    throw new Error(
      "Поле sshKey не похоже на путь к файлу ключа SSH.\n" +
        "Укажите путь к приватному ключу, например: C:\\\\Users\\\\Artyom\\\\.ssh\\\\id_ed25519\n" +
        "Создать: ssh-keygen -t ed25519 -C \"ваш@email\" — затем публичный ключ добавьте в ~/.ssh/authorized_keys на сервере.\n" +
        "Серверный пароль сюда не подставляйте — в поле ожидается только путь к файлу без пароля (или используйте ssh-agent)."
    );
  }
  throw new Error(
    `Файл ключа не найден: ${keyPath}\n` +
      "Проверьте путь и что файл существует. Относительные пути считаются от корня репозитория."
  );
}

/**
 * @param {Record<string, unknown>} config
 * @returns {import('ssh2').ConnectConfig}
 */
function getConnectConfig(config) {
  const pwd = getPasswordFromConfig(config).trim();
  if (pwd) {
    return {
      host: String(config.host),
      port: Number(config.port) || 22,
      username: String(config.user),
      password: pwd,
    };
  }
  const privateKey = readFileSync(resolveSshKeyPath(config));
  return {
    host: String(config.host),
    port: Number(config.port) || 22,
    username: String(config.user),
    privateKey,
  };
}

/**
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} command
 */
function execSshCommand(common, command) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-console
    console.log(`   SSH: подключение к ${sshEndpointDisplay(common)}…`);
    const conn = new Client();
    conn
      .on("ready", () => {
        // eslint-disable-next-line no-console
        console.log("   SSH: сессия установлена, выполняется команда…");
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          let errBuf = "";
          stream.stderr.on("data", (c) => {
            errBuf += c;
            process.stderr.write(c);
          });
          stream.on("data", (c) => {
            process.stdout.write(c);
          });
          stream.on("close", (code) => {
            conn.end();
            if (code === 0) return resolve();
            return reject(new Error(`SSH exit ${code} ${errBuf}`.trim()));
          });
        });
      })
      .on("error", (e) => {
        try {
          conn.end();
        } catch { /* */ }
        reject(e);
      })
      .connect(sshConnectOptions(common));
  });
}

/**
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} destPath
 * @param {string} content
 * @param {string} [mode]
 */
async function sshWriteRootFile(common, destPath, content, mode = "0644") {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const safeDest = String(destPath).replace(/'/g, "'\\''");
  const sh = [
    "set -e",
    'TMP="$(mktemp)"',
    `echo '${b64}' | base64 -d > "$TMP"`,
    `install -m ${mode} "$TMP" '${safeDest}'`,
    'rm -f "$TMP"',
  ].join("\n");
  await execSshCommand(common, sh);
}

/**
 * @param {Record<string, unknown>} config
 */
function resolveApiServiceName(config) {
  const explicit = String(config.apiServiceName ?? "").trim();
  if (explicit) return explicit.replace(/\.service$/i, "");
  const restart = String(config.restartService ?? "");
  const m = restart.match(/systemctl\s+(?:restart|reload|start|stop)\s+([a-zA-Z0-9@._-]+)/);
  if (m?.[1]) return m[1].replace(/\.service$/i, "");
  return "sloncord";
}

/**
 * @param {{ appRoot: string; dataDir: string; description?: string }} opts
 */
function buildApiSystemdUnit(opts) {
  const appRoot = opts.appRoot;
  const dataDir = opts.dataDir;
  const description = opts.description || "Sloncord API";
  return `[Unit]
Description=${description}
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=${appRoot}
ExecStart=/usr/bin/dotnet ${appRoot}/Server.dll
Restart=always
RestartSec=3
KillMode=control-group
TimeoutStopSec=15

EnvironmentFile=-/etc/sloncord/sloncord.env
Environment=ASPNETCORE_URLS=http://127.0.0.1:5000
Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=DOTNET_PRINT_TELEMETRY_MESSAGE=false

User=www-data
Group=www-data

ReadWritePaths=${appRoot} ${dataDir}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * @param {{ sfuRoot: string }} opts
 */
function buildSfuSystemdUnit(opts) {
  const sfuRoot = opts.sfuRoot;
  return `[Unit]
Description=Sloncord SFU (mediasoup)
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${sfuRoot}
EnvironmentFile=-/etc/sloncord/sloncord.env
Environment=SLONCORD_SFU_PORT=3333
Environment=SLONCORD_SFU_WS_PATH=/ws/sfu
Environment=SLONCORD_SFU_RTC_MIN_PORT=10000
Environment=SLONCORD_SFU_RTC_MAX_PORT=20000
Restart=always
RestartSec=2
ExecStart=/usr/bin/node ${sfuRoot}/src/index.js

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Права + systemd unit API (исправляет CHDIR/Permission denied и пути вроде /root/sloncord).
 *
 * @param {Record<string, unknown>} config
 * @param {import('ssh2').ConnectConfig} common
 */
async function sshEnsureApiRuntime(config, common) {
  const remoteAppRoot = assertSafeRemoteUnixPath(
    String(config.remoteAppRoot ?? "/opt/sloncord/app").trim(),
    "remoteAppRoot"
  );
  const remoteDataDir = assertSafeRemoteUnixPath(
    String(config.remoteDataDir ?? "/data/sloncord").trim(),
    "remoteDataDir"
  );
  const serviceName = resolveApiServiceName(config);
  const unitPath = `/etc/systemd/system/${serviceName}.service`;
  const parentDir = posixDirname(remoteAppRoot) || "/opt/sloncord";

  // eslint-disable-next-line no-console
  console.log(
    `→ SSH: каталог API ${remoteAppRoot}, права www-data, unit ${unitPath}…\n`
  );

  const unit = buildApiSystemdUnit({
    appRoot: remoteAppRoot,
    dataDir: remoteDataDir,
    description: serviceName === "sloncord-api" ? "Sloncord API" : "Sloncord (ASP.NET Core + static UI)",
  });
  await sshWriteRootFile(common, unitPath, unit, "0644");

  const sh = [
    "set -e",
    `install -d -m 0755 "${parentDir}"`,
    `install -d -m 0755 "${remoteAppRoot}"`,
    `install -d -m 0755 /etc/sloncord`,
    `install -d -m 0755 "${remoteDataDir}"`,
    `chown -R www-data:www-data "${parentDir}"`,
    `chown -R www-data:www-data "${remoteDataDir}"`,
    `chmod 755 "${parentDir}" "${remoteAppRoot}" "${remoteDataDir}"`,
    "systemctl daemon-reload",
    `systemctl enable ${serviceName}.service`,
    `systemctl reset-failed ${serviceName}.service || true`,
  ].join("\n");
  await execSshCommand(common, sh);
  await ensureRootLoginEnv(config, common);
  // eslint-disable-next-line no-console
  console.log("→ SSH: API runtime (права + systemd) настроен.\n");
}

/**
 * Корневой логин только в /etc/sloncord/sloncord.env на сервере, не в git.
 * @param {Record<string, unknown>} config
 * @param {import('ssh2').ConnectConfig} common
 */
async function ensureRootLoginEnv(config, common) {
  const rootLogin = String(config.rootLogin ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(rootLogin)) {
    console.log("→ SSH: rootLogin в deploy-конфиге пуст, /etc/sloncord/sloncord.env не меняю.\n");
    return;
  }
  const b64 = Buffer.from(`SLONCORD_ROOT_LOGIN=${rootLogin}\n`, "utf8").toString("base64");
  const sh = [
    "set -e",
    "install -d -m 0755 /etc/sloncord",
    "touch /etc/sloncord/sloncord.env",
    "chmod 600 /etc/sloncord/sloncord.env",
    'TMP="$(mktemp)"',
    "grep -v '^SLONCORD_ROOT_LOGIN=' /etc/sloncord/sloncord.env > \"$TMP\" || true",
    `echo '${b64}' | base64 -d >> "$TMP"`,
    'install -m 0600 "$TMP" /etc/sloncord/sloncord.env',
    'rm -f "$TMP"',
  ].join("\n");
  console.log("→ SSH: корневой логин записан в окружение сервиса (значение не печатается).\n");
  await execSshCommand(common, sh);
}

/**
 * @param {Record<string, unknown>} config
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} remoteSfuRoot
 */
async function sshEnsureSfuRuntime(config, common, remoteSfuRoot) {
  if (config.setupSystemdOnDeploy === false) {
    const sh = [
      "set -e",
      `install -d -m 0755 "${remoteSfuRoot}"`,
      `chown -R www-data:www-data "${remoteSfuRoot}"`,
    ].join("\n");
    await execSshCommand(common, sh);
    return;
  }

  const unitPath = "/etc/systemd/system/sloncord-sfu.service";
  // eslint-disable-next-line no-console
  console.log(`→ SSH: SFU ${remoteSfuRoot}, unit ${unitPath}…\n`);
  await sshWriteRootFile(common, unitPath, buildSfuSystemdUnit({ sfuRoot: remoteSfuRoot }), "0644");
  const sh = [
    "set -e",
    `install -d -m 0755 "${remoteSfuRoot}"`,
    `chown -R www-data:www-data "${remoteSfuRoot}"`,
    "systemctl daemon-reload",
    "systemctl enable sloncord-sfu.service",
    "systemctl reset-failed sloncord-sfu.service || true",
  ].join("\n");
  await execSshCommand(common, sh);
  // eslint-disable-next-line no-console
  console.log("→ SSH: SFU runtime настроен.\n");
}

/**
 * @param {Record<string, unknown>} config
 */
function defaultRestartServiceCommand(config) {
  const api = resolveApiServiceName(config);
  return `systemctl daemon-reload && systemctl restart ${api}.service`;
}

/**
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} remoteWwwroot
 */
async function wipeRemoteWwwroot(common, remoteWwwroot) {
  // Очищаем содержимое, не трогая права на саму папку wwwroot (как у Kestrel)
  const safe = String(remoteWwwroot).replace(/"/g, '\\"');
  const sh = `if [ -d "${safe}" ]; then find "${safe}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +; fi`;
  // eslint-disable-next-line no-console
  console.log(
    `→ SSH: очистка каталога на сервере ${sshEndpointDisplay(common)}\n` +
      `   remote: ${remoteWwwroot}\n`
  );
  await execSshCommand(common, sh);
  // eslint-disable-next-line no-console
  console.log("   SSH: команда очистки завершена.\n");
}

/**
 * @param {string} remoteRoot
 * @param {string} relPosix
 */
function remoteFilePath(remoteRoot, relPosix) {
  const r = String(remoteRoot).replace(/\/+$/, "");
  const p = String(relPosix).replace(/^\/+/, "").replace(/\\/g, "/");
  return `${r}/${p}`;
}

/**
 * @param {string} remotePath
 */
function posixDirname(remotePath) {
  const p = String(remotePath).replace(/\\/g, "/");
  const i = p.lastIndexOf("/");
  if (i <= 0) return "";
  return p.slice(0, i);
}

/**
 * @param {string} dirAbs
 * @param {string} rootAbs
 * @param {{ abs: string; rel: string; size: number }[]} out
 */
function collectLocalFiles(dirAbs, rootAbs, out) {
  for (const name of readdirSync(dirAbs)) {
    const abs = path.join(dirAbs, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      collectLocalFiles(abs, rootAbs, out);
    } else {
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      out.push({ abs, rel, size: st.size });
    }
  }
}

/**
 * Файлы SFU для деплоя: без локального node_modules (на сервере ставится npm install).
 * @param {string} dirAbs
 * @param {string} rootAbs
 * @param {{ abs: string; rel: string; size: number }[]} out
 */
function collectSfuDeployFiles(dirAbs, rootAbs, out) {
  for (const name of readdirSync(dirAbs)) {
    if (name === "node_modules") continue;
    const abs = path.join(dirAbs, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      collectSfuDeployFiles(abs, rootAbs, out);
    } else {
      const rel = path.relative(rootAbs, abs).split(path.sep).join("/");
      out.push({ abs, rel, size: st.size });
    }
  }
}

/**
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} localSfuRoot
 * @param {string} remoteSfuRoot
 */
async function sftpUploadSfuTree(common, localSfuRoot, remoteSfuRoot) {
  const files = [];
  collectSfuDeployFiles(localSfuRoot, localSfuRoot, files);
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("→ SFU: в каталоге Sfu нет файлов для выгрузки — пропуск.\n");
    return;
  }

  const sizeByRel = {};
  for (const f of files) sizeByRel[f.rel] = f.size;
  const queue = sortEntriesBySizeAsc(
    files.map((f) => ({ abs: f.abs, rel: f.rel, hash: "" })),
    sizeByRel
  );

  // eslint-disable-next-line no-console
  console.log(
    `→ SFTP: выгрузка SFU (${files.length} файл(ов)) → ${remoteSfuRoot}\n` +
      `   (локально: ${localSfuRoot})\n`
  );

  const sftp = new SftpClient();
  let idx = 0;
  const uploadTotal = queue.length;
  try {
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: подключение к ${sshEndpointDisplay(common)}…`);
    await sftp.connect(sshConnectOptions(common));
    logSftpTuningSummary();
    // eslint-disable-next-line no-console
    console.log(`   SFTP: соединение установлено. Загрузка SFU ${uploadTotal} файл(ов)…\n`);

    for (const { abs, rel } of queue) {
      idx += 1;
      const remotePath = remoteFilePath(remoteSfuRoot, rel);
      const sz = sizeByRel[rel] ?? statSync(abs).size;
      // eslint-disable-next-line no-console
      console.log(
        `   [SFU ${idx}/${uploadTotal}] отправка ${rel} (${formatBytes(sz)}) → ${remotePath}`
      );
      const t0 = Date.now();
      const dir = posixDirname(remotePath);
      if (dir) await sftp.mkdir(dir, true);
      await sftpUploadOneFastWithPulse(sftp, abs, remotePath, rel, sz);
      const ms = Date.now() - t0;
      const mibPerS = ms > 0 && sz > 0 ? ((sz / 1024 / 1024) / (ms / 1000)).toFixed(2) : "?";
      // eslint-disable-next-line no-console
      console.log(`   [SFU ${idx}/${uploadTotal}] готово за ${ms} мс (~${mibPerS} МиБ/с)`);
    }
  } finally {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
  // eslint-disable-next-line no-console
  console.log("→ SFU: файлы на сервере обновлены.\n");
}

/**
 * Как в deploy/install.sh: npm install только если нет node_modules или изменился package.json.
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} remoteSfuRoot
 * @param {string} restartCmd — команда перезапуска unit (или пусто)
 */
async function sshSfuNpmInstallIfNeededAndRestart(common, remoteSfuRoot, restartCmd) {
  const d = String(remoteSfuRoot).replace(/"/g, '\\"');
  const lines = [
    "set -e",
    `cd "${d}"`,
    "NEED_NPM=0",
    "if [ ! -d node_modules ]; then NEED_NPM=1; fi",
    "if [ -f package.json ] && [ -f node_modules/.package.json ]; then",
    "  if ! cmp -s package.json node_modules/.package.json; then NEED_NPM=1; fi",
    "else",
    "  NEED_NPM=1",
    "fi",
    'if [ "$NEED_NPM" = 1 ]; then npm install --omit=dev; cp -f package.json node_modules/.package.json || true; fi',
  ];
  const r = String(restartCmd ?? "").trim();
  if (r) lines.push(r);
  const sh = lines.join("\n");
  // eslint-disable-next-line no-console
  console.log("→ SSH: на сервере npm install для SFU (при необходимости) и перезапуск службы…\n");
  await execSshCommand(common, sh);
  // eslint-disable-next-line no-console
  console.log("→ SSH: шаг SFU на сервере завершён.\n");
}

/**
 * @param {Record<string, unknown>} config
 * @param {import('ssh2').ConnectConfig} common
 */
async function maybeDeploySfu(config, common) {
  if (
    process.env.SLONCORD_DEPLOY_SKIP_SFU === "1" ||
    process.env.SLONCORD_DEPLOY_SKIP_SFU === "true"
  ) {
    // eslint-disable-next-line no-console
    console.log("→ SFU: переменная SLONCORD_DEPLOY_SKIP_SFU=1 — выгрузка SFU пропущена.\n");
    return;
  }
  if (config.deploySfu === false) {
    // eslint-disable-next-line no-console
    console.log("→ SFU: в конфиге deploySfu=false — выгрузка SFU пропущена.\n");
    return;
  }

  const localSfu = path.join(root, "Sfu");
  if (!existsSync(path.join(localSfu, "package.json")) || !existsSync(path.join(localSfu, "src", "index.js"))) {
    // eslint-disable-next-line no-console
    console.warn(
      "→ SFU: локально нет Sfu/package.json или Sfu/src/index.js — выгрузка SFU пропущена.\n"
    );
    return;
  }

  const remoteSfuRoot = assertSafeRemoteUnixPath(
    String(config.remoteSfuRoot != null && String(config.remoteSfuRoot).trim()
      ? config.remoteSfuRoot
      : "/opt/sloncord/sfu"),
    "remoteSfuRoot"
  );

  await sftpUploadSfuTree(common, localSfu, remoteSfuRoot);

  try {
    await sshEnsureSfuRuntime(config, common, remoteSfuRoot);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "SFU: не удалось настроить права/systemd на сервере.",
      e instanceof Error ? e.message : e
    );
  }

  let restartSfu = "";
  if (config.restartSfuService === false || config.restartSfuService === null) {
    restartSfu = "";
  } else if (typeof config.restartSfuService === "string") {
    restartSfu = String(config.restartSfuService).trim();
  } else {
    restartSfu = "sudo -n systemctl restart sloncord-sfu";
  }

  if (restartSfu) {
    try {
      await sshSfuNpmInstallIfNeededAndRestart(common, remoteSfuRoot, restartSfu);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "SFU: команда на сервере не выполнена (права, sudo, npm). Обновите SFU вручную.",
        e instanceof Error ? e.message : e
      );
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("→ SFU: restartSfuService отключён — перезапуск службы пропущен (файлы уже залиты).\n");
  }
}

/**
 * @returns {string} путь к dotnet.exe
 */
function resolveDotnetExe() {
  const fromEnv = String(process.env.SLONCORD_DOTNET_PATH || "").trim();
  if (fromEnv) {
    if (existsSync(fromEnv)) return fromEnv;
    const withExe = fromEnv.toLowerCase().endsWith(".exe") ? fromEnv : path.join(fromEnv, "dotnet.exe");
    if (existsSync(withExe)) return withExe;
  }
  const where = spawnSync("where", ["dotnet"], { cwd: root, stdio: "pipe", shell: true, encoding: "utf8" });
  if (where.status === 0 && where.stdout) {
    const first = String(where.stdout)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && existsSync(first)) return first;
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  for (const c of [
    path.join(pf, "dotnet", "dotnet.exe"),
    path.join(pfx86, "dotnet", "dotnet.exe"),
  ]) {
    if (existsSync(c)) return c;
  }
  return "dotnet";
}

/**
 * @param {string} dotnetExe
 * @returns {string} версия SDK
 */
function assertDotnetSdkAvailable(dotnetExe) {
  const ver = spawnSync(dotnetExe, ["--version"], { cwd: root, stdio: "pipe", encoding: "utf8" });
  const v = String(ver.stdout || "").trim();
  if (ver.status === 0 && v) return v;
  const list = spawnSync(dotnetExe, ["--list-sdks"], { cwd: root, stdio: "pipe", encoding: "utf8" });
  const sdks = String(list.stdout || "").trim();
  if (sdks) {
    const line = sdks.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
    return line.split(/\s+/)[0] || "SDK";
  }
  const hint =
    existsSync(dotnetExe) || dotnetExe !== "dotnet"
      ? "На этом ПК найден dotnet.exe, но не установлен .NET SDK (только Runtime недостаточен для publish)."
      : "Команда dotnet не найдена в PATH.";
  throw new Error(
    `${hint}\n` +
      "Установите .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0\n" +
      "PowerShell (админ не обязателен): winget install Microsoft.DotNet.SDK.8\n" +
      "После установки закройте и снова откройте терминал, затем deploy-sloncord.cmd.\n" +
      "Или укажите путь: set SLONCORD_DOTNET_PATH=C:\\Program Files\\dotnet\\dotnet.exe"
  );
}

/**
 * @returns {string} абсолютный путь к каталогу publish (содержимое — то, что заливаем на сервер)
 */
function runDotnetPublishServer() {
  const csproj = path.join(root, "Server", "Server", "Server.csproj");
  if (!existsSync(csproj)) {
    throw new Error(`Не найден проект API: ${csproj}`);
  }
  const dotnetExe = resolveDotnetExe();
  const sdkVersion = assertDotnetSdkAvailable(dotnetExe);
  const outDir = path.join(root, "deploy", ".server-publish");
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const rid = String(process.env.SLONCORD_DEPLOY_API_RID || "linux-x64").trim() || "linux-x64";
  // eslint-disable-next-line no-console
  console.log(`→ Сборка: dotnet publish API (${sdkVersion}) → ${outDir} (RID ${rid})…\n`);
  const r = spawnSync(
    dotnetExe,
    [
      "publish",
      csproj,
      "-c",
      "Release",
      "-o",
      outDir,
      "--runtime",
      rid,
      "--self-contained",
      "false",
      "/p:UseAppHost=false",
    ],
    { cwd: root, stdio: "inherit" }
  );
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
  const dll = path.join(outDir, "Server.dll");
  if (!existsSync(dll)) {
    throw new Error(`После publish не найден ${dll}`);
  }
  return outDir;
}

/**
 * Инкрементальная заливка каталога `dotnet publish` (отдельный манифест от wwwroot).
 *
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} localPublishDir
 * @param {string} remoteAppRoot
 * @param {{ forceAll?: boolean; skipClientDownloads?: boolean }} [opts]
 */
async function sftpUploadServerPublishIncremental(common, localPublishDir, remoteAppRoot, opts = {}) {
  const forceAll = opts.forceAll === true;
  const skipClientDownloads = opts.skipClientDownloads === true && !forceAll;
  const files = [];
  collectLocalFiles(localPublishDir, localPublishDir, files);
  /** Не затираем production-конфиг на сервере шаблоном из publish. */
  const apiConfigSkip = new Set([
    "appsettings.json",
    "appsettings.Development.json",
    "appsettings.Production.json",
  ]);
  let filtered = files.filter((f) => !apiConfigSkip.has(f.rel.replace(/\\/g, "/")));
  if (files.length !== filtered.length) {
    // eslint-disable-next-line no-console
    console.log(
      `→ API: appsettings*.json не заливаются (${files.length - filtered.length} файл(ов)) — конфиг остаётся на сервере.\n`
    );
  }
  if (skipClientDownloads) {
    const before = filtered.length;
    filtered = filtered.filter((f) => !isApiPublishClientDownload(f.rel));
    const n = before - filtered.length;
    if (n > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `→ API: wwwroot/downloads/* не заливаются (${n} файл(ов)) — установщики на GitHub Releases.\n`
      );
    }
  }
  if (filtered.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("→ API: в каталоге publish нет файлов — пропуск SFTP.\n");
    return;
  }

  const { entries, record } = await hashDistFiles(filtered, "Server/publish", { verbose: false });
  const prev = loadManifestAt(apiManifestPath);
  let queue = forceAll ? entries : entries.filter((e) => prev[e.rel] !== e.hash);
  const skippedUnchanged = entries.length - queue.length;

  /** @type {Record<string, number>} */
  const sizeByRel = {};
  for (const f of filtered) {
    sizeByRel[f.rel] = f.size;
  }
  queue = sortEntriesBySizeAsc(queue, sizeByRel);

  // eslint-disable-next-line no-console
  console.log(
    `→ SFTP (API publish): всего ${entries.length} файл(ов), к отправке ${queue.length}, без изменений ${skippedUnchanged}.\n`
  );

  if (queue.length === 0) {
    saveManifestAt(apiManifestPath, record);
    // eslint-disable-next-line no-console
    console.log("→ SFTP (API): отправлять нечего, манифест обновлён.\n");
    return;
  }

  const sftp = new SftpClient();
  let uploaded = 0;
  const uploadTotal = queue.length;
  try {
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: подключение к ${sshEndpointDisplay(common)}…`);
    await sftp.connect(sshConnectOptions(common));
    logSftpTuningSummary();
    // eslint-disable-next-line no-console
    console.log(`   SFTP: соединение установлено. Загрузка API ${uploadTotal} файл(ов)…\n`);

    let idx = 0;
    for (const { abs, rel } of queue) {
      idx += 1;
      const remotePath = remoteFilePath(remoteAppRoot, rel);
      const sz = sizeByRel[rel] ?? statSync(abs).size;
      // eslint-disable-next-line no-console
      console.log(
        `   [API ${idx}/${uploadTotal}] отправка ${rel} (${formatBytes(sz)}) → ${remotePath}`
      );
      const t0 = Date.now();
      const dir = posixDirname(remotePath);
      if (dir) {
        await sftp.mkdir(dir, true);
      }
      await sftpUploadOneFastWithPulse(sftp, abs, remotePath, rel, sz);
      uploaded += 1;
      const ms = Date.now() - t0;
      const mibPerS =
        ms > 0 && sz > 0 ? ((sz / 1024 / 1024) / (ms / 1000)).toFixed(2) : "?";
      // eslint-disable-next-line no-console
      console.log(`   [API ${idx}/${uploadTotal}] готово за ${ms} мс (~${mibPerS} МиБ/с)`);
    }
    saveManifestAt(apiManifestPath, record);
  } finally {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
  // eslint-disable-next-line no-console
  console.log(`→ SFTP (API): завершено, отправлено файлов: ${uploaded}\n`);
}

/**
 * @param {Record<string, unknown>} config
 * @param {import('ssh2').ConnectConfig} common
 * @param {{ forceAll?: boolean; skipClientDownloads?: boolean }} [opts]
 */
async function maybeDeployApi(config, common, opts = {}) {
  if (
    process.env.SLONCORD_DEPLOY_SKIP_API === "1" ||
    process.env.SLONCORD_DEPLOY_SKIP_API === "true"
  ) {
    // eslint-disable-next-line no-console
    console.log("→ API: SLONCORD_DEPLOY_SKIP_API=1 — публикация ASP.NET пропущена.\n");
    return;
  }
  if (config.deployApi === false) {
    // eslint-disable-next-line no-console
    console.log("→ API: в конфиге deployApi=false — публикация ASP.NET пропущена.\n");
    return;
  }
  if (config.deployApi !== true) {
    // eslint-disable-next-line no-console
    console.log(
      "→ API: в конфиге не задано deployApi: true — публикация ASP.NET пропущена (добавьте в sloncord-deploy.config.json).\n"
    );
    return;
  }

  const rawRoot = String(config.remoteAppRoot ?? "").trim();
  if (!rawRoot) {
    throw new Error("При deployApi: true укажите remoteAppRoot (каталог приложения на Linux, например /opt/sloncord/app).");
  }
  const remoteAppRoot = assertSafeRemoteUnixPath(rawRoot, "remoteAppRoot");

  const publishDir = runDotnetPublishServer();
  await sftpUploadServerPublishIncremental(common, publishDir, remoteAppRoot, {
    forceAll: opts.forceAll === true,
    skipClientDownloads: opts.skipClientDownloads === true,
  });

  if (config.setupSystemdOnDeploy !== false) {
    await sshEnsureApiRuntime(config, common);
  } else {
    const parentDir = posixDirname(remoteAppRoot) || "/opt/sloncord";
    const remoteDataDir = assertSafeRemoteUnixPath(
      String(config.remoteDataDir ?? "/data/sloncord").trim(),
      "remoteDataDir"
    );
    const sh = [
      "set -e",
      `install -d -m 0755 "${parentDir}" "${remoteAppRoot}" "${remoteDataDir}"`,
      `chown -R www-data:www-data "${parentDir}" "${remoteDataDir}"`,
    ].join("\n");
    await execSshCommand(common, sh);
  }
}

/**
 * По SFTP уходят только файлы, которые **изменились относительно прошлого успешного деплоя**
 * (SHA-256 текущего `apps/web/dist` сравнивается с `deploy/.last-dist-manifest.json`).
 * На состояние сервера не смотрим — только «что получилось после билда у вас локально».
 *
 * Удалённые из билда файлы на сервере не удаляет; полная пересинхронизация — rsync --delete, wipe или --full-sftp.
 *
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} localDir
 * @param {string} remoteWwwroot
 * @param {{ forceAll?: boolean; skipInstaller?: boolean; skipClientDownloads?: boolean }} [opts]
 *        skipInstaller — не отправлять downloads/*.exe (если на сервере уже есть версия по манифесту); при wipe игнорируется.
 *        skipClientDownloads — не отправлять downloads/* (кроме .gitkeep); клиент на GitHub.
 */
async function sftpUploadIncremental(common, localDir, remoteWwwroot, opts = {}) {
  const forceAll = opts.forceAll === true;
  let skipInstaller = opts.skipInstaller === true && !forceAll;
  const skipClientDownloads = opts.skipClientDownloads === true && !forceAll;

  const files = [];
  collectLocalFiles(localDir, localDir, files);

  const { entries, record } = await hashDistFiles(files, "apps/web/dist");
  const prev = loadPreviousManifestHashes();

  let queue = forceAll ? entries : entries.filter((e) => prev[e.rel] !== e.hash);
  const skippedUnchanged = entries.length - queue.length;

  /** @type {Record<string, number>} */
  const sizeByRel = {};
  for (const f of files) {
    sizeByRel[f.rel] = f.size;
  }

  if (skipClientDownloads) {
    /** @type {string[]} */
    const skippedClient = [];
    queue = queue.filter((e) => {
      if (!isClientDownloadArtifact(e.rel)) return true;
      skippedClient.push(e.rel);
      if (prev[e.rel] !== undefined) record[e.rel] = prev[e.rel];
      return false;
    });
    if (skippedClient.length) {
      // eslint-disable-next-line no-console
      console.log(
        `→ SFTP: downloads/* не заливаются (клиент на GitHub): ${skippedClient.join(", ")}\n`
      );
    }
  } else if (skipInstaller) {
    /** @type {string[]} */
    const skippedExe = [];
    const next = queue.filter((e) => {
      if (!isDownloadsInstallerExe(e.rel)) return true;
      if (prev[e.rel] === undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          `   Внимание: ${e.rel} ещё не был на сервере (нет в манифесте) — пропуск установщика невозможен, файл будет отправлен.`
        );
        return true;
      }
      skippedExe.push(e.rel);
      record[e.rel] = prev[e.rel];
      return false;
    });
    if (skippedExe.length) {
      // eslint-disable-next-line no-console
      console.log(
        `→ SFTP: установщик не входит в эту отправку (${skippedExe.join(", ")}). ` +
          `На сервере остаётся предыдущая версия .exe; залейте новый установщик отдельно или отключите skipInstaller.\n`
      );
    }
    queue = next;
  }

  queue = sortEntriesBySizeAsc(queue, sizeByRel);

  // eslint-disable-next-line no-console
  console.log(
    `→ SFTP: сравнение с манифестом — всего ${entries.length} файл(ов), ` +
      `к отправке ${queue.length}, без изменений ${skippedUnchanged}. ` +
      `Порядок: по возрастанию размера (крупный .exe — в конце очереди).\n`
  );

  if (queue.length === 0) {
    saveDistManifest(record);
    // eslint-disable-next-line no-console
    console.log("→ SFTP: отправлять нечего, манифест обновлён.\n");
    return;
  }

  const sftp = new SftpClient();
  let uploaded = 0;
  const uploadTotal = queue.length;

  try {
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: подключение к ${sshEndpointDisplay(common)}…`);
    await sftp.connect(sshConnectOptions(common));
    logSftpTuningSummary();
    // eslint-disable-next-line no-console
    console.log(`   SFTP: соединение установлено. Загрузка ${uploadTotal} файл(ов)…\n`);

    let idx = 0;
    for (const { abs, rel } of queue) {
      idx += 1;
      const remotePath = remoteFilePath(remoteWwwroot, rel);
      const sz = sizeByRel[rel] ?? statSync(abs).size;
      // eslint-disable-next-line no-console
      console.log(
        `   [SFTP ${idx}/${uploadTotal}] отправка ${rel} (${formatBytes(sz)}) → ${remotePath}`
      );
      const t0 = Date.now();
      const dir = posixDirname(remotePath);
      if (dir) {
        await sftp.mkdir(dir, true);
      }
      await sftpUploadOneFastWithPulse(sftp, abs, remotePath, rel, sz);
      uploaded += 1;
      const ms = Date.now() - t0;
      const mibPerS =
        ms > 0 && sz > 0 ? ((sz / 1024 / 1024) / (ms / 1000)).toFixed(2) : "?";
      // eslint-disable-next-line no-console
      console.log(`   [SFTP ${idx}/${uploadTotal}] готово за ${ms} мс (~${mibPerS} МиБ/с)`);
    }
    saveDistManifest(record);
  } finally {
    try {
      await sftp.end();
    } catch { /* ignore */ }
  }
  // eslint-disable-next-line no-console
  console.log(`→ SFTP: завершено, отправлено файлов: ${uploaded}\n`);
}

/**
 * @param {string} localDistRoot
 */
async function mergeManifestFromLocalDistDownloadKeys(localDistRoot) {
  const sub = path.join(localDistRoot, "downloads");
  if (!existsSync(sub)) {
    throw new Error("Нет каталога apps/web/dist/downloads");
  }
  const files = [];
  collectLocalFiles(sub, sub, files);
  const fileList = files.map((f) => ({
    abs: f.abs,
    rel: `downloads/${f.rel.split(path.sep).join("/")}`,
    size: f.size,
  }));
  const { record: dlRecord } = await hashDistFiles(fileList, "dist/downloads", { verbose: false });
  const prev = loadPreviousManifestHashes();
  const merged = { ...prev, ...dlRecord };
  saveDistManifest(merged);
  // eslint-disable-next-line no-console
  console.log("→ Манифест: обновлены только хеши downloads/*\n");
}

/**
 * Инкрементальная заливка только `apps/web/dist/downloads` (относительные пути `downloads/...` на сервере).
 *
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} localDistRoot
 * @param {string} remoteWwwroot
 */
async function sftpUploadIncrementalDownloadsOnly(common, localDistRoot, remoteWwwroot) {
  const sub = path.join(localDistRoot, "downloads");
  if (!existsSync(sub)) {
    throw new Error("Нет apps/web/dist/downloads");
  }
  const files = [];
  collectLocalFiles(sub, sub, files);
  const fileList = files.map((f) => ({
    abs: f.abs,
    rel: `downloads/${f.rel.split(path.sep).join("/")}`,
    size: f.size,
  }));
  const { entries, record: newFromHash } = await hashDistFiles(fileList, "dist/downloads");
  const prev = loadPreviousManifestHashes();
  const queue0 = entries.filter((e) => prev[e.rel] !== e.hash);
  const skippedUnchanged = entries.length - queue0.length;

  /** @type {Record<string, number>} */
  const sizeByRel = {};
  for (const f of fileList) {
    sizeByRel[f.rel] = f.size;
  }
  const queue = sortEntriesBySizeAsc(queue0, sizeByRel);

  // eslint-disable-next-line no-console
  console.log(
    `→ SFTP (только downloads/): в каталоге ${entries.length} файл(ов), ` +
      `к отправке ${queue.length}, без изменений ${skippedUnchanged}.\n`
  );

  if (queue.length === 0) {
    const merged = { ...prev, ...newFromHash };
    saveDistManifest(merged);
    // eslint-disable-next-line no-console
    console.log("→ SFTP: в downloads/ отправлять нечего, манифест (downloads) обновлён.\n");
    return;
  }

  const sftp = new SftpClient();
  let uploaded = 0;
  const uploadTotal = queue.length;
  try {
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: подключение к ${sshEndpointDisplay(common)}…`);
    await sftp.connect(sshConnectOptions(common));
    logSftpTuningSummary();
    // eslint-disable-next-line no-console
    console.log(`   SFTP: соединение установлено. Загрузка ${uploadTotal} файл(ов)…\n`);

    let idx = 0;
    for (const { abs, rel } of queue) {
      idx += 1;
      const remotePath = remoteFilePath(remoteWwwroot, rel);
      const sz = sizeByRel[rel] ?? statSync(abs).size;
      // eslint-disable-next-line no-console
      console.log(
        `   [SFTP ${idx}/${uploadTotal}] отправка ${rel} (${formatBytes(sz)}) → ${remotePath}`
      );
      const t0 = Date.now();
      const dir = posixDirname(remotePath);
      if (dir) {
        await sftp.mkdir(dir, true);
      }
      await sftpUploadOneFastWithPulse(sftp, abs, remotePath, rel, sz);
      uploaded += 1;
      const ms = Date.now() - t0;
      const mibPerS =
        ms > 0 && sz > 0 ? ((sz / 1024 / 1024) / (ms / 1000)).toFixed(2) : "?";
      // eslint-disable-next-line no-console
      console.log(`   [SFTP ${idx}/${uploadTotal}] готово за ${ms} мс (~${mibPerS} МиБ/с)`);
    }
    const merged = { ...prev, ...newFromHash };
    saveDistManifest(merged);
  } finally {
    try {
      await sftp.end();
    } catch { /* ignore */ }
  }
  // eslint-disable-next-line no-console
  console.log(`→ SFTP: завершено, отправлено файлов: ${uploaded}\n`);
}

/**
 * Полная заливка одной папки (только `downloads/`, --desktop-only + --full-sftp).
 *
 * @param {import('ssh2').ConnectConfig} common
 * @param {string} localDownloadsDir
 * @param {string} remoteDownloadsDir
 */
async function sftpFullUploadDownloadsFolder(common, localDownloadsDir, remoteDownloadsDir) {
  const files = [];
  collectLocalFiles(localDownloadsDir, localDownloadsDir, files);
  // eslint-disable-next-line no-console
  console.log(
    `→ SFTP (полная папка downloads): локально ${files.length} файл(ов)\n` +
      `   ${localDownloadsDir}  →  ${remoteDownloadsDir}\n`
  );

  const sftp = new SftpClient();
  /** @type {((ev: { source: string; destination: string }) => void) | null} */
  let onUpload = null;
  let uploadEvents = 0;
  try {
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: подключение к ${sshEndpointDisplay(common)}…`);
    await sftp.connect(sshConnectOptions(common));
    logSftpTuningSummary();
    // eslint-disable-next-line no-console
    console.log("   SFTP: соединение установлено.\n");

    onUpload = (ev) => {
      uploadEvents += 1;
      // eslint-disable-next-line no-console
      console.log(`   [SFTP uploadDir ${uploadEvents}] ${ev.source} → ${ev.destination}`);
    };
    sftp.client.on("upload", onUpload);
    // eslint-disable-next-line no-console
    console.log(
      `→ SFTP: uploadDir (fastPut, до ${envInt("SLONCORD_SFTP_PROMISE_LIMIT", 24, 1, 64)} файлов параллельно)…\n`
    );
    await sftp.uploadDir(localDownloadsDir, remoteDownloadsDir, { useFastput: true, concurrency: 8 });
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: uploadDir завершён (событий: ${uploadEvents})\n`);
  } finally {
    if (onUpload) {
      try {
        sftp.client.removeListener("upload", onUpload);
      } catch { /* ignore */ }
    }
    try {
      await sftp.end();
    } catch { /* ignore */ }
  }
}

async function sftpUpload(common, localDir, remoteWwwroot) {
  const files = [];
  collectLocalFiles(localDir, localDir, files);
  // eslint-disable-next-line no-console
  console.log(
    `→ SFTP (полная папка): локально ${files.length} файл(ов)\n` +
      `   ${localDir}  →  ${remoteWwwroot}\n`
  );

  const sftp = new SftpClient();
  /** @type {((ev: { source: string; destination: string }) => void) | null} */
  let onUpload = null;
  let uploadEvents = 0;

  try {
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: подключение к ${sshEndpointDisplay(common)}…`);
    await sftp.connect(sshConnectOptions(common));
    logSftpTuningSummary();
    // eslint-disable-next-line no-console
    console.log("   SFTP: соединение установлено.\n");

    onUpload = (ev) => {
      uploadEvents += 1;
      // eslint-disable-next-line no-console
      console.log(`   [SFTP uploadDir ${uploadEvents}] ${ev.source} → ${ev.destination}`);
    };
    sftp.client.on("upload", onUpload);

    // eslint-disable-next-line no-console
    console.log(
      `→ SFTP: запуск uploadDir (fastPut, до ${envInt("SLONCORD_SFTP_PROMISE_LIMIT", 24, 1, 64)} файлов параллельно)…\n`
    );
    await sftp.uploadDir(localDir, remoteWwwroot, { useFastput: true, concurrency: 8 });
    // eslint-disable-next-line no-console
    console.log(`→ SFTP: uploadDir завершён (событий передачи: ${uploadEvents})\n`);

    await refreshManifestFromDist(localDir);
  } finally {
    if (onUpload) {
      try {
        sftp.client.removeListener("upload", onUpload);
      } catch { /* ignore */ }
    }
    try {
      await sftp.end();
    } catch { /* ignore */ }
  }
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} localDir
 * @param {string} remoteWwwroot
 * @param {string} keyPath
 */
function tryRsyncDelete(config, localDir, remoteWwwroot, keyPath) {
  const target = `${String(config.user)}@${String(config.host)}:${remoteWwwroot}/`;
  const e = `ssh -i "${keyPath}" -o BatchMode=yes -o StrictHostKeyChecking=accept-new`;
  // eslint-disable-next-line no-console
  console.log("→ rsync --delete (рекомендуемый вариант на Windows: Git for Windows)…\n");
  const r = spawnSync(
    "rsync",
    [
      "-avz",
      "--delete",
      "-e",
      e,
      path.join(localDir) + path.sep,
      target,
    ],
    { stdio: "inherit", shell: true, env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" } }
  );
  return r.status === 0;
}

function runBuildWebOnly() {
  // eslint-disable-next-line no-console
  console.log("→ Сборка: только веб (vite) — без Electron/NSIS; клиент на GitHub Releases…\n");
  const r = spawnSync("npm", ["run", "build:web"], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function runStripClientDownloadsFromDist() {
  const stripScript = path.join(root, "scripts", "strip-client-downloads-from-dist.mjs");
  if (!existsSync(stripScript)) return;
  const r = spawnSync(process.execPath, [stripScript], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function runBuildDesktop() {
  // eslint-disable-next-line no-console
  console.log("→ Сборка: desktop (включает web, .exe, повторный vite)…\n");
  const r = spawnSync("npm", ["run", "build:desktop"], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function runBuildModeration() {
  // eslint-disable-next-line no-console
  console.log("→ Сборка: moderation (.exe + publish-to-web)…\n");
  const r = spawnSync("npm", ["run", "build:moderation"], { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
  const distRoot = path.join(root, "apps", "web", "dist");
  if (existsSync(path.join(distRoot, "index.html"))) {
    // eslint-disable-next-line no-console
    console.log("→ Копирование public/downloads → apps/web/dist/downloads (moderation + desktop)…\n");
    const copy = spawnSync("npm", ["run", "copy-downloads-to-web-dist", "-w", "@sloncord/desktop"], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
    if (copy.status !== 0) {
      process.exit(copy.status ?? 1);
    }
  }
}

/**
 * NSIS + publish-to-web + копия в apps/web/dist/downloads без полного пересобора клиента (нужен уже существующий web/dist).
 */
function runBuildInstallerForDeploy() {
  // eslint-disable-next-line no-console
  console.log(
    "→ Сборка: только установщик + apps/web/dist/downloads (без полного пересобора всего сайта)…\n"
  );
  const r = spawnSync("npm", ["run", "build:installer", "-w", "@sloncord/desktop"], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

async function main() {
  const config = loadConfig();
  const remoteWwwroot = assertRemotePath(String(config.remoteWwwroot));
  const passwordMode = usesPasswordAuth(config);
  let keyPath = "";
  if (!passwordMode) {
    keyPath = resolveSshKeyPath(config);
  }
  const clientOnGithub = backendOnly;

  if (!noBuild) {
    if (desktopOnly) {
      runBuildInstallerForDeploy();
    } else if (withClients) {
      runBuildDesktop();
      runBuildModeration();
    } else {
      runBuildWebOnly();
      runStripClientDownloadsFromDist();
    }
  } else if (desktopOnly) {
    // eslint-disable-next-line no-console
    console.log("→ --no-build --desktop-only: копирую public/downloads → apps/web/dist/downloads…\n");
    const rCopy = spawnSync("npm", ["run", "copy-downloads-to-web-dist", "-w", "@sloncord/desktop"], {
      cwd: root,
      stdio: "inherit",
      shell: true,
    });
    if (rCopy.status !== 0) {
      process.exit(rCopy.status ?? 1);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log("→ --no-build: заливаю уже собранный apps/web/dist\n");
    if (clientOnGithub) {
      runStripClientDownloadsFromDist();
    }
  }
  const localDir = path.join(root, "apps", "web", "dist");
  if (!existsSync(path.join(localDir, "index.html"))) {
    // eslint-disable-next-line no-console
    console.error("Нет apps/web/dist — выполните npm run deploy без --no-build");
    process.exit(1);
  }
  if (desktopOnly && !existsSync(path.join(localDir, "downloads", "desktop-release.json"))) {
    // eslint-disable-next-line no-console
    console.error(
      "Нет apps/web/dist/downloads/ — сначала соберите установщик: npm run deploy:desktop " +
        "без --no-build, либо npm run copy-downloads-to-web-dist в @sloncord/desktop."
    );
    process.exit(1);
  }
  const common = getConnectConfig(config);

  const wipe = !desktopOnly && config.wipeBeforeUpload !== false;
  const wantRsync =
    (preferRsync || process.env.SLONCORD_DEPLOY_USE_RSYNC === "1") && !passwordMode;
  const hasRsync =
    spawnSync("where", ["rsync"], { stdio: "ignore", shell: true }).status === 0;

  if (passwordMode && (preferRsync || process.env.SLONCORD_DEPLOY_USE_RSYNC === "1")) {
    // eslint-disable-next-line no-console
    console.log(
      "→ rsync с паролем не поддерживается (нужен ключ или sshpass); заливаю по SFTP…\n"
    );
  }

  if (desktopOnly) {
    // eslint-disable-next-line no-console
    console.log(
      "→ Режим --desktop-only: заливается только wwwroot/downloads, без очистки всего wwwroot и без restartService.\n"
    );
    if (fullSftp) {
      const dLocal = path.join(localDir, "downloads");
      const dRemote = `${String(remoteWwwroot).replace(/\/+$/, "")}/downloads`;
      if (!existsSync(dLocal)) {
        // eslint-disable-next-line no-console
        console.error("Нет apps/web/dist/downloads");
        process.exit(1);
      }
      await sftpFullUploadDownloadsFolder(common, dLocal, dRemote);
      await mergeManifestFromLocalDistDownloadKeys(localDir);
    } else {
      await sftpUploadIncrementalDownloadsOnly(common, localDir, remoteWwwroot);
    }
  } else if (wantRsync && hasRsync && tryRsyncDelete(config, localDir, remoteWwwroot, keyPath)) {
    // eslint-disable-next-line no-console
    console.log("\n→ Каталог на сервере обновлён (rsync).\n");
    await refreshManifestFromDist(localDir);
  } else {
    if (wantRsync && hasRsync) {
      // eslint-disable-next-line no-console
      console.log("→ rsync завершился с ошибкой, заливаю по SFTP…\n");
    } else if (wantRsync && !hasRsync) {
      // eslint-disable-next-line no-console
      console.log("→ rsync нет в PATH, заливаю по SFTP (или установите rsync, например Git for Windows)…\n");
    }
    if (wipe) {
      await wipeRemoteWwwroot(common, remoteWwwroot);
    }
    if (fullSftp) {
      await sftpUpload(common, localDir, remoteWwwroot);
    } else {
      await sftpUploadIncremental(common, localDir, remoteWwwroot, {
        forceAll: wipe,
        skipInstaller: shouldSkipInstallerDeploy(config) || clientOnGithub,
        skipClientDownloads: clientOnGithub,
      });
    }
  }

  if (!desktopOnly) {
    try {
      await maybeDeploySfu(config, common);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        "SFU: выгрузка прервалась с ошибкой (wwwroot уже мог быть залит).",
        e instanceof Error ? e.message : e
      );
    }
    try {
      await maybeDeployApi(config, common, {
        forceAll: fullSftp,
        skipClientDownloads: clientOnGithub,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (config.deployApi === true) {
        // eslint-disable-next-line no-console
        console.error(
          "API: публикация или выгрузка не удалась (deployApi: true). Деплой прерван — без новых DLL модерация и миграции БД не применятся."
        );
        throw e instanceof Error ? e : new Error(msg);
      }
      // eslint-disable-next-line no-console
      console.warn(
        "API: публикация или выгрузка прервалась с ошибкой (wwwroot/SFU уже могли быть залиты).",
        msg
      );
    }
  }

  const post = String(
    config.restartService != null
      ? config.restartService
      : (config.restartSservice != null ? config.restartSservice : defaultRestartServiceCommand(config))
  ).trim();
  if (post) {
    if (desktopOnly) {
      // eslint-disable-next-line no-console
      console.log(
        `→ В конфиге задана команда перезапуска сервиса, но используется --desktop-only: пропуск, чтобы не прерывать веб.\n` +
          `   (команда была бы: ${post})\n`
      );
    } else {
      // eslint-disable-next-line no-console
      console.log("→ post: " + post + "…\n");
      if (config.deployApi === true) {
        // eslint-disable-next-line no-console
        console.log(
          "   (после перезапуска API при старте выполняется SloncordServerSchema.ApplyAsync — миграции вроде IsAdmin и ServerBans)\n"
        );
      }
      try {
        /** @type {string[]} */
        const shParts = ["set -e"];
        if (config.deployApi === true) {
          // Старый dotnet без systemd может держать :5000 — иначе restart поднимет второй процесс (405).
          shParts.push("fuser -k 5000/tcp 2>/dev/null || true");
        }
        shParts.push(post);
        if (config.deployApi === true && config.setupSystemdOnDeploy !== false) {
          const svc = resolveApiServiceName(config);
          // eslint-disable-next-line no-console
          console.log(`→ post: проверка systemctl is-active ${svc}.service…\n`);
          shParts.push(`systemctl is-active --quiet ${svc}.service`);
        }
        await execSshCommand(common, shParts.join("\n"));
      } catch (e) {
        const msg = e?.message || String(e);
        // eslint-disable-next-line no-console
        console.error(
          "Команда перезапуска службы не выполнена. Без перезапуска новый API не поднимется и миграции БД не применятся.",
          msg
        );
        if (config.deployApi === true) {
          throw e instanceof Error ? e : new Error(msg);
        }
        // eslint-disable-next-line no-console
        console.warn("Выполните restart вручную на сервере.");
      }
    }
  }
  if (desktopOnly) {
    // eslint-disable-next-line no-console
    console.log(
      "\nГотово (только десктоп-артефакты). Каталог /downloads/ на сервере обновлён; служба и статические файлы " +
        "сайта не перезапускались и не очищались."
    );
  } else if (withClients) {
    // eslint-disable-next-line no-console
    console.log(
      "\nГотово (--with-clients). Ctrl+F5. Установщики: /downloads/Sloncord-Setup-x64.exe и moderation .exe на VPS."
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "\nГотово (backend + веб). Ctrl+F5. Windows-клиент — GitHub Releases; на VPS downloads/ не обновлялись."
    );
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
