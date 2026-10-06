# Sloncord SFU (mediasoup)

Клиенты **не подключаются напрямую**, если на бэкенде включён voice gateway (`Sloncord:Voice:Gateway:Enabled`, по умолчанию `true`). ASP.NET проксирует mediasoup-сигналинг через `/ws/voice`; SFU должен быть доступен **только с сервера** (внутренняя сеть / localhost).

Env:

- `SLONCORD_SFU_PORT` (default `3333`)
- `SLONCORD_SFU_WS_PATH` (default `/ws/sfu`)
- `SLONCORD_SFU_SECRET` (**required**, must match backend `Sloncord:Voice:Sfu:Secret`)
- `SLONCORD_SFU_LISTEN_IP` (default `0.0.0.0`)
- `SLONCORD_SFU_ANNOUNCED_IP` (public IP or public DNS A-record target)
- `SLONCORD_SFU_RTC_MIN_PORT` / `SLONCORD_SFU_RTC_MAX_PORT` (default `10000-20000`)

Run:

```bash
npm install
npm start
```

## TURN (coturn)

For users behind hard NAT, configure TURN on the **ASP.NET** server (`/voice/ice` returns ICE servers to the browser). SFU UDP media still flows client ↔ SFU; TURN helps WebRTC ICE when direct UDP fails.

Example `appsettings.json`:

```json
"Turn": {
  "Urls": [ "turn:YOUR_PUBLIC_IP:3478?transport=udp", "turn:YOUR_PUBLIC_IP:3478?transport=tcp" ],
  "Username": "sloncord",
  "Credential": "your-turn-secret"
}
```

Or env: `SLONCORD_TURN_URLS`, `SLONCORD_TURN_USERNAME`, `SLONCORD_TURN_CREDENTIAL`.

Optional local coturn: `docker compose -f docker-compose.coturn.yml up -d` (see file for `TURN_EXTERNAL_IP`).

When TURN URLs are present, the web client sets `iceTransportPolicy: relay` on mediasoup transports.

