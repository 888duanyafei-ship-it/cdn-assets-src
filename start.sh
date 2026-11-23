#!/bin/sh
set -e
python3 /app/render-config.py
python3 /app/probe.py &
/usr/local/bin/xray run -config /app/config.json &
exec /usr/local/bin/caddy run --config /app/Caddyfile --adapter caddyfile
