// 精简版 VLESS + WebSocket Worker（替代 edgetunnel 整合包）
//
// 路由行为：
//   GET /              → 200 纯文本健康页，证明 Worker 活着
//   <PATH_US> + WS升级 → VLESS 代理，出站经 SOCKS5 落地（用户名 = US_TOKEN，密码空）
//   <PATH_JP> + WS升级 → VLESS 代理，出站经 SOCKS5 落地（用户名 = JP_TOKEN，密码空）
//   其余一切           → 404
//
// 配置全部走环境变量，源码里不写死任何凭据：
//   明文变量：UUID、PATH_US、PATH_JP、SOCKS_HOST、SOCKS_PORT
//   Secret ：US_TOKEN、JP_TOKEN
// UUID 在 VLESS 首包里校验，不符立即断开。

import { connect } from "cloudflare:sockets";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      if (request.method !== "GET") return notFound();
      return new Response("ok\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // 路径命中才选线；没配对应令牌时按不存在处理，不泄露路径是否存在
    let socksUser = null;
    if (env.PATH_US && pathname === env.PATH_US) socksUser = env.US_TOKEN;
    else if (env.PATH_JP && pathname === env.PATH_JP) socksUser = env.JP_TOKEN;
    if (!socksUser) return notFound();

    if (request.headers.get("Upgrade") !== "websocket") return notFound();

    return acceptVless(request, env, socksUser);
  },
};

