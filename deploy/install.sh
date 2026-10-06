#!/usr/bin/env bash
set -euo pipefail

# Install Sloncord on Ubuntu (no Docker) using Nginx (80) + systemd + dotnet publish to /opt/sloncord/app
#
# Usage (from repo root, on the server):
#   HTTP + Let's Encrypt:
#     sudo SLONCORD_SERVER_NAME="www.sloncord.ru sloncord.ru" SLONCORD_LE_EMAIL="you@example.com" bash deploy/install.sh
#   Свой SSL (файлы deploy/ssl/fullchain.pem и deploy/ssl/privkey.pem):
#     sudo SLONCORD_SERVER_NAME="www.sloncord.ru sloncord.ru" bash deploy/install.sh
#
# Optional:
#   SLONCORD_LETSENCRYPT_CERT_NAME="sloncord.ru"   (defaults to the first name in SLONCORD_SERVER_NAME)
#   SLONCORD_DATA_DIR="/data/sloncord"  (каталог для uploads/аватаров; иначе при пересборке /opt файлы «теряются»)
#
# Свой SSL (GlobalSign и т.д.) — вместо Let's Encrypt:
#   Положите в deploy/ssl/ на сервере: fullchain.pem + privkey.pem (см. deploy/ssl/README.md)
#   Или укажите пути:
#     SLONCORD_SSL_FULLCHAIN_SOURCE=/path/fullchain.pem SLONCORD_SSL_PRIVKEY_SOURCE=/path/privkey.pem
#   При наличии этих файлов certbot **не** вызывается.
#
# Notes:
# - Kestrel listens on 127.0.0.1:5000
# - Nginx proxies everything to Kestrel (UI + API + /health on the same origin)

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVER_CSPROJ="${REPO_DIR}/Server/Server/Server.csproj"

if [[ ! -f "${SERVER_CSPROJ}" ]]; then
  echo "Could not find Server project at: ${SERVER_CSPROJ}" >&2
  echo "Run this script from the Sloncord repository (deploy/install.sh must exist)." >&2
  exit 1
fi

SLONCORD_SERVER_NAME="${SLONCORD_SERVER_NAME:-136.234.12.106}"
SLONCORD_LE_EMAIL="${SLONCORD_LE_EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/sloncord/app}"
RUNTIME_ID="${RUNTIME_ID:-linux-x64}"
PRIMARY_NAME="$(echo "${SLONCORD_SERVER_NAME}" | awk '{print $1}')"

export DEBIAN_FRONTEND=noninteractive

apt_updated=0
apt_update_if_needed() {
  if (( apt_updated )); then return 0; fi
  apt-get update -y
  apt_updated=1
}

ensure_apt_packages() {
  local missing=()
  local p
  for p in "$@"; do
    if ! dpkg -s "$p" >/dev/null 2>&1; then
      missing+=("$p")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    apt_update_if_needed
    apt-get install -y "${missing[@]}"
  fi
}

# Base packages (only install if missing)
ensure_apt_packages ca-certificates curl gnupg apt-transport-https nginx openssl
ensure_apt_packages postgresql
# For TLS automation (skip on re-deploy if already present)
ensure_apt_packages certbot python3-certbot-nginx
# Tooling used by mediasoup build (best-effort)
ensure_apt_packages build-essential python3 pkg-config || true

ensure_nodejs_20() {
  if command -v node >/dev/null 2>&1; then
    local v
    v="$(node -v 2>/dev/null | sed 's/^v//')"
    local major="${v%%.*}"
    if [[ "${major}" =~ ^[0-9]+$ ]] && (( major >= 18 )); then
      return 0
    fi
  fi
  # NodeSource repo for Node 20.x
  apt_update_if_needed
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt_update_if_needed
  apt-get install -y nodejs
}

ensure_nodejs_20

