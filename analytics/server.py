#!/usr/bin/env python3
"""羊毛情报站匿名访问统计：标准库实现，无第三方依赖。

对外两个接口（由 nginx 反代到 127.0.0.1:8011）：
  POST /api/metrics/hit      前端 beacon 上报一次访问（匿名 visitor_id）
  GET  /api/metrics/summary  按「工具中台看板」指标契约输出聚合数据

环境变量：
  WOOL_METRICS_DB     SQLite 路径，默认 /opt/wool-analytics/var/metrics.db
  WOOL_METRICS_TOKEN  summary 接口令牌，留空则不校验
  WOOL_METRICS_PORT   监听端口，默认 8011
"""
import collections
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

DB_PATH = os.getenv("WOOL_METRICS_DB", "/opt/wool-analytics/var/metrics.db")
TOKEN = os.getenv("WOOL_METRICS_TOKEN", "")
PORT = int(os.getenv("WOOL_METRICS_PORT", "8011"))
TZ = timezone(timedelta(hours=8))

VID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_BODY = 2048
RATE_LIMIT = 120          # 单 IP 每分钟最多上报次数
RETENTION_DAYS = 400      # 明细保留天数

_lock = threading.Lock()
_rate = {}
_last_prune_day = ""


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = connect()
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS events("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " day TEXT NOT NULL, ts TEXT NOT NULL, vid TEXT NOT NULL,"
            " event TEXT NOT NULL, path TEXT, ref TEXT, ip TEXT, ua TEXT)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_day_event ON events(day, event)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_vid ON events(vid)")
        conn.commit()
    finally:
        conn.close()


def rate_ok(ip):
    now = time.time()
    with _lock:
        if len(_rate) > 5000:
            for key in [k for k, v in _rate.items() if not v or now - v[-1] > 120]:
                _rate.pop(key, None)
        hits = [t for t in _rate.get(ip, []) if now - t < 60]
        hits.append(now)
        _rate[ip] = hits
        return len(hits) <= RATE_LIMIT


def record(vid, path, ref, ip, ua):
    now = datetime.now(TZ)
    day = now.date().isoformat()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO events(day, ts, vid, event, path, ref, ip, ua)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (day, now.isoformat(timespec="seconds"), vid, "visit",
             path[:300], ref[:300], ip[:64], ua[:300]))
        conn.commit()
    finally:
        conn.close()
    prune(day)


def prune(today):
    global _last_prune_day
    if _last_prune_day == today:
        return
    _last_prune_day = today
    cutoff = (datetime.now(TZ).date() - timedelta(days=RETENTION_DAYS)).isoformat()
    conn = connect()
    try:
        conn.execute("DELETE FROM events WHERE day < ?", (cutoff,))
        conn.commit()
    finally:
        conn.close()


def summary(days):
    days = max(1, min(90, int(days)))
    today = datetime.now(TZ).date()
    start = today - timedelta(days=days - 1)
    start_s = start.isoformat()

    daily = collections.OrderedDict()
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        daily[d] = {"date": d, "uv": 0, "visits": 0, "uploads": 0, "generations": 0,
                    "downloads": 0, "designerOpens": 0, "leads": 0, "projects": 0}

    conn = connect()
    try:
        rows = conn.execute(
            "SELECT day, COUNT(*), COUNT(DISTINCT vid) FROM events"
            " WHERE event = 'visit' AND day >= ? GROUP BY day", (start_s,)).fetchall()
        for day, visits, uv in rows:
            if day in daily:
                daily[day]["visits"] = int(visits)
                daily[day]["uv"] = int(uv)
        total_uv = conn.execute(
            "SELECT COUNT(DISTINCT vid) FROM events"
            " WHERE event = 'visit' AND day >= ?", (start_s,)).fetchone()[0] or 0
    finally:
        conn.close()

    totals = {"uv": int(total_uv),
              "visits": sum(d["visits"] for d in daily.values())}
    for key in ("uploads", "generations", "downloads", "designerOpens", "leads", "projects"):
        totals[key] = 0
    return {"days": days, "totals": totals, "daily": list(daily.values())}


class Handler(BaseHTTPRequestHandler):
    server_version = "wool-analytics"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, payload, headers=None):
        if code == 204:
            self.send_response(204)
            self.send_header("Cache-Control", "no-store")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            return
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _client_ip(self):
        real = self.headers.get("X-Real-IP") or ""
        fwd = (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        return (real or fwd or self.client_address[0])[:64]

    def do_POST(self):
        if urlparse(self.path).path != "/api/metrics/hit":
            return self._send(404, {"detail": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return self._send(400, {"detail": "bad body"})
        raw = self.rfile.read(length)
        ip = self._client_ip()
        if not rate_ok(ip):
            return self._send(429, {"detail": "too many requests"})
        try:
            data = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            return self._send(400, {"detail": "bad json"})
        vid = str(data.get("vid") or "")
        if not VID_RE.match(vid):
            return self._send(400, {"detail": "bad vid"})
        record(vid, str(data.get("path") or "")[:300], str(data.get("ref") or "")[:300],
               ip, self.headers.get("User-Agent") or "")
        return self._send(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self._send(200, {"ok": True})
        if parsed.path != "/api/metrics/summary":
            return self._send(404, {"detail": "not found"})
        if TOKEN and self.headers.get("X-Metrics-Token") != TOKEN:
            return self._send(401, {"detail": "metrics token 无效"})
        try:
            days = int(parse_qs(parsed.query).get("days", ["7"])[0])
        except ValueError:
            days = 7
        return self._send(200, summary(days))


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def main():
    init_db()
    srv = Server(("127.0.0.1", PORT), Handler)
    print("wool-analytics listening on 127.0.0.1:%d db=%s" % (PORT, DB_PATH))
    srv.serve_forever()


if __name__ == "__main__":
    main()
