/**
 * IP-only Sloncord on VPS: drop sloncord.ru nginx site, block domain Host, purge env refs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const cfg = JSON.parse(readFileSync(path.join(root, "deploy", "sloncord-deploy.config.json"), "utf8"));
const publicHost = cfg.host || "136.234.12.106";

let httpsTpl = readFileSync(path.join(root, "deploy", "nginx-sloncord.https.provided.conf"), "utf8");
httpsTpl = httpsTpl.replace(/__SERVER_NAME__/g, publicHost);

const domainBlock = `
# Legacy domain — intentionally disabled (IP-only clients).
server {
    listen 80;
    listen [::]:80;
    server_name sloncord.ru www.sloncord.ru turn.sloncord.ru;
    return 444;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name sloncord.ru www.sloncord.ru turn.sloncord.ru;
    ssl_certificate     /etc/ssl/sloncord/fullchain.pem;
    ssl_certificate_key /etc/ssl/sloncord/privkey.pem;
    include /etc/nginx/snippets/sloncord-ssl-params.conf;
    return 444;
}
`;

const nginxSite = `${httpsTpl.trim()}\n${domainBlock}`;

const remoteScript = `
set -e
SITE=/etc/nginx/sites-available/sloncord
cat > "$SITE" << 'NGINX_EOF'
${nginxSite}
NGINX_EOF
ln -sf "$SITE" /etc/nginx/sites-enabled/sloncord
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

ENV=/etc/sloncord/sloncord.env
if [ -f "$ENV" ]; then
  sed -i '/sloncord\\.ru/d' "$ENV"
  grep -q '^SLONCORD_TURN_URLS=' "$ENV" || true
fi

APP_SETTINGS=/opt/sloncord/app/appsettings.json
if [ -f "$APP_SETTINGS" ]; then
  sed -i 's/admin@sloncord\\.ru/admin@${publicHost}/g' "$APP_SETTINGS" || true
fi

if systemctl is-active --quiet coturn 2>/dev/null; then
  systemctl disable --now coturn || true
fi
if [ -f /etc/turnserver.conf ]; then
  sed -i '/sloncord\\.ru/d' /etc/turnserver.conf || true
fi

nginx -t
systemctl reload nginx
systemctl restart sloncord-api.service || true

echo "=== remaining sloncord.ru refs ==="
grep -r "sloncord\\.ru" /etc/nginx /etc/sloncord /opt/sloncord/app 2>/dev/null | grep -v '^Binary' || echo "(none)"
echo DONE
`;

await new Promise((resolve, reject) => {
  const conn = new Client();
  conn
    .on("ready", () => {
      conn.exec(remoteScript, (err, stream) => {
        if (err) return reject(err);
        stream.on("data", (d) => process.stdout.write(String(d)));
        stream.stderr.on("data", (d) => process.stderr.write(String(d)));
        stream.on("close", (code) => {
          conn.end();
          if (code === 0) resolve(undefined);
          else reject(new Error(`remote exit ${code}`));
        });
      });
    })
    .on("error", reject)
    .connect({
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.user || "root",
      password: cfg.sshPassword,
      readyTimeout: 45000,
    });
});

console.log("sloncord.ru removed from VPS nginx/env.");