ensure_microsoft_apt_repo() {
  if [[ -f /etc/apt/sources.list.d/microsoft-prod.list ]]; then
    return 0
  fi

  DISTRO_ID="$(. /etc/os-release && echo "${ID} ${VERSION_CODENAME:-${VERSION_ID:-}}")"
  if ! grep -qi ubuntu <<<"${DISTRO_ID}"; then
    echo "This installer expects Ubuntu (found: ${DISTRO_ID})." >&2
    echo "Install .NET 8 SDK manually, then re-run the script." >&2
    exit 1
  fi

  # Microsoft package repo (Ubuntu 22.04+)
  install -d /etc/apt/keyrings
  curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg
  chmod a+r /etc/apt/keyrings/microsoft.gpg

  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/microsoft-ubuntu-${VERSION_CODENAME}-prod ${VERSION_CODENAME} main" \
    > /etc/apt/sources.list.d/microsoft-prod.list

  apt_update_if_needed
}

# dotnet publish requires a .NET SDK (runtime-only install is not enough)
if ! command -v dotnet >/dev/null 2>&1 || [[ -z "$(dotnet --list-sdks 2>/dev/null | tr -d '[:space:]')" ]]; then
  ensure_microsoft_apt_repo
  ensure_apt_packages dotnet-sdk-8.0
fi

# Postgres (local) + connection string for ASP.NET Core
SLONCORD_DB_NAME="${SLONCORD_DB_NAME:-sloncord}"
SLONCORD_DB_USER="${SLONCORD_DB_USER:-sloncord}"
if [[ -z "${SLONCORD_DB_PASSWORD:-}" ]]; then
  SLONCORD_DB_PASSWORD="$(openssl rand -base64 32)"
fi

install -d -m 0755 /etc/sloncord
SLONCORD_ENV_FILE="/etc/sloncord/sloncord.env"
# Стабильное хранилище файлов (вне /opt/sloncord/app, иначе при каждом publish каталог пустеет)
SLONCORD_DATA_DIR="${SLONCORD_DATA_DIR:-/data/sloncord}"
install -d -m 0755 "${SLONCORD_DATA_DIR}"
chown www-data:www-data "${SLONCORD_DATA_DIR}"

systemctl enable --now postgresql >/dev/null 2>&1 || true

# Create DB + role (idempotent)
# NOTE: do NOT use "DO $$" inside an unquoted heredoc: bash replaces $$ with the shell PID and breaks SQL.
# Escape any single quote in the password for PostgreSQL string literals.
_slon_sql_escape() { printf %s "$1" | sed "s/'/''/g"; }
SLONCORD_DB_PASSWORD_SQL="$(_slon_sql_escape "${SLONCORD_DB_PASSWORD}")"

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${SLONCORD_DB_USER}'" 2>/dev/null | grep -q 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE \"${SLONCORD_DB_USER}\" LOGIN PASSWORD '${SLONCORD_DB_PASSWORD_SQL}';"
else
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE \"${SLONCORD_DB_USER}\" WITH PASSWORD '${SLONCORD_DB_PASSWORD_SQL}';"
fi

# Safer than \\gexec (works the same, but more explicit)
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${SLONCORD_DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "${SLONCORD_DB_USER}" "${SLONCORD_DB_NAME}"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT ALL PRIVILEGES ON DATABASE \"${SLONCORD_DB_NAME}\" TO \"${SLONCORD_DB_USER}\";" >/dev/null

umask 077
# Keep user's custom settings (TURN, etc). Only set required keys if missing.
touch "${SLONCORD_ENV_FILE}"
chmod 0600 "${SLONCORD_ENV_FILE}"
chown root:root "${SLONCORD_ENV_FILE}"

upsert_env_kv() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "${SLONCORD_ENV_FILE}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${SLONCORD_ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${SLONCORD_ENV_FILE}"
  fi
}

upsert_env_kv "ConnectionStrings__DefaultConnection" "Host=127.0.0.1;Port=5432;Database=${SLONCORD_DB_NAME};Username=${SLONCORD_DB_USER};Password=${SLONCORD_DB_PASSWORD}"
upsert_env_kv "SLONCORD_DATA_DIR" "${SLONCORD_DATA_DIR}"

