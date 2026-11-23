#!/usr/bin/env python3
"""Outbound probe: for each route, TCP-connect to the SOCKS landing,
negotiate username auth with the route token, CONNECT to ip.sb:80 and
read back the exit IP. Serves JSON on 127.0.0.1:18081. Tokens come from
env and are never printed or included in responses."""
import json, os, socket, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = os.environ.get("SOCKS_HOST", "65.49.70.92")
PORT = int(os.environ.get("SOCKS_PORT", "7171"))
_cache = {"ts": 0, "data": None}
_lock = threading.Lock()

def check(token):
    out = {"tcp": False, "auth": False, "exit_ip": None, "error": None}
    try:
        s = socket.create_connection((HOST, PORT), timeout=10)
        out["tcp"] = True
        s.sendall(b"\x05\x01\x02")
        r = s.recv(2)
        if len(r) != 2 or r[0] != 5:
            out["error"] = "bad greeting reply"; s.close(); return out
        if r[1] == 0x02:
            u = token.encode(); p = b""
            s.sendall(b"\x01" + bytes([len(u)]) + u + bytes([len(p)]) + p)
            a = s.recv(2)
            if len(a) != 2 or a[1] != 0:
                out["error"] = "auth rejected"; s.close(); return out
            out["auth"] = True
        elif r[1] == 0x00:
            out["auth"] = True
        else:
            out["error"] = "no acceptable method"; s.close(); return out
        host = b"ip.sb"
        s.sendall(b"\x05\x01\x00\x03" + bytes([len(host)]) + host + (80).to_bytes(2, "big"))
        rep = s.recv(4)
        if len(rep) != 4 or rep[1] != 0:
            out["error"] = "connect failed"; s.close(); return out
        atyp = rep[3]
        if atyp == 1: s.recv(6)
        elif atyp == 3: s.recv(s.recv(1)[0] + 2)
        elif atyp == 4: s.recv(18)
        s.sendall(b"GET / HTTP/1.0\r\nHost: ip.sb\r\n\r\n")
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = s.recv(4096)
            if not chunk: break
            buf += chunk
        body = buf.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in buf else b""
        while len(body) < 64:
            chunk = s.recv(4096)
            if not chunk: break
            body += chunk
        out["exit_ip"] = body.decode("utf-8", "replace").strip()[:64] or None
        s.close()
    except Exception as e:
        out["error"] = type(e).__name__ + ": " + str(e)[:120]
    return out

def run_all():
    return {"us": check(os.environ.get("US_TOKEN", "")),
            "jp": check(os.environ.get("JP_TOKEN", ""))}

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        with _lock:
            if time.time() - _cache["ts"] > 60 or _cache["data"] is None:
                _cache["data"] = run_all(); _cache["ts"] = time.time()
            data = _cache["data"]
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass

HTTPServer(("127.0.0.1", 18081), H).serve_forever()