function notFound() {
  return new Response("not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------------------------------------------------------------- WebSocket 入口

function acceptVless(request, env, socksUser) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  const session = new VlessSession(server, env, socksUser);

  // VLESS 客户端可把首包放在 Sec-WebSocket-Protocol 头里（early data）
  const earlyData = request.headers.get("sec-websocket-protocol");
  if (earlyData) {
    try {
      session.feed(base64UrlDecode(earlyData));
    } catch {
      server.close(1008, "bad early data");
    }
  }

  server.addEventListener("message", (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      session.feed(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      session.feed(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      server.close(1003, "binary only");
    }
  });
  server.addEventListener("close", () => session.close());
  server.addEventListener("error", () => session.close());

  const headers = {};
  if (earlyData) headers["Sec-WebSocket-Protocol"] = earlyData;
  return new Response(null, { status: 101, webSocket: client, headers });
}

// ---------------------------------------------------------------- 会话

class VlessSession {
  constructor(ws, env, socksUser) {
    this.ws = ws;
    this.env = env;
    this.socksUser = socksUser;
    this.version = 0;
    this.closed = false;
    this.connecting = false;
    this.headChunks = []; // VLESS 头未解析完时缓存
    this.headLength = 0;
    this.pending = []; // SOCKS 连接建立前到达的负载，先排队
    this.remote = null; // { socket, writer, reader }
  }

  feed(chunk) {
    if (this.closed || chunk.length === 0) return;
    if (this.remote) {
      this.writeRemote(chunk);
      return;
    }
    if (this.connecting) {
      this.pending.push(chunk);
      return;
    }

    this.headChunks.push(chunk);
    this.headLength += chunk.length;
    if (this.headLength > 8192) return this.close();

    let header;
    try {
      header = parseVlessHeader(concatBytes(this.headChunks), this.env.UUID);
    } catch {
      return this.close(); // UUID 不符或协议错误，直接拒绝
    }
    if (!header) return; // 头还没收全，继续等下一包

    this.headChunks = [];
    this.version = header.version;
    this.connecting = true;
    if (header.payload.length) this.pending.push(header.payload);
    this.openRemote(header).catch(() => this.close());
  }

  async openRemote(header) {
    const remote = await socks5Connect({
      host: this.env.SOCKS_HOST,
      port: Number(this.env.SOCKS_PORT),
      username: this.socksUser,
      target: header,
    });
    if (this.closed) {
      try { remote.socket.close(); } catch { /* ignore */ }
      return;
    }
    this.remote = remote;
    const queued = this.pending;
    this.pending = [];
    for (const chunk of queued) this.writeRemote(chunk);
    this.pumpRemote();
  }

  writeRemote(chunk) {
    this.remote.writer.write(chunk).catch(() => this.close());
  }

  // 远端 → 客户端：首个数据块前要拼 VLESS 响应头 [version, 0]
  async pumpRemote() {
    let sentHead = false;
    try {
      for (;;) {
        const chunk = await this.remote.reader.readSome();
        if (chunk === null) break;
        if (!sentHead) {
          sentHead = true;
          this.ws.send(concatBytes([new Uint8Array([this.version, 0]), chunk]));
        } else {
          this.ws.send(chunk);
        }
      }
    } catch { /* 连接异常按关闭处理 */ }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
    if (this.remote) {
      try { this.remote.reader.cancel(); } catch { /* ignore */ }
      try { this.remote.writer.abort(); } catch { /* ignore */ }
      try { this.remote.socket.close(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------- VLESS 头解析
// 结构：version(1) | uuid(16) | optLen(1) | opt(optLen) | cmd(1，仅支持 1=TCP)
//       | port(2, 大端) | atyp(1) | addr | payload...
// atyp：1=IPv4(4字节) 2=域名(1字节长度+内容) 3=IPv6(16字节)
// 数据不完整返回 null；协议错误或 UUID 不符抛错。

function parseVlessHeader(buf, uuidText) {
  if (!uuidText) throw new Error("UUID not configured");
  if (buf.length < 18) return null;

  const version = buf[0];
  const uuidHex = bytesToHex(buf.subarray(1, 17));
  if (uuidHex !== uuidText.replaceAll("-", "").toLowerCase()) {
    throw new Error("uuid mismatch");
  }

  let offset = 17;
  const optLen = buf[offset];
  offset += 1 + optLen;
  if (buf.length < offset + 4) return null;

  const command = buf[offset];
  offset += 1;
  if (command !== 1) throw new Error("only TCP supported");

  const port = (buf[offset] << 8) | buf[offset + 1];
  offset += 2;

  const atyp = buf[offset];
  offset += 1;

  let hostBytes = null;
  let domain = null;
  if (atyp === 1) {
    if (buf.length < offset + 4) return null;
    hostBytes = buf.slice(offset, offset + 4);
    offset += 4;
  } else if (atyp === 2) {
    if (buf.length < offset + 1) return null;
    const len = buf[offset];
    offset += 1;
    if (buf.length < offset + len) return null;
    domain = new TextDecoder().decode(buf.subarray(offset, offset + len));
    offset += len;
  } else if (atyp === 3) {
    if (buf.length < offset + 16) return null;
    hostBytes = buf.slice(offset, offset + 16);
    offset += 16;
  } else {
    throw new Error("bad address type");
  }

  return { version, port, atyp, hostBytes, domain, payload: buf.slice(offset) };
}

// ---------------------------------------------------------------- SOCKS5 出站
// 握手：只提供用户名/密码认证(0x02)，密码为空（落地按用户名分线）。
// 目标地址原样交给落地解析（域名不经本地 DNS）。

async function socks5Connect({ host, port, username, target }) {
  const socket = connect({ hostname: host, port });
  const writer = socket.writable.getWriter();
  const reader = new StreamReader(socket.readable.getReader());

  try {
    await writer.write(new Uint8Array([0x05, 0x01, 0x02]));
    const greet = await reader.readExact(2);
    if (greet[0] !== 0x05 || greet[1] !== 0x02) {
      throw new Error("socks5: username auth not accepted");
    }

    const userBytes = new TextEncoder().encode(username);
    const auth = new Uint8Array(2 + userBytes.length + 1);
    auth[0] = 0x01; // 子协商版本
    auth[1] = userBytes.length;
    auth.set(userBytes, 2);
    auth[auth.length - 1] = 0x00; // 密码长度 0
    await writer.write(auth);
    const authResp = await reader.readExact(2);
    if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
      throw new Error("socks5: auth failed");
    }

    await writer.write(buildSocksRequest(target));
    const head = await reader.readExact(4);
    if (head[0] !== 0x05 || head[1] !== 0x00) {
      throw new Error("socks5: connect rejected");
    }
    // 吃掉应答里的绑定地址+端口，剩余字节就是远端数据
    const bindAtyp = head[3];
    if (bindAtyp === 0x01) await reader.readExact(4 + 2);
    else if (bindAtyp === 0x04) await reader.readExact(16 + 2);
    else if (bindAtyp === 0x03) {
      const len = (await reader.readExact(1))[0];
      await reader.readExact(len + 2);
    } else {
      throw new Error("socks5: bad reply");
    }

    return { socket, writer, reader };
  } catch (err) {
    try { socket.close(); } catch { /* ignore */ }
    throw err;
  }
}

function buildSocksRequest(target) {
  let addr;
  if (target.atyp === 1) {
    addr = [0x01, ...target.hostBytes];
  } else if (target.atyp === 3) {
    addr = [0x04, ...target.hostBytes];
  } else {
    const d = new TextEncoder().encode(target.domain);
    addr = [0x03, d.length, ...d];
  }
  return new Uint8Array([
    0x05, 0x01, 0x00,
    ...addr,
    (target.port >> 8) & 0xff,
    target.port & 0xff,
  ]);
}

// ---------------------------------------------------------------- 小工具

// 给流式 reader 加缓冲：readExact 精确读 n 字节；readSome 返回手头任意一块
// （握手阶段多读到的远端数据不会丢，会在 readSome 里先吐出来）。
class StreamReader {
  constructor(reader) {
    this.reader = reader;
    this.buf = new Uint8Array(0);
  }

  async fill() {
    const { value, done } = await this.reader.read();
    if (done) return false;
    this.buf = concatBytes([this.buf, value]);
    return true;
  }

  async readExact(n) {
    while (this.buf.length < n) {
      if (!(await this.fill())) throw new Error("stream ended early");
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }

  async readSome() {
    if (this.buf.length) {
      const out = this.buf;
      this.buf = new Uint8Array(0);
      return out;
    }
    const { value, done } = await this.reader.read();
    return done ? null : value;
  }

  cancel() {
    return this.reader.cancel();
  }
}

function concatBytes(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function bytesToHex(bytes) {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function base64UrlDecode(text) {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