# Variant C: native UDP voice (default on new installs).
if ! grep -qE '^SLONCORD_VOICE_MODE=' "${SLONCORD_ENV_FILE}"; then
  upsert_env_kv "SLONCORD_VOICE_MODE" "native"
fi
if ! grep -qE '^SLONCORD_VOICE_NATIVE_ENABLED=' "${SLONCORD_ENV_FILE}"; then
  upsert_env_kv "SLONCORD_VOICE_NATIVE_ENABLED" "1"
fi
if ! grep -qE '^SLONCORD_VOICE_NATIVE_PUBLIC_HOST=' "${SLONCORD_ENV_FILE}"; then
  upsert_env_kv "SLONCORD_VOICE_NATIVE_PUBLIC_HOST" "${PRIMARY_NAME}"
fi
if ! grep -qE '^SLONCORD_VOICE_NATIVE_PORT=' "${SLONCORD_ENV_FILE}"; then
  upsert_env_kv "SLONCORD_VOICE_NATIVE_PORT" "50050"
fi
if ! grep -qE '^SLONCORD_WINDOWS_CLIENTS_ONLY=' "${SLONCORD_ENV_FILE}"; then
  upsert_env_kv "SLONCORD_WINDOWS_CLIENTS_ONLY" "1"
fi

VOICE_MODE="native"
if grep -qE '^SLONCORD_VOICE_MODE=' "${SLONCORD_ENV_FILE}"; then
  VOICE_MODE="$(grep -E '^SLONCORD_VOICE_MODE=' "${SLONCORD_ENV_FILE}" | head -n1 | cut -d= -f2- | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
fi

# SFU (mediasoup) defaults — only needed for SLONCORD_VOICE_MODE=legacy.
if ! grep -qE "^SLONCORD_SFU_SECRET=" "${SLONCORD_ENV_FILE}"; then
  upsert_env_kv "SLONCORD_SFU_SECRET" "$(openssl rand -base64 48)"
fi
upsert_env_kv "Sloncord__Voice__Sfu__Secret" "$(grep -E '^SLONCORD_SFU_SECRET=' "${SLONCORD_ENV_FILE}" | head -n1 | cut -d= -f2-)"
upsert_env_kv "Sloncord__Voice__Sfu__Url" "wss://${PRIMARY_NAME}/ws/sfu"
upsert_env_kv "Sloncord__Voice__Sfu__TokenTtlSeconds" "600"

# Mediasoup needs announcedIp on servers behind NAT / with private interfaces.
# If not set by user, try to auto-detect public IP once.
if ! grep -qE "^SLONCORD_SFU_ANNOUNCED_IP=" "${SLONCORD_ENV_FILE}"; then
  SFU_PUBLIC_IP=""
  if command -v curl >/dev/null 2>&1; then
    SFU_PUBLIC_IP="$(curl -fsSL https://api.ipify.org || true)"
  fi
  if [[ -n "${SFU_PUBLIC_IP}" ]]; then
    upsert_env_kv "SLONCORD_SFU_ANNOUNCED_IP" "${SFU_PUBLIC_IP}"
  else
    # Leave empty; user must set it manually.
    upsert_env_kv "SLONCORD_SFU_ANNOUNCED_IP" ""
  fi
fi

if ! grep -q "^# Optional TURN for WebRTC voice" "${SLONCORD_ENV_FILE}" 2>/dev/null; then
  cat >>"${SLONCORD_ENV_FILE}" <<'ENV_HINT'
# Optional TURN for WebRTC voice (edit this file to enable)
# SLONCORD_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
# SLONCORD_TURN_USERNAME=sloncordturn
# SLONCORD_TURN_CREDENTIAL=CHANGE_ME
ENV_HINT
fi
umask 022

# Publish app
install -d "${APP_DIR}"
# During upgrades, don't wipe the publish directory while the service is running:
# it causes brief "connection refused"/WS resets and can corrupt reads mid-request.
if systemctl list-unit-files sloncord.service >/dev/null 2>&1; then
  systemctl stop sloncord >/dev/null 2>&1 || true
