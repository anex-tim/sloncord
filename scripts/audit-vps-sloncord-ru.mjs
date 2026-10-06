import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "deploy", "sloncord-deploy.config.json"), "utf8")
);

const cmd = `
echo "=== grep sloncord.ru (etc) ==="
grep -r "sloncord\\.ru" /etc/nginx /etc/sloncord /opt/sloncord 2>/dev/null | head -80 || true
echo "=== nginx sites ==="
ls -la /etc/nginx/sites-enabled/ 2>/dev/null || true
ls -la /etc/nginx/conf.d/ 2>/dev/null || true
echo "=== nginx -T server_name (sloncord) ==="
nginx -T 2>/dev/null | grep -E "server_name|sloncord" | head -40 || true
echo "=== sloncord.env ==="
cat /etc/sloncord/sloncord.env 2>/dev/null || true
echo "=== certbot ==="
certbot certificates 2>/dev/null | head -40 || true
`;

await new Promise((resolve, reject) => {
  const conn = new Client();
  conn
    .on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        stream.on("data", (d) => process.stdout.write(String(d)));
        stream.stderr.on("data", (d) => process.stderr.write(String(d)));
        stream.on("close", (code) => {
          conn.end();
          if (code === 0) resolve(undefined);
          else reject(new Error(`exit ${code}`));
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
