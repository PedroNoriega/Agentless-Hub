import os
import time
import json
import asyncio
import datetime as dt
from dataclasses import dataclass
from typing import Optional, Dict, Any, List

import yaml
import paramiko
import winrm
from tenacity import retry, stop_after_attempt, wait_fixed

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

# ---------------------------
# Configuration models
# ---------------------------

@dataclass
class SSHConfig:
    username: str
    password: Optional[str] = None
    private_key: Optional[str] = None
    port: int = 22

@dataclass
class WinRMConfig:
    username: str
    password: str
    scheme: str = "http"
    port: int = 5985
    verify_ssl: bool = False

@dataclass
class Host:
    name: str
    ip: str
    os: str   # "linux" | "windows"
    ssh: Optional[SSHConfig] = None
    winrm: Optional[WinRMConfig] = None

# ---------------------------
# Linux polling script (agentless)
# Produces a single JSON payload with metrics + "extras"
# ---------------------------
LINUX_SHELL = r"""
set -e

# CPU snapshot 1
read cpu user1 nice1 sys1 idle1 iowait1 irq1 softirq1 steal1 guest1 < /proc/stat
TOTAL1=$((user1+nice1+sys1+idle1+iowait1+irq1+softirq1+steal1))
IDLE1=$idle1

# NET snapshot 1
NET1=$(awk 'NR>2 {gsub(":","",$1); if($1!="lo"){print $1"|"$2"|"$10}}' /proc/net/dev)

# Short wait for deltas
sleep 0.5

# CPU snapshot 2
read cpu user2 nice2 sys2 idle2 iowait2 irq2 softirq2 steal2 guest2 < /proc/stat
TOTAL2=$((user2+nice2+sys2+idle2+iowait2+irq2+softirq2+steal2))
IDLE2=$idle2
DT=$((TOTAL2-TOTAL1))
DIDLE=$((IDLE2-IDLE1))
CPU_PCT=$(awk -v dt=$DT -v didle=$DIDLE 'BEGIN { v=(dt>0? (100*(dt-didle)/dt):0); if(v<0)v=0; if(v>100)v=100; printf "%.2f", v }')

# Mode percentages
USERD=$((user2-user1)); NICED=$((nice2-nice1)); SYSD=$((sys2-sys1)); IDLED=$((idle2-idle1))
IOWD=$((iowait2-iowait1)); IRQD=$((irq2-irq1)); SOFTD=$((softirq2-softirq1)); STEALD=$((steal2-steal1))
CPUTOT=$((USERD+NICED+SYSD+IDLED+IOWD+IRQD+SOFTD+STEALD))
pct(){ awk -v n=$1 -v t=$2 'BEGIN{ if(t>0) printf "%.2f", (n*100.0)/t; else print "0.00"}'; }
CPU_USER=$(pct $((USERD+NICED)) $CPUTOT)
CPU_SYS=$(pct $SYSD $CPUTOT)
CPU_IDLE=$(pct $IDLED $CPUTOT)
CPU_IOWAIT=$(pct $IOWD $CPUTOT)

# NET snapshot 2 + rates
NET2=$(awk 'NR>2 {gsub(":","",$1); if($1!="lo"){print $1"|"$2"|"$10}}' /proc/net/dev)
RX_SUM=0; TX_SUM=0; IF_JSON=""
while read -r line1; do
  IFACE=$(echo "$line1" | awk -F'|' '{print $1}')
  RX1=$(echo "$line1" | awk -F'|' '{print $2}')
  TX1=$(echo "$line1" | awk -F'|' '{print $3}')
  line2=$(echo "$NET2" | awk -v i="$IFACE" -F'|' '$1==i {print $0}')
  if [ -n "$line2" ]; then
    RX2=$(echo "$line2" | awk -F'|' '{print $2}')
    TX2=$(echo "$line2" | awk -F'|' '{print $3}')
    DRX=$((RX2-RX1)); DTX=$((TX2-TX1))
    RX_KBPS=$(awk -v b=$DRX 'BEGIN{ printf "%.2f", (b/1024.0)/0.5 }')
    TX_KBPS=$(awk -v b=$DTX 'BEGIN{ printf "%.2f", (b/1024.0)/0.5 }')
    RX_SUM=$(awk -v a=$RX_SUM -v b=$RX_KBPS 'BEGIN{ printf "%.2f", a+b }')
    TX_SUM=$(awk -v a=$TX_SUM -v b=$TX_KBPS 'BEGIN{ printf "%.2f", a+b }')
    IF_JSON="${IF_JSON}{\"iface\":\"$IFACE\",\"rx_kbps\":$RX_KBPS,\"tx_kbps\":$TX_KBPS},"
  fi
done <<< "$NET1"
IF_JSON="[${IF_JSON%,}]"

# Memory / swap / load
MEM_TOTAL=$(awk '/MemTotal/ {print $2*1024}' /proc/meminfo)
MEM_AVAIL=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo)
MEM_FREE=$(awk '/MemFree/ {print $2*1024}' /proc/meminfo)
BUFFERS=$(awk '/Buffers/ {print $2*1024}' /proc/meminfo)
CACHED=$(awk '/^Cached:/ {print $2*1024}' /proc/meminfo)
SWAP_TOTAL=$(awk '/SwapTotal/ {print $2*1024}' /proc/meminfo)
SWAP_FREE=$(awk '/SwapFree/ {print $2*1024}' /proc/meminfo)
SWAP_USED=$((SWAP_TOTAL-SWAP_FREE))
SWAP_PCT=$(awk -v u=$SWAP_USED -v t=$SWAP_TOTAL 'BEGIN{ if(t>0) printf "%.2f", (100*u)/t; else print "0.00"}')
read LOAD1 LOAD5 LOAD15 _ < /proc/loadavg

# Uptime
UPTIME=$(awk '{print int($1)}' /proc/uptime)

# Disks
DF=$(df -P -B1 | awk 'NR>1 {print $1"|"$2"|"$4"|"$5"|"$6}' | sed 's/%//g')
DISKS=""
while IFS='|' read -r dev size avail usedp mount; do
  case "$dev" in tmpfs*|overlay*) continue ;; esac
  DISKS="${DISKS}{\"device\":\"$dev\",\"size_bytes\":$size,\"free_bytes\":$avail,\"used_percent\":$usedp,\"mount\":\"$mount\"},"
done <<< "$DF"
DISKS_JSON="[${DISKS%,}]"

# Inodes
INODES_RAW=$(df -Pi | awk 'NR>1 {print $6"|"$5}' | sed 's/%//g')
INODES=""
while IFS='|' read -r mount iusedp; do
  INODES="${INODES}{\"mount\":\"$mount\",\"iused_percent\":$iusedp},"
done <<< "$INODES_RAW"
INODES_JSON="[${INODES%,}]"

# Processes (top by CPU)
PROCS_TOTAL=$(ps -e --no-headers | wc -l)
TOPP=$(ps -eo pid,comm,pcpu,pmem --sort=-pcpu --no-headers | head -n 5)
TOP_JSON=""
while read -r pid comm pc pm; do
  [ -z "$pid" ] && continue
  TOP_JSON="${TOP_JSON}{\"pid\":$pid,\"cmd\":\"$comm\",\"cpu\":$pc,\"mem\":$pm},"
done <<< "$TOPP"
TOP_JSON="[${TOP_JSON%,}]"

# System info
HOSTNAME=$(hostname)
OS_NAME=$( (source /etc/os-release && echo "$NAME") 2>/dev/null || echo "Linux")
OS_VER=$( (source /etc/os-release && echo "$VERSION") 2>/dev/null || echo "")
KERNEL=$(uname -r)
ARCH=$(uname -m)
CORES=$(nproc)

# Emit JSON
cat <<EOF
{
  "hostname": "$HOSTNAME",
  "uptime_seconds": $UPTIME,
  "cpu_percent": $CPU_PCT,
  "mem_total_bytes": $MEM_TOTAL,
  "mem_available_bytes": $MEM_AVAIL,
  "os": "$OS_NAME",
  "disks": $DISKS_JSON,
  "extras": {
    "cpu_detail": { "user_pct": $CPU_USER, "sys_pct": $CPU_SYS, "idle_pct": $CPU_IDLE, "iowait_pct": $CPU_IOWAIT },
    "mem_detail": { "total_bytes": $MEM_TOTAL, "available_bytes": $MEM_AVAIL, "free_bytes": $MEM_FREE, "buffers_bytes": $BUFFERS, "cached_bytes": $CACHED },
    "swap": { "total_bytes": $SWAP_TOTAL, "used_bytes": $SWAP_USED, "used_pct": $SWAP_PCT },
    "load_avg": { "l1": $LOAD1, "l5": $LOAD5, "l15": $LOAD15 },
    "net": { "total_rx_kbps": $RX_SUM, "total_tx_kbps": $TX_SUM, "interfaces": $IF_JSON },
    "inodes": $INODES_JSON,
    "processes": { "total": $PROCS_TOTAL, "top_cpu": $TOP_JSON },
    "system": { "hostname": "$HOSTNAME", "os": "$OS_NAME", "os_version": "$OS_VER", "kernel": "$KERNEL", "arch": "$ARCH", "cores": $CORES }
  }
}
EOF
"""