fi
runuser -u root -- rm -rf "${APP_DIR:?}/"*
# Ensure deterministic publish layout
runuser -u root -- dotnet publish "${SERVER_CSPROJ}" -c Release -o "${APP_DIR}" -r "${RUNTIME_ID}" --self-contained false

# Web UI: Vite build output in apps/web/dist (linked from Server.csproj into wwwroot on publish).
# Синхронизируем с репозиторием после publish — так на сервере всегда актуальный UI из git/CI,
# даже если Content в csproj не подтянулся.
# Раньше использовался Client/Client/wwwroot (legacy); теперь источник истины — apps/web/dist.
WEB_DIST="${REPO_DIR}/apps/web/dist"
if [[ -d "${WEB_DIST}" ]]; then
  install -d "${APP_DIR}/wwwroot"
  cp -a "${WEB_DIST}/." "${APP_DIR}/wwwroot/"
else
  echo "WARNING: Missing ${WEB_DIST} — соберите фронт на машине деплоя: (cd apps/web && npm ci && npm run build), или заливайте репозиторий уже с apps/web/dist." >&2
  echo "WARNING: Без dist в wwwroot останется только то, что попало из dotnet publish." >&2
fi

# Permissions (Kestrel runs as www-data)
chown -R www-data:www-data "${APP_DIR}"

CLIENT_WWWROOT="${APP_DIR}/wwwroot"
install -d "${CLIENT_WWWROOT}"

if [[ "${VOICE_MODE}" == "legacy" ]]; then
  # Build: mediasoup-client browser bundle (legacy voice only).
  TOOL_DIR="/opt/sloncord/tooling/mediasoup-bundle"
  install -d "${TOOL_DIR}"
  cat >"${TOOL_DIR}/package.json" <<'JSON'
{
  "name": "sloncord-mediasoup-bundle",
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "esbuild": "^0.25.0",
    "mediasoup-client": "^3.0.0"
  }
}
JSON

  need_tool_install=0
  if [[ ! -d "${TOOL_DIR}/node_modules" ]]; then
    need_tool_install=1
  fi
  if [[ "${need_tool_install}" -eq 1 ]]; then
    (
      cd "${TOOL_DIR}"
      npm install --silent >/dev/null 2>&1
    )
  fi

  (
    cd "${TOOL_DIR}"
    SLONCORD_BUNDLE_OUT="${CLIENT_WWWROOT}/mediasoup-client.bundle.js" node - <<'NODE'
const esbuild = require("esbuild");
const entry = require.resolve("mediasoup-client");
const out = process.env.SLONCORD_BUNDLE_OUT;
esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  sourcemap: false,
  platform: "browser",
  format: "iife",
  globalName: "mediasoupClient",
  outfile: out,
  define: { global: "window" }
}).catch((e) => { console.error(e); process.exit(1); });
NODE
  )
  chown www-data:www-data "${CLIENT_WWWROOT}/mediasoup-client.bundle.js" >/dev/null 2>&1 || true

  SFU_DIR="/opt/sloncord/sfu"
  install -d "${SFU_DIR}"
  rm -rf "${SFU_DIR:?}/"*
  cp -a "${REPO_DIR}/Sfu/." "${SFU_DIR}/"
  chown -R www-data:www-data "${SFU_DIR}"
  (
    cd "${SFU_DIR}"
    NEED_NPM=0
    if [[ ! -d node_modules ]]; then NEED_NPM=1; fi
    if (( NEED_NPM )); then npm install --omit=dev; fi
  )
else
  systemctl disable --now sloncord-sfu >/dev/null 2>&1 || true
fi

# systemd
install -m 0644 "${REPO_DIR}/deploy/sloncord.service" /etc/systemd/system/sloncord.service
install -m 0644 "${REPO_DIR}/deploy/sloncord-sfu.service" /etc/systemd/system/sloncord-sfu.service
systemctl daemon-reload
systemctl enable --now sloncord
if [[ "${VOICE_MODE}" == "legacy" ]]; then
  systemctl enable --now sloncord-sfu || true
  systemctl restart sloncord-sfu || true
