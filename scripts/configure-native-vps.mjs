/**
 * Post-deploy: native voice env + firewall + disable SFU on VPS.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "ssh2";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "deploy", "sloncord-deploy.config.json");
const cfg = JSON.parse(readFileSync(configPath, "utf8"));

const host = cfg.host;
const port = cfg.port || 22;
const username = cfg.user || "root";
const password = cfg.sshPassword;
const publicHost = host;
const envFile = "/etc/sloncord/sloncord.env";

const script = `
set -e
touch ${envFile}
grep -q '^SLONCORD_VOICE_MODE=' ${envFile} || echo 'SLONCORD_VOICE_MODE=native' >> ${envFile}
grep -q '^SLONCORD_VOICE_NATIVE_ENABLED=' ${envFile} || echo 'SLONCORD_VOICE_NATIVE_ENABLED=1' >> ${envFile}
grep -q '^SLONCORD_VOICE_NATIVE_PUBLIC_HOST=' ${envFile} || echo 'SLONCORD_VOICE_NATIVE_PUBLIC_HOST=${publicHost}' >> ${envFile}
grep -q '^SLONCORD_VOICE_NATIVE_PORT=' ${envFile} || echo 'SLONCORD_VOICE_NATIVE_PORT=50050' >> ${envFile}
sed -i 's/^SLONCORD_VOICE_MODE=.*/SLONCORD_VOICE_MODE=native/' ${envFile} || true
sed -i 's/^SLONCORD_VOICE_NATIVE_PUBLIC_HOST=.*/SLONCORD_VOICE_NATIVE_PUBLIC_HOST=${publicHost}/' ${envFile} || true
sed -i 's/^SLONCORD_VOICE_NATIVE_PORT=.*/SLONCORD_VOICE_NATIVE_PORT=50050/' ${envFile} || true
if command -v ufw >/dev/null 2>&1; then
  ufw allow 50050/udp >/dev/null 2>&1 || true
fi
systemctl disable --now sloncord-sfu >/dev/null 2>&1 || true
systemctl restart sloncord-api.service
systemctl is-active sloncord-api.service
echo OK
`;

await new Promise((resolve, reject) => {
  const conn = new Client();
  conn
    .on("ready", () => {
      conn.exec(script, (err, stream) => {
        if (err) return reject(err);
        stream
          .on("close", (code) => {
            conn.end();
            if (code === 0) resolve(undefined);
            else reject(new Error(`remote exit ${code}`));
          })
          .on("data", (d) => process.stdout.write(String(d)));
        stream.stderr.on("data", (d) => process.stderr.write(String(d)));
      });
    })
    .on("error", reject)
    .connect({ host, port, username, password, readyTimeout: 45000 });
});

console.log("VPS native voice configured.");
