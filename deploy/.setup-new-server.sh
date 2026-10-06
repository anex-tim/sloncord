#!/bin/bash
# Run on NEW server after rsync — install deps, postgres, nginx, certbot, start services.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx postgresql postgresql-contrib certbot python3-certbot-nginx curl

# ASP.NET runtime if missing
if ! command -v dotnet >/dev/null 2>&1; then
  curl -fsSL https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb -o /tmp/packages-microsoft-prod.deb
  dpkg -i /tmp/packages-microsoft-prod.deb
  apt-get update -qq
  apt-get install -y -qq aspnetcore-runtime-8.0
fi

# Node for SFU if needed
if [ -d /opt/sloncord/sfu ] && ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
if [ -f /opt/sloncord/sfu/package.json ]; then
  (cd /opt/sloncord/sfu && npm ci --omit=dev 2>/dev/null || npm install --omit=dev) || true
fi

# PostgreSQL role/db (match appsettings; password from existing pg if restored)
systemctl enable --now postgresql nginx

install -d -m 0755 /data/sloncord /opt/sloncord
chown -R www-data:www-data /data/sloncord /opt/sloncord/app/wwwroot 2>/dev/null || true

systemctl daemon-reload
systemctl enable sloncord-api sloncord-sfu 2>/dev/null || true
systemctl restart sloncord-sfu 2>/dev/null || true
systemctl restart sloncord-api 2>/dev/null || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx

echo "=== setup-new-server.sh complete ==="
systemctl is-active sloncord-api sloncord-sfu nginx postgresql || true