fi
systemctl restart sloncord

open_firewall_if_possible() {
  if command -v ufw >/dev/null 2>&1; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    if [[ "${VOICE_MODE}" == "legacy" ]]; then
      ufw allow 3333/tcp >/dev/null 2>&1 || true
      ufw allow 10000:20000/udp >/dev/null 2>&1 || true
    else
      ufw allow 50050/udp >/dev/null 2>&1 || true
    fi
  fi
}

first_server_name() {
  # "sloncord.ru www.sloncord.ru" -> "sloncord.ru"
  echo "${1}" | awk '{print $1}'
}

# Nginx: HTTP, или сразу HTTPS (свой сертификат), либо позже — Let's Encrypt
open_firewall_if_possible

# --- Разбор «свой» SSL (файлы в deploy/ssl/ или SLONCORD_SSL_*_SOURCE) ---
SLONCORD_FULLCHAIN_SRC=""
SLONCORD_PRIVKEY_SRC=""
if [[ -n "${SLONCORD_SSL_FULLCHAIN_SOURCE:-}" && -n "${SLONCORD_SSL_PRIVKEY_SOURCE:-}" ]]; then
  SLONCORD_FULLCHAIN_SRC="${SLONCORD_SSL_FULLCHAIN_SOURCE}"
  SLONCORD_PRIVKEY_SRC="${SLONCORD_SSL_PRIVKEY_SOURCE}"
elif [[ -f "${REPO_DIR}/deploy/ssl/fullchain.pem" && -f "${REPO_DIR}/deploy/ssl/privkey.pem" ]]; then
  SLONCORD_FULLCHAIN_SRC="${REPO_DIR}/deploy/ssl/fullchain.pem"
  SLONCORD_PRIVKEY_SRC="${REPO_DIR}/deploy/ssl/privkey.pem"
fi

USE_CUSTOM_SSL=0
if [[ -n "${SLONCORD_FULLCHAIN_SRC}" && -n "${SLONCORD_PRIVKEY_SRC}" ]]; then
  USE_CUSTOM_SSL=1
fi

if (( USE_CUSTOM_SSL )); then
  if [[ ! -r "${SLONCORD_FULLCHAIN_SRC}" ]]; then
    echo "Custom SSL: cannot read full chain: ${SLONCORD_FULLCHAIN_SRC}" >&2
    exit 1
  fi
  if [[ ! -r "${SLONCORD_PRIVKEY_SRC}" ]]; then
    echo "Custom SSL: cannot read private key: ${SLONCORD_PRIVKEY_SRC}" >&2
    exit 1
  fi
  install -d -m 0755 /etc/ssl/sloncord
  install -m 0644 "${SLONCORD_FULLCHAIN_SRC}" /etc/ssl/sloncord/fullchain.pem
  install -m 0600 "${SLONCORD_PRIVKEY_SRC}" /etc/ssl/sloncord/privkey.pem
  chown root:root /etc/ssl/sloncord/fullchain.pem /etc/ssl/sloncord/privkey.pem
  install -d -m 0755 /etc/nginx/snippets
  install -m 0644 "${REPO_DIR}/deploy/nginx-ssl-params.conf" /etc/nginx/snippets/sloncord-ssl-params.conf

  TMP_NG="/tmp/sloncord.nginx.provided.$$.conf"
  sed "s/__SERVER_NAME__/${SLONCORD_SERVER_NAME//\//\\\/}/g" "${REPO_DIR}/deploy/nginx-sloncord.https.provided.conf" > "${TMP_NG}"
  install -m 0644 "${TMP_NG}" /etc/nginx/sites-available/sloncord
  rm -f "${TMP_NG}"
else
  TMP_NG="/tmp/sloncord.nginx.$$.conf"
  sed "s/__SERVER_NAME__/${SLONCORD_SERVER_NAME//\//\\\/}/g" "${REPO_DIR}/deploy/nginx-sloncord.http.conf" > "${TMP_NG}"
  install -m 0644 "${TMP_NG}" /etc/nginx/sites-available/sloncord
  rm -f "${TMP_NG}"
