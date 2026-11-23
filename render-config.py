#!/usr/bin/env python3
"""Render the Xray config from environment variables at container start.
Required env: UUID_A, UUID_B, WS_PATH, US_TOKEN, JP_TOKEN. Values are
written only into /app/config.json (chmod 600) and never printed."""
import json, os, sys

required = ["UUID_A", "UUID_B", "WS_PATH", "US_TOKEN", "JP_TOKEN"]
missing = [k for k in required if not os.environ.get(k)]
if missing:
    print("missing env vars:", ",".join(missing), file=sys.stderr)
    sys.exit(1)

def socks(tag, token):
    return {"tag": tag, "protocol": "socks",
            "settings": {"servers": [{"address": "65.49.70.92", "port": 7171,
                        "users": [{"user": token, "pass": ""}]}]}}

cfg = {
  "log": {"loglevel": "warning"},
  "inbounds": [{
    "tag": "vless-ws", "listen": "127.0.0.1", "port": 18080,
    "protocol": "vless",
    "settings": {"clients": [
        {"id": os.environ["UUID_A"], "email": "a-us"},
        {"id": os.environ["UUID_B"], "email": "b-jp"}],
      "decryption": "none"},
    "streamSettings": {"network": "ws",
      "wsSettings": {"path": os.environ["WS_PATH"]}},
    "sniffing": {"enabled": True, "destOverride": ["http", "tls", "quic"]}
  }],
  "outbounds": [
    {"tag": "block", "protocol": "blackhole"},
    socks("us-socks", os.environ["US_TOKEN"]),
    socks("jp-socks", os.environ["JP_TOKEN"])
  ],
  "routing": {"domainStrategy": "AsIs", "rules": [
    {"type": "field", "user": ["a-us"], "outboundTag": "us-socks"},
    {"type": "field", "user": ["b-jp"], "outboundTag": "jp-socks"},
    {"type": "field", "network": "tcp,udp", "outboundTag": "block"}
  ]}
}
with open("/app/config.json", "w") as f:
    json.dump(cfg, f)
os.chmod("/app/config.json", 0o600)
print("xray config rendered")
