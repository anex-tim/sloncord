#!/bin/bash
# Run on OLD server (91.186.199.212) — streams data to NEW (136.234.12.106).
set -euo pipefail
NEW_HOST="${NEW_HOST:-136.234.12.106}"
NEW_PASS="${NEW_PASS:?NEW_PASS required}"

export DEBIAN_FRONTEND=noninteractive
command -v sshpass >/dev/null 2>&1 || apt-get update -qq && apt-get install -y -qq sshpass rsync

RSYNC_SSH="sshpass -p ${NEW_PASS} ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null"

echo "=== Sync /opt/sloncord ==="
rsync -aH --info=progress2 -e "$RSYNC_SSH" /opt/sloncord/ "root@${NEW_HOST}:/opt/sloncord/"

echo "=== Sync /data/sloncord ==="
rsync -aH --info=progress2 -e "$RSYNC_SSH" /data/sloncord/ "root@${NEW_HOST}:/data/sloncord/"

echo "=== Sync systemd units ==="
for f in /etc/systemd/system/sloncord-api.service /etc/systemd/system/sloncord-sfu.service; do
  [ -f "$f" ] && sshpass -p "$NEW_PASS" scp -o StrictHostKeyChecking=accept-new "$f" "root@${NEW_HOST}:$f"
done

echo "=== Sync nginx site configs (sloncord*) ==="
mkdir -p /tmp/slon-migrate-nginx
cp -a /etc/nginx/sites-enabled/* /tmp/slon-migrate-nginx/ 2>/dev/null || true
sshpass -p "$NEW_PASS" scp -r -o StrictHostKeyChecking=accept-new /tmp/slon-migrate-nginx/* "root@${NEW_HOST}:/etc/nginx/sites-enabled/" 2>/dev/null || true

echo "=== PostgreSQL dump -> new ==="
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='sloncord'" 2>/dev/null | grep -q 1; then
  sudo -u postgres pg_dump -Fc sloncord -f /tmp/sloncord.dump
  sshpass -p "$NEW_PASS" scp -o StrictHostKeyChecking=accept-new /tmp/sloncord.dump "root@${NEW_HOST}:/tmp/sloncord.dump"
  sshpass -p "$NEW_PASS" ssh -o StrictHostKeyChecking=accept-new "root@${NEW_HOST}" bash <<'REMOTE'
set -e
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sloncord'" | grep -q 1; then
  sudo -u postgres psql -c "CREATE USER sloncord WITH PASSWORD 'sloncord_migrate_temp';"
fi
sudo -u postgres psql -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'sloncord' AND pid <> pg_backend_pid();" 2>/dev/null || true
sudo -u postgres dropdb --if-exists sloncord
sudo -u postgres createdb -O sloncord sloncord
sudo -u postgres pg_restore -d sloncord --no-owner --no-acl /tmp/sloncord.dump
rm -f /tmp/sloncord.dump
REMOTE
  rm -f /tmp/sloncord.dump
fi

echo "=== Done migrate-remote.sh ==="
