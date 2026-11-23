#!/usr/bin/env python3
"""Render the Xray config from environment variables at container start.
Required env: UUID_A, UUID_B, WS_PATH, US_TOKEN, JP_TOKEN.
Optional env: UUID_C + SG_TOKEN add a third route (Singapore) when both
are present; if either is missing the two-route config is rendered and a
warning is printed, so the US/JP service can never be broken by a
half-finished SG setup. Values are written only into /app/config.json
(chmod 600) and never printed."""
import json, os, sys

required = ["UUID_A", "UUID_B", "WS_PATH", "US_TOKEN", "JP_TOKEN"]
missing = [k for k in required if not os.environ.get(k)]
if missing:
    print("missing env vars:", ",".join(missing), file=sys.stderr)
    sys.exit(1)

def socks(tag, token, host="65.49.70.92", port=7171):
    return {"tag": tag, "protocol": "socks",
            "settings": {"servers": [{"address": host, "port": port,
                        "users": [{"user": token, "pass": ""}]}]}}

clients = [
    {"id": os.environ["UUID_A"], "email": "a-us"},
    {"id": os.environ["UUID_B"], "email": "b-jp"},
]
outbounds = [
    {"tag": "block", "protocol": "blackhole"},
    socks("us-socks", os.environ["US_TOKEN"]),
    socks("jp-socks", os.environ["JP_TOKEN"]),
]
rules = [
    {"type": "field", "user": ["a-us"], "outboundTag": "us-socks"},
    {"type": "field", "user": ["b-jp"], "outboundTag": "jp-socks"},
]

if os.environ.get("UUID_C") and os.environ.get("SG_TOKEN"):
    clients.append({"id": os.environ["UUID_C"], "email": "c-sg"})
    # The SG token was issued against fireside.bringyour.com:7141 (its
    # auth-client result), not the 65.49.70.92:7171 landing US/JP use.
    outbounds.append(socks("sg-socks", os.environ["SG_TOKEN"],
                           os.environ.get("SG_SOCKS_HOST", "fireside.bringyour.com"),
                           int(os.environ.get("SG_SOCKS_PORT", "7141"))))
    rules.append({"type": "field", "user": ["c-sg"], "outboundTag": "sg-socks"})
else:
    print("SG route not configured (UUID_C/SG_TOKEN unset); rendering US/JP only",
          file=sys.stderr)

rules.append({"type": "field", "network": "tcp,udp", "outboundTag": "block"})

cfg = {
  "log": {"loglevel": "warning"},
  "inbounds": [{
    "tag": "vless-ws", "listen": "127.0.0.1", "port": 18080,
    "protocol": "vless",
    "settings": {"clients": clients, "decryption": "none"},
    "streamSettings": {"network": "ws",
      "wsSettings": {"path": os.environ["WS_PATH"]}},
    "sniffing": {"enabled": True, "destOverride": ["http", "tls", "quic"]}
  }],
  "outbounds": outbounds,
  "routing": {"domainStrategy": "AsIs", "rules": rules}
}
with open("/app/config.json", "w") as f:
    json.dump(cfg, f)
os.chmod("/app/config.json", 0o600)
print("xray config rendered")
