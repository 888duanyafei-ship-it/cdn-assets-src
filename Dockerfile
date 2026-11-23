FROM alpine:3.20
RUN apk add --no-cache curl unzip tar python3 ca-certificates \
 && curl -sL -o /tmp/xray.zip https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip \
 && unzip -o /tmp/xray.zip xray -d /usr/local/bin/ && chmod +x /usr/local/bin/xray \
 && curl -sL -o /tmp/caddy.tar.gz https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz \
 && tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin/ caddy && chmod +x /usr/local/bin/caddy \
 && rm /tmp/xray.zip /tmp/caddy.tar.gz
WORKDIR /app
COPY render-config.py probe.py Caddyfile start.sh /app/
RUN chmod +x /app/start.sh
CMD ["/app/start.sh"]
