#!/usr/bin/env py
"""One-off remote command runner (reads password from env SSH_PASS). Do not commit passwords."""
import os
import sys
import paramiko

def main():
    if len(sys.argv) < 3:
        print("usage: SSH_PASS=... py .ssh-run-once.py HOST 'command'", file=sys.stderr)
        sys.exit(2)
    host = sys.argv[1]
    cmd = sys.argv[2]
    password = os.environ.get("SSH_PASS", "")
    user = os.environ.get("SSH_USER", "root")
    if not password:
        print("SSH_PASS required", file=sys.stderr)
        sys.exit(2)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        host,
        username=user,
        password=password,
        timeout=60,
        banner_timeout=120,
        auth_timeout=120,
        allow_agent=False,
        look_for_keys=False,
    )
    stdin, stdout, stderr = client.exec_command(cmd, get_pty=False, timeout=600)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    enc = getattr(sys.stdout, "encoding", None) or "utf-8"

    def safe_print(s, stream=sys.stdout):
        if not s:
            return
        try:
            stream.write(s if s.endswith("\n") else s + "\n")
        except UnicodeEncodeError:
            stream.buffer.write(s.encode(enc, errors="replace"))
            if not s.endswith("\n"):
                stream.buffer.write(b"\n")

    safe_print(out)
    safe_print(err, sys.stderr)
    client.close()
    sys.exit(code)

if __name__ == "__main__":
    main()
