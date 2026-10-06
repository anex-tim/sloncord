#!/usr/bin/env py
"""
Migrate Sloncord from old VPS to new VPS.
Env: OLD_HOST, OLD_PASS, NEW_HOST, NEW_PASS (required).
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent
OLD_HOST = os.environ.get("OLD_HOST", "91.186.199.212")
NEW_HOST = os.environ.get("NEW_HOST", "136.234.12.106")
OLD_PASS = os.environ.get("OLD_PASS", "")
NEW_PASS = os.environ.get("NEW_PASS", "")
USER = "root"


def connect(host: str, password: str, attempts: int = 5) -> paramiko.SSHClient:
    last: Exception | None = None
    for i in range(attempts):
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                host,
                username=USER,
                password=password,
                timeout=60,
                banner_timeout=180,
                auth_timeout=120,
                allow_agent=False,
                look_for_keys=False,
            )
            return client
        except Exception as e:
            last = e
            try:
                client.close()
            except Exception:
                pass
            time.sleep(3 + i * 2)
    raise last or RuntimeError(f"SSH failed: {host}")


def run(client: paramiko.SSHClient, cmd: str, timeout: int = 7200) -> tuple[int, str, str]:
    print(f"\n>>> [{client.get_transport().getpeername()[0]}] {cmd[:200]}...")
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=False, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print(err.rstrip(), file=sys.stderr)
    print(f"<<< exit {code}")
    return code, out, err


def upload(client: paramiko.SSHClient, local: Path, remote: str) -> None:
    sftp = client.open_sftp()
    try:
        sftp.put(str(local), remote)
        sftp.chmod(remote, 0o755)
    finally:
        sftp.close()


def main() -> int:
    if not OLD_PASS or not NEW_PASS:
        print("Set OLD_PASS and NEW_PASS env vars.", file=sys.stderr)
        return 2

    setup_sh = ROOT / ".setup-new-server.sh"
    migrate_sh = ROOT / ".migrate-remote.sh"
    if not setup_sh.is_file() or not migrate_sh.is_file():
        print("Missing .setup-new-server.sh or .migrate-remote.sh", file=sys.stderr)
        return 2

    print("=== Phase 0: inventory old ===")
    old = connect(OLD_HOST, OLD_PASS)
    run(old, "du -sh /opt/sloncord /data/sloncord; systemctl cat sloncord-api.service 2>/dev/null | head -40")
    old.close()

    print("\n=== Phase 1: prepare new server ===")
    new = connect(NEW_HOST, NEW_PASS)
    upload(new, setup_sh, "/root/setup-new-server.sh")
    code, _, _ = run(new, "bash /root/setup-new-server.sh", timeout=3600)
    if code != 0:
        print("Setup on new server failed.", file=sys.stderr)
        new.close()
        return code

    print("\n=== Phase 2: rsync + DB from old -> new ===")
    old = connect(OLD_HOST, OLD_PASS)
    upload(old, migrate_sh, "/root/migrate-remote.sh")
    migrate_cmd = f"export NEW_HOST={NEW_HOST} NEW_PASS={NEW_PASS!r}; bash /root/migrate-remote.sh"
    code, _, _ = run(old, migrate_cmd, timeout=7200)
    old.close()
    if code != 0:
        print("Migration rsync failed.", file=sys.stderr)
        return code

    print("\n=== Phase 3: finalize new server ===")
    new = connect(NEW_HOST, NEW_PASS)
    run(new, "chown -R www-data:www-data /data/sloncord /opt/sloncord/app/wwwroot 2>/dev/null; systemctl daemon-reload; systemctl restart sloncord-sfu sloncord-api nginx; sleep 3; systemctl is-active sloncord-api sloncord-sfu nginx")
    new.close()

    print("\n=== Migration finished ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