# ---------------------------
# Connectors
# ---------------------------

class SSHClient:
  def __init__(self, ip: str, cfg: SSHConfig):
    self.ip = ip
    self.cfg = cfg

  @retry(stop=stop_after_attempt(2), wait=wait_fixed(1))
  def run(self, cmd: str) -> str:
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
      if self.cfg.private_key:
        key = paramiko.RSAKey.from_private_key_file(self.cfg.private_key)
        cli.connect(self.ip, port=self.cfg.port, username=self.cfg.username,
                    pkey=key, timeout=8, look_for_keys=False, allow_agent=False)
      else:
        cli.connect(self.ip, port=self.cfg.port, username=self.cfg.username,
                    password=self.cfg.password, timeout=8, look_for_keys=False, allow_agent=False)
      _, stdout, stderr = cli.exec_command(cmd, timeout=20)
      out = stdout.read().decode("utf-8", errors="ignore")
      err = stderr.read().decode("utf-8", errors="ignore")
      if err and not out:
        raise RuntimeError(err)
      return out
    finally:
      cli.close()

class WinRMClient:
  def __init__(self, ip: str, cfg: WinRMConfig):
    endpoint = f"{cfg.scheme}://{ip}:{cfg.port}/wsman"
    self.session = winrm.Session(endpoint, auth=(cfg.username, cfg.password),
                                 server_cert_validation='validate' if cfg.verify_ssl else 'ignore')

  @retry(stop=stop_after_attempt(2), wait=wait_fixed(1))
  def run_ps(self, script: str) -> str:
    r = self.session.run_ps(script)
    if r.status_code != 0:
      raise RuntimeError(r.std_err.decode("utf-8", errors="ignore"))
    return r.std_out.decode("utf-8", errors="ignore")