fi

# Ensure enabled
ln -sf /etc/nginx/sites-available/sloncord /etc/nginx/sites-enabled/sloncord
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

nginx -t
systemctl enable --now nginx
systemctl restart nginx
systemctl restart sloncord

# TLS (Let's Encrypt) — только если **не** используем свой сертификат
LE_PRIMARY="$(first_server_name "${SLONCORD_SERVER_NAME}")"
LE_CERT_NAME="${SLONCORD_LETSENCRYPT_CERT_NAME:-${LE_PRIMARY}}"

# shellcheck disable=SC2206
DOMAINS=( ${SLONCORD_SERVER_NAME} )

if (( USE_CUSTOM_SSL )); then
  echo
  echo "Nginx: HTTPS with custom certificate (/etc/ssl/sloncord/). Let's Encrypt (certbot) skipped."
else
  if [[ -n "${SLONCORD_LE_EMAIL}" ]]; then
    if [[ ${#DOMAINS[@]} -le 0 ]]; then
      echo "WARNING: SLONCORD_SERVER_NAME is empty; skipping HTTPS (Let's Encrypt)." >&2
    else
      if [[ -f "/etc/letsencrypt/live/${LE_CERT_NAME}/cert.pem" || -f "/etc/letsencrypt/live/${LE_CERT_NAME}/fullchain.pem" ]]; then
        certbot renew -q || true
      else
        CERTBOT_ARGS=(certbot certonly --nginx --non-interactive --agree-tos --email "${SLONCORD_LE_EMAIL}")
        for d in "${DOMAINS[@]}"; do
          CERTBOT_ARGS+=(-d "${d}")
        done
        if ! "${CERTBOT_ARGS[@]}"; then
          echo "WARNING: Certbot failed. The site will stay on HTTP only." >&2
          echo "        Fix DNS/ports, then re-run: certbot --nginx" >&2
        fi
      fi

      if [[ -f "/etc/letsencrypt/live/${LE_CERT_NAME}/fullchain.pem" && -f "/etc/letsencrypt/live/${LE_CERT_NAME}/privkey.pem" ]]; then
        TMP_SSL="/tmp/sloncord.nginx.ssl.$$.conf"
        sed \
          -e "s/__SERVER_NAME__/${SLONCORD_SERVER_NAME//\//\\\/}/g" \
          -e "s/__LE_CERT_NAME__/${LE_CERT_NAME//\//\\\/}/g" \
          "${REPO_DIR}/deploy/nginx-sloncord.https.conf" > "${TMP_SSL}"
        install -m 0644 "${TMP_SSL}" /etc/nginx/sites-available/sloncord
        rm -f "${TMP_SSL}"
        nginx -t
        systemctl reload nginx
      else
        echo "WARNING: Certificate files for '${LE_CERT_NAME}' not found; keeping HTTP-only nginx config." >&2
      fi
    fi
  else
    echo
    echo "NOTE: No deploy/ssl/*.pem; SLONCORD_LE_EMAIL is not set — skipping HTTPS (Let's Encrypt)."
    echo "      For GlobalSign/… cert: add deploy/ssl/fullchain.pem + privkey.pem, re-run (see deploy/ssl/README.md)."
    echo "      Or: SLONCORD_LE_EMAIL=you@example.com for Let's Encrypt."
  fi
fi

echo
echo "Sloncord installed."
echo "Data directory (uploads, avatars): ${SLONCORD_DATA_DIR}  (also in /etc/sloncord/sloncord.env for systemd)"
echo "Local checks (on the server):"
echo "  curl -i http://127.0.0.1/health"
echo "  curl -i http://127.0.0.1/ | head -n 20"
echo
echo "Public checks (after DNS A-record points to this server and ports are open):"
echo "  curl -i http://${LE_PRIMARY}/health"
echo "  curl -i https://${LE_PRIMARY}/health"
