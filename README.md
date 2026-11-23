# xray-node (Render free web service)

VLESS + WebSocket inbound behind Caddy (platform TLS), two users routed to
two SOCKS5 egress endpoints, all other traffic blocked. All secrets are
environment variables set in the Render dashboard; nothing secret is in
this repo.

Env vars: UUID_A, UUID_B, WS_PATH, US_TOKEN, JP_TOKEN.

## Probe

`probe.py` listens on 127.0.0.1:18081 and is exposed only via the secret
`PROBE_PATH`. A GET runs (60s cache): TCP connect to the SOCKS landing,
username auth with each route token, CONNECT ip.sb:80, read the exit IP.
Response JSON: {"us": {"tcp", "auth", "exit_ip", "error"}, "jp": {...}}.
Tokens are read from env and never appear in responses or logs.