# ---------------------------
# SQLite helpers + migrations
# ---------------------------

def get_engine() -> Engine:
  os.makedirs("/app/data", exist_ok=True)
  return create_engine("sqlite:////app/data/metrics.db", future=True)

def init_db(engine: Engine):
  with engine.begin() as cx:
    cx.exec_driver_sql("""
      CREATE TABLE IF NOT EXISTS hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        ip TEXT,
        os TEXT
      );
    """)
    cx.exec_driver_sql("""
      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER,
        ts INTEGER,
        cpu REAL,
        mem_total INTEGER,
        mem_avail INTEGER,
        uptime INTEGER,
        latency_ms REAL,
        net_rx_kbps REAL,
        net_tx_kbps REAL,
        FOREIGN KEY(host_id) REFERENCES hosts(id)
      );
    """)
    cx.exec_driver_sql("""
      CREATE TABLE IF NOT EXISTS disks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER,
        ts INTEGER,
        device TEXT,
        used_percent REAL,
        size_bytes INTEGER,
        free_bytes INTEGER,
        mount TEXT,
        FOREIGN KEY(host_id) REFERENCES hosts(id)
      );
    """)
    cx.exec_driver_sql("""
      CREATE TABLE IF NOT EXISTS extras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id INTEGER,
        ts INTEGER,
        payload TEXT,
        FOREIGN KEY(host_id) REFERENCES hosts(id)
      );
    """)
    cx.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_samples_host_ts ON samples(host_id, ts);")
    cx.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_disks_host_ts ON disks(host_id, ts);")
    cx.exec_driver_sql("CREATE INDEX IF NOT EXISTS idx_extras_host_ts ON extras(host_id, ts);")

# ---------------------------
# TCP latency helper
# ---------------------------

import socket
def tcp_ping(ip: str, port: int, timeout=2.0) -> Optional[float]:
  t0 = time.perf_counter()
  try:
    s = socket.create_connection((ip, port), timeout=timeout)
    s.close()
    return (time.perf_counter() - t0) * 1000.0
  except Exception:
    return None

# ---------------------------
# Config loader
# ---------------------------

def load_config(path: str) -> Dict[str, Any]:
  with open(path, "r", encoding="utf-8") as f:
    return yaml.safe_load(f)

# ---------------------------
# Agentless poller
# ---------------------------

class AgentlessPoller:
  def __init__(self, config: Dict[str, Any], engine: Engine):
    self.interval = int(os.getenv("POLL_INTERVAL_SECONDS") or config.get("poll_interval_seconds", 30))
    self.engine = engine
    self.hosts: List[Host] = []

    for h in config.get("hosts", []):
      ssh = None
      wcfg = None
      if h.get("os") == "linux" and "ssh" in h:
        s = h["ssh"]
        ssh = SSHConfig(username=s.get("username"), password=s.get("password"),
                        private_key=s.get("private_key"), port=s.get("port", 22))
      if h.get("os") == "windows" and "winrm" in h:
        w = h["winrm"]
        wcfg = WinRMConfig(username=w.get("username"), password=w.get("password"),
                           scheme=w.get("scheme", "http"), port=w.get("port", 5985),
                           verify_ssl=bool(w.get("verify_ssl", False)))
      self.hosts.append(Host(name=h["name"], ip=h["ip"], os=h["os"], ssh=ssh, winrm=wcfg))

    with self.engine.begin() as cx:
      for h in self.hosts:
        cx.exec_driver_sql("INSERT OR IGNORE INTO hosts(name, ip, os) VALUES (:n, :i, :o)",
                           {"n": h.name, "i": h.ip, "o": h.os})

  async def run_forever(self):
    while True:
      await asyncio.gather(*(self.poll_once(h) for h in self.hosts))
      await asyncio.sleep(self.interval)

  async def poll_once(self, host: Host):
    ts = int(time.time())
    cpu = mem_total = mem_avail = uptime = None
    net_rx = net_tx = None
    disks = []
    extras_payload = None
    latency = tcp_ping(host.ip, 22 if host.os == "linux" else 3389, timeout=2.0)

    try:
      if host.os == "linux" and host.ssh:
        cli = SSHClient(host.ip, host.ssh)
        raw = cli.run(LINUX_SHELL)
        data = json.loads(raw)

        cpu = float(data.get("cpu_percent", 0))
        mem_total = int(data.get("mem_total_bytes", 0))
        mem_avail = int(data.get("mem_available_bytes", 0))
        uptime = int(data.get("uptime_seconds", 0))
        disks = data.get("disks", [])

        extras = data.get("extras", {})
        net = extras.get("net", {})
        net_rx = float(net.get("total_rx_kbps", 0)) if net else None
        net_tx = float(net.get("total_tx_kbps", 0)) if net else None
        extras_payload = json.dumps(extras)

      elif host.os == "windows" and host.winrm:
        # Windows support can be added here similarly (WinRM PowerShell script)
        return

    except Exception as e:
      # Make errors visible in docker logs
      print(f"[poll] ERROR {host.name} ({host.ip}): {e}", flush=True)

    with self.engine.begin() as cx:
      hid = cx.execute(text("SELECT id FROM hosts WHERE name=:n"), {"n": host.name}).scalar_one()
      cx.execute(text("""
        INSERT INTO samples(host_id, ts, cpu, mem_total, mem_avail, uptime, latency_ms, net_rx_kbps, net_tx_kbps)
        VALUES (:hid, :ts, :cpu, :mt, :ma, :up, :lat, :rx, :tx)
      """), {"hid": hid, "ts": ts, "cpu": cpu, "mt": mem_total, "ma": mem_avail, "up": uptime,
             "lat": latency, "rx": net_rx, "tx": net_tx})

      if disks:
        for d in disks:
          cx.execute(text("""
            INSERT INTO disks(host_id, ts, device, used_percent, size_bytes, free_bytes, mount)
            VALUES (:hid, :ts, :dev, :upct, :sz, :free, :mnt)
          """), {"hid": hid, "ts": ts, "dev": str(d.get("device")),
                 "upct": float(d.get("used_percent", 0)),
                 "sz": int(d.get("size_bytes", 0)), "free": int(d.get("free_bytes", 0)),
                 "mnt": str(d.get("mount", ""))})

      if extras_payload:
        cx.execute(text("INSERT INTO extras(host_id, ts, payload) VALUES (:hid, :ts, :p)"),
                   {"hid": hid, "ts": ts, "p": extras_payload})

# ---------------------------
# FastAPI application
# ---------------------------

app = FastAPI(title="Agentless Hub", version="1.2.0")
BASE_DIR = os.path.dirname(__file__)
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

CONFIG_PATH = os.getenv("CONFIG_PATH", "/app/config.yml")
ENGINE = get_engine()
init_db(ENGINE)
CFG = load_config(CONFIG_PATH)
POLLER = AgentlessPoller(CFG, ENGINE)

@app.on_event("startup")
async def _startup():
  asyncio.create_task(POLLER.run_forever())

# Pages
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
  with ENGINE.begin() as cx:
    rows = cx.execute(text("SELECT id, name, ip, os FROM hosts ORDER BY name")).mappings().all()
  return templates.TemplateResponse("index.html", {"request": request, "hosts": rows})

# API
@app.get("/api/hosts")
def api_hosts():
  with ENGINE.begin() as cx:
    rows = cx.execute(text("""
      SELECT h.id, h.name, h.ip, h.os,
             (SELECT s.ts FROM samples s WHERE s.host_id=h.id ORDER BY s.ts DESC LIMIT 1) AS last_ts
      FROM hosts h ORDER BY h.name
    """)).mappings().all()
  return rows

@app.get("/api/host/{host_id}/series")
def api_series(host_id: int, minutes: int = 120):
  t_from = int(time.time()) - minutes*60
  with ENGINE.begin() as cx:
    s = cx.execute(text("""
      SELECT ts, cpu, mem_total, mem_avail, uptime, latency_ms, net_rx_kbps, net_tx_kbps
      FROM samples WHERE host_id=:hid AND ts>=:t ORDER BY ts ASC
    """), {"hid": host_id, "t": t_from}).mappings().all()
    d = cx.execute(text("""
      SELECT ts, device, used_percent, size_bytes, free_bytes, mount
      FROM disks WHERE host_id=:hid AND ts>=:t ORDER BY ts ASC
    """), {"hid": host_id, "t": t_from}).mappings().all()
  return {"samples": s, "disks": d}

@app.get("/api/host/{host_id}/latest")
def api_latest(host_id: int):
  with ENGINE.begin() as cx:
    last = cx.execute(text("""
      SELECT ts, cpu, mem_total, mem_avail, uptime, latency_ms, net_rx_kbps, net_tx_kbps
      FROM samples WHERE host_id=:hid ORDER BY ts DESC LIMIT 1
    """), {"hid": host_id}).mappings().first()
    ex = cx.execute(text("""
      SELECT payload FROM extras WHERE host_id=:hid ORDER BY ts DESC LIMIT 1
    """), {"hid": host_id}).scalar_one_or_none()
    disks = cx.execute(text("""
      SELECT device, used_percent, size_bytes, free_bytes, mount
      FROM disks WHERE host_id=:hid AND ts=(SELECT MAX(ts) FROM disks WHERE host_id=:hid)
    """), {"hid": host_id}).mappings().all()
  extras = json.loads(ex) if ex else {}
  return {"last": last, "extras": extras, "disks": disks}

@app.get("/healthz")
def health():
  return {"ok": True, "time": dt.datetime.utcnow().isoformat() + "Z"}
